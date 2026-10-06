import type { Express, Request, Response } from "express";
import {
  PROTOCOL_VERSION,
  errorResult,
  type CommandAck,
} from "../protocol.ts";
import type { Room, SharedCommand } from "../room/Room.ts";
import type { RoomRegistry } from "../room/registry.ts";
import type { MediaSource } from "../protocol.ts";
import type {
  ResolvedMpvMedia,
  WatchpartyMedia,
} from "../../media/watchparty-media.ts";
import { validateMediaSource, validateRevision, validateRoomId } from "../media.ts";
import { bearerToken, sendError } from "./shared.ts";
import { mediaForRequest } from "./media-origin.ts";

export type NativeRequestContext = { room: Room; clientId: string };

/**
 * HTTP status for a failed CommandAck, per the spec error table: code-driven
 * (REVISION_CONFLICT 409, FORBIDDEN/OWNER_TOKEN_INVALID 403, MEDIA_NOT_FOUND
 * 404), everything else is a client-side 400.
 */
function errorHttpStatus(code: string): number {
  if (code === "REVISION_CONFLICT") return 409;
  if (code === "FORBIDDEN" || code === "OWNER_TOKEN_INVALID") return 403;
  if (code === "MEDIA_NOT_FOUND") return 404;
  return 400;
}

/** Register the browser-issued one-time MPV handoff ticket endpoint. */
export function registerHandoffHttp(
  app: Express,
  registry: RoomRegistry,
): void {
  app.post("/api/rooms/:roomId/handoff", (req, res): void => {
    const roomId = String(req.params.roomId);
    if (!validateRoomId(roomId) || !registry.get(roomId)) {
      sendError(res, 404, "ROOM_NOT_FOUND");
      return;
    }
    if (req.body?.target !== undefined && req.body.target !== "mpv") {
      sendError(res, 400, "INVALID_REQUEST");
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
    res.json({
      ticket: ticket.ticket,
      ticketExpiresAt: ticket.expiresAt,
      target: "mpv",
    });
  });
}

/** Register MPV handoff redemption. */
export function registerMpvHandoffHttp(app: Express, registry: RoomRegistry): void {
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
    room.join(redeemed.clientId, redeemed.nickname, "mpv");
    res.json({
      protocolVersion: PROTOCOL_VERSION,
      roomId: redeemed.roomId,
      clientId: redeemed.clientId,
      accessToken: redeemed.accessToken,
      nickname: redeemed.nickname,
      clientType: redeemed.clientType,
      onlineCount: room.onlineCount,
      snapshot: room.snapshot(),
    });
  });
}

/** Register the HTTP surface used by the MPV plugin. */
export function registerMpvClientHttp(
  app: Express,
  registry: RoomRegistry,
  media: WatchpartyMedia,
  mediaPublicOrigins: readonly string[] = [],
): void {
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
    const ack = runNativeCommand(context.room, context.clientId, req.body);
    res.status(ack.ok ? 200 : errorHttpStatus(ack.error.code)).json(ack);
  });

  app.post("/api/rooms/:roomId/media/resolve-mpv", async (req, res): Promise<void> => {
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
      res.json(mediaForRequest(req, resolved, mediaPublicOrigins));
    } catch {
      sendError(res, 502, "OPENLIST_UNAVAILABLE");
    }
  });

}

/** Authenticate MPV requests and restore stale-pruned members before commands. */
export function requireMpvContext(
  req: Request,
  res: Response,
  registry: RoomRegistry,
): NativeRequestContext | undefined {
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
  const record = token ? registry.authenticateMpvToken(roomId, token) : undefined;
  if (!record) {
    const knownToken = token
      ? registry.authenticateToken(roomId, token)
      : undefined;
    sendError(
      res,
      knownToken ? 403 : 401,
      knownToken ? "FORBIDDEN" : "ACCESS_TOKEN_INVALID",
    );
    return undefined;
  }
  if (req.header("x-watchparty-client-type") !== "mpv") {
    sendError(res, 403, "FORBIDDEN");
    return undefined;
  }

  // A stale-pruned MPV returning with its still-valid token must always act
  // as a visible member, never a ghost controller outside the member list.
  if (!room.isOnline(record.clientId)) {
    room.join(record.clientId, record.nickname, "mpv");
  }
  registry.touchMpvClient(roomId, record.clientId);
  return { room, clientId: record.clientId };
}

/**
 * Dispatch the restricted MPV command set using the same Room semantics as
 * Socket.IO. Owner-gated commands only execute when the caller proved ownership
 * MPV is always a non-owner and cannot run owner-gated commands.
 */
export function runNativeCommand(
  room: Room,
  clientId: string,
  payload: unknown,
  isOwner = false,
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
    case "loop":
      if (typeof body.loop !== "boolean") return errorResult("INVALID_REQUEST");
      command = { type: "loop", loop: body.loop };
      break;
    case "lock":
      if (typeof body.locked !== "boolean")
        return errorResult("INVALID_REQUEST");
      command = { type: "lock", locked: body.locked };
      break;
    case "playlistPlay":
      if (typeof body.itemId !== "string" || body.itemId.length === 0)
        return errorResult("INVALID_REQUEST");
      command = { type: "playlistPlay", itemId: body.itemId };
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
    case "playlistAutoNext":
      command = {
        type: "playlistAutoNext",
        ...(typeof body.expectedCurrentPlaylistItemId === "string"
          ? {
              expectedCurrentPlaylistItemId: body.expectedCurrentPlaylistItemId,
            }
          : {}),
      };
      break;
    case "mediaSet":
    case "playlistAdd": {
      const media = validateMediaSource(body.media);
      if (!media) return errorResult("INVALID_REQUEST");
      command =
        body.type === "mediaSet"
          ? { type: "mediaSet", media }
          : { type: "playlistAdd", media };
      break;
    }
    case "playlistRemove":
      if (typeof body.itemId !== "string" || body.itemId.length === 0)
        return errorResult("INVALID_REQUEST");
      command = { type: "playlistRemove", itemId: body.itemId };
      break;
    case "playlistMove": {
      if (typeof body.itemId !== "string" || body.itemId.length === 0)
        return errorResult("INVALID_REQUEST");
      if (
        typeof body.targetIndex !== "number" ||
        !Number.isInteger(body.targetIndex) ||
        body.targetIndex < 0
      )
        return errorResult("INVALID_REQUEST");
      command = {
        type: "playlistMove",
        itemId: body.itemId,
        targetIndex: body.targetIndex,
      };
      break;
    }
    default:
      return errorResult("INVALID_REQUEST");
  }
  return room.execute(clientId, command, expectedRevision, isOwner);
}

/** Backward-compatible name retained for the MPV side branch. */
export const runMpvCommand = runNativeCommand;
