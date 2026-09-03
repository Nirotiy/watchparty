import type { Express, Request, Response } from "express";
import { PROTOCOL_VERSION, errorResult } from "../protocol.ts";
import type { CommandAck } from "../protocol.ts";
import type { Room, SharedCommand } from "../room/Room.ts";
import type { RoomRegistry } from "../room/registry.ts";
import type {
  ResolvedMpvMedia,
  WatchpartyMedia,
} from "../../media/watchparty-media.ts";
import { validateRevision, validateRoomId } from "../media.ts";
import { bearerToken, sendError } from "./shared.ts";

/**
 * HTTP endpoints for MPV side-branch clients (spec section 9). Every
 * /api/rooms/:roomId/mpv/* and /api/mpv/* route requires:
 * - `Authorization: Bearer <mpv accessToken>` (clientType=mpv; browser tokens get 403)
 * - `X-WatchParty-Protocol: <PROTOCOL_VERSION>` (missing/mismatch is a hard 426)
 * - `X-WatchParty-Client-Type: mpv`
 */
export function registerMpvHttp(
  app: Express,
  registry: RoomRegistry,
  media: WatchpartyMedia,
): void {
  // Browser asks for a one-time launch ticket (any browser member may issue).
  app.post("/api/rooms/:roomId/handoff", (req, res): void => {
    const roomId = String(req.params.roomId);
    if (!validateRoomId(roomId) || !registry.get(roomId)) {
      sendError(res, 404, "ROOM_NOT_FOUND");
      return;
    }
    const token = bearerToken(req);
    const ticket = token
      ? registry.issueHandoffTicket(roomId, token)
      : undefined;
    if (!ticket) {
      const browserToken = token
        ? registry.authenticateToken(roomId, token)
        : undefined;
      sendError(
        res,
        browserToken ? 403 : 401,
        browserToken ? "FORBIDDEN" : "ACCESS_TOKEN_INVALID",
      );
      return;
    }
    res.json({ ticket: ticket.ticket, ticketExpiresAt: ticket.expiresAt });
  });

  // MPV redeems the ticket: atomic, one-time, room-bound.
  app.post("/api/mpv/handoff", (req, res): void => {
    const ticket = req.body?.ticket;
    const redeemed = registry.redeemHandoffTicket(
      typeof ticket === "string" ? ticket : "",
    );
    if (!redeemed) {
      sendError(res, 401, "HANDOFF_TICKET_INVALID");
      return;
    }
    const room = registry.get(redeemed.roomId);
    if (!room) {
      sendError(res, 404, "ROOM_NOT_FOUND");
      return;
    }
    room.join(redeemed.clientId, redeemed.nickname);
    registry.touchMpvClient(redeemed.roomId, redeemed.clientId);
    res.json({
      protocolVersion: PROTOCOL_VERSION,
      roomId: redeemed.roomId,
      clientId: redeemed.clientId,
      accessToken: redeemed.accessToken,
      nickname: redeemed.nickname,
      onlineCount: room.onlineCount,
      snapshot: room.snapshot(),
    });
  });

  app.get("/api/rooms/:roomId/mpv/snapshot", (req, res): void => {
    const context = requireMpvContext(req, res, registry);
    if (!context) return;
    const snapshot = context.room.snapshot();
    const since =
      typeof req.query.since === "string" && /^\d+$/.test(req.query.since)
        ? Number(req.query.since)
        : undefined;
    if (since !== undefined && since === snapshot.revision) {
      res.status(204).end();
      return;
    }
    res.json(snapshot);
  });

  app.post("/api/rooms/:roomId/mpv/command", (req, res): void => {
    const context = requireMpvContext(req, res, registry);
    if (!context) return;
    const ack = runMpvCommand(context.room, context.clientId, req.body);
    res.status(ack.ok ? 200 : 400).json(ack);
  });

  app.post(
    "/api/rooms/:roomId/media/resolve-mpv",
    async (req, res): Promise<void> => {
      const context = requireMpvContext(req, res, registry);
      if (!context) return;
      if (typeof req.body?.mediaId !== "string" || !req.body.mediaId) {
        sendError(res, 400, "INVALID_REQUEST");
        return;
      }
      try {
        const resolved: ResolvedMpvMedia | null | undefined =
          await media.resolveMpv(req.body.mediaId);
        if (resolved === undefined) {
          sendError(res, 404, "MEDIA_NOT_FOUND");
          return;
        }
        if (resolved === null) {
          sendError(res, 400, "MEDIA_UNSUPPORTED");
          return;
        }
        res.json(resolved);
      } catch {
        // OpenList failures surface as upstream unavailability, never as details.
        sendError(res, 502, "OPENLIST_UNAVAILABLE");
      }
    },
  );
}

export type MpvRequestContext = {
  room: Room;
  clientId: string;
  registry: RoomRegistry;
};

/**
 * Shared guard for MPV endpoints: validates room id/existence, protocol
 * version header and clientType=mpv bearer token, and records the request as
 * an MPV heartbeat. Sends the error response and returns undefined on failure.
 */
export function requireMpvContext(
  req: Request,
  res: Response,
  registry: RoomRegistry,
): MpvRequestContext | undefined {
  const roomId = String(req.params.roomId ?? "");
  const room = validateRoomId(roomId) ? registry.get(roomId) : undefined;
  if (!room) {
    sendError(res, 404, "ROOM_NOT_FOUND");
    return undefined;
  }
  if (req.header("x-watchparty-protocol") !== String(PROTOCOL_VERSION)) {
    sendError(res, 426, "PROTOCOL_VERSION_MISMATCH");
    return undefined;
  }
  const token = bearerToken(req);
  const record = token
    ? registry.authenticateMpvToken(roomId, token)
    : undefined;
  if (!record) {
    const browserToken = token
      ? registry.authenticateToken(roomId, token)
      : undefined;
    sendError(
      res,
      browserToken ? 403 : 401,
      browserToken ? "FORBIDDEN" : "ACCESS_TOKEN_INVALID",
    );
    return undefined;
  }
  registry.touchMpvClient(roomId, record.clientId);
  return { room, clientId: record.clientId, registry };
}

/**
 * Command dispatch with the exact CMD:* semantics (validation, optimistic
 * expectedRevision, REVISION_CONFLICT). MPV is always a plain member:
 * isOwner=false and the type whitelist excludes owner-only commands.
 */
export function runMpvCommand(
  room: Room,
  clientId: string,
  payload: unknown,
): CommandAck {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return errorResult("INVALID_REQUEST");
  const body = payload as Record<string, unknown>;
  const expectedRevision = body.expectedRevision;
  if (!validateRevision(expectedRevision))
    return errorResult("INVALID_REQUEST");

  let command: SharedCommand;
  switch (body.type) {
    case "play":
      command = { type: "play" };
      break;
    case "pause":
      command = { type: "pause" };
      break;
    case "seek":
      if (typeof body.positionSeconds !== "number")
        return errorResult("INVALID_REQUEST");
      command = { type: "seek", positionSeconds: body.positionSeconds };
      break;
    case "rate":
      if (typeof body.rate !== "number") return errorResult("INVALID_REQUEST");
      command = { type: "rate", rate: body.rate };
      break;
    case "playlistNext":
      command = {
        type: "playlistNext",
        ...(typeof body.expectedCurrentPlaylistItemId === "string"
          ? {
              expectedCurrentPlaylistItemId: body.expectedCurrentPlaylistItemId,
            }
          : {}),
      };
      break;
    default:
      return errorResult("INVALID_REQUEST");
  }
  return room.execute(clientId, command, expectedRevision, false);
}
