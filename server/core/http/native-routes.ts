import type { Express, Request, Response } from "express";
import {
  PROTOCOL_VERSION,
  errorResult,
  type ClientType,
  type CommandAck,
} from "../protocol.ts";
import type { Room, SharedCommand } from "../room/Room.ts";
import type { RoomRegistry } from "../room/registry.ts";
import type {
  ResolvedMpvMedia,
  WatchpartyMedia,
} from "../../media/watchparty-media.ts";
import { validateRevision, validateRoomId } from "../media.ts";
import { bearerToken, sendError } from "./shared.ts";

type NativeClientType = Extract<ClientType, "mpv" | "desktop">;
type HandoffTarget = NativeClientType;

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

export type NativeRequestContext = {
  room: Room;
  clientId: string;
  registry: RoomRegistry;
  clientType: NativeClientType;
  sessionGeneration?: number;
};

/** Register the browser-issued handoff ticket endpoint. Missing target keeps the MPV behavior. */
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
    const target = parseTarget(req.body?.target);
    if (!target) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    const token = bearerToken(req);
    const ticket = token
      ? registry.issueHandoffTicket(roomId, token, target)
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
      target,
    });
  });
}

/** Register a native handoff redemption endpoint while retaining the old MPV URL. */
export function registerNativeHandoffHttp(
  app: Express,
  registry: RoomRegistry,
  clientType: NativeClientType,
): void {
  const endpoint =
    clientType === "desktop" ? "/api/desktop/handoff" : "/api/mpv/handoff";
  app.post(endpoint, (req, res): void => {
    const ticket = req.body?.ticket;
    const redeemed = registry.redeemHandoffTicket(
      typeof ticket === "string" ? ticket : "",
      clientType,
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
    room.join(redeemed.clientId, redeemed.nickname, clientType);
    res.json({
      protocolVersion: PROTOCOL_VERSION,
      roomId: redeemed.roomId,
      clientId: redeemed.clientId,
      accessToken: redeemed.accessToken,
      nickname: redeemed.nickname,
      clientType: redeemed.clientType,
      ...(redeemed.sessionGeneration !== undefined
        ? { sessionGeneration: redeemed.sessionGeneration }
        : {}),
      onlineCount: room.onlineCount,
      snapshot: room.snapshot(),
    });
  });
}

/** Register the shared HTTP surface for an MPV or desktop native client. */
export function registerNativeClientHttp(
  app: Express,
  registry: RoomRegistry,
  media: WatchpartyMedia,
  clientType: NativeClientType,
): void {
  const prefix = clientType === "desktop" ? "desktop" : "mpv";
  const resolvePath =
    clientType === "desktop"
      ? "/api/rooms/:roomId/desktop/media/resolve"
      : "/api/rooms/:roomId/media/resolve-mpv";

  app.get(`/api/rooms/:roomId/${prefix}/snapshot`, (req, res): void => {
    const context = requireNativeContext(req, res, registry, clientType);
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

  if (clientType === "desktop") {
    app.get("/api/rooms/:roomId/desktop/members", (req, res): void => {
      const context = requireNativeContext(req, res, registry, "desktop");
      if (!context) return;
      res.json(context.room.snapshotMembers());
    });
  }

  app.post(`/api/rooms/:roomId/${prefix}/command`, (req, res): void => {
    const context = requireNativeContext(req, res, registry, clientType);
    if (!context) return;
    const ack = runNativeCommand(context.room, context.clientId, req.body);
    res.status(ack.ok ? 200 : errorHttpStatus(ack.error.code)).json(ack);
  });

  app.post(resolvePath, async (req, res): Promise<void> => {
    const context = requireNativeContext(req, res, registry, clientType);
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
      sendError(res, 502, "OPENLIST_UNAVAILABLE");
    }
  });

  if (clientType === "desktop") {
    app.post("/api/rooms/:roomId/desktop/session", (req, res): void => {
      const roomId = String(req.params.roomId ?? "");
      const room = validateRoomId(roomId) ? registry.get(roomId) : undefined;
      if (!room) {
        sendError(res, 404, "ROOM_NOT_FOUND");
        return;
      }
      if (req.header("x-watchparty-protocol") !== String(PROTOCOL_VERSION)) {
        sendError(res, 426, "PROTOCOL_VERSION_MISMATCH");
        return;
      }
      if (req.header("x-watchparty-client-type") !== "desktop") {
        sendError(res, 403, "FORBIDDEN");
        return;
      }
      const token = bearerToken(req);
      const claimed = token
        ? registry.claimDesktopSession(roomId, token)
        : undefined;
      if (!claimed) {
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
        protocolVersion: PROTOCOL_VERSION,
        roomId,
        clientId: claimed.clientId,
        nickname: claimed.nickname,
        sessionGeneration: claimed.generation,
      });
    });

    app.delete("/api/rooms/:roomId/desktop/session", (req, res): void => {
      const context = requireNativeContext(req, res, registry, "desktop");
      if (!context) return;
      const generation = context.sessionGeneration;
      if (
        generation === undefined ||
        !registry.leaveDesktopClient(
          context.room.id,
          context.clientId,
          generation,
        )
      ) {
        sendError(res, 409, "SESSION_GENERATION_STALE");
        return;
      }
      res.status(204).end();
    });
  }
}

/** Shared native guard. Desktop requests must identify their current session generation. */
export function requireNativeContext(
  req: Request,
  res: Response,
  registry: RoomRegistry,
  clientType: NativeClientType,
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
  const clientHeader = req.header("x-watchparty-client-type");
  const token = bearerToken(req);
  const record = token
    ? registry.authenticateNativeToken(roomId, token, clientType)
    : undefined;
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
  if (clientHeader !== clientType) {
    sendError(res, 403, "FORBIDDEN");
    return undefined;
  }

  let sessionGeneration: number | undefined;
  if (clientType === "desktop") {
    const rawGeneration = req.header("x-watchparty-session-generation");
    sessionGeneration =
      rawGeneration && /^\d+$/.test(rawGeneration)
        ? Number(rawGeneration)
        : undefined;
    const current = registry.desktopSessionGeneration(roomId, record.clientId);
    if (sessionGeneration === undefined || current !== sessionGeneration) {
      sendError(res, 409, "SESSION_GENERATION_STALE");
      return undefined;
    }
    if (
      !registry.touchDesktopClient(roomId, record.clientId, sessionGeneration)
    ) {
      sendError(res, 409, "SESSION_GENERATION_STALE");
      return undefined;
    }
  } else {
    // A stale-pruned MPV returning with its still-valid token must always act
    // as a visible member: restore membership here so it can never become a
    // ghost controller that mutates room state while absent from the member list.
    if (!room.isOnline(record.clientId)) {
      room.join(record.clientId, record.nickname);
    }
    registry.touchMpvClient(roomId, record.clientId);
  }
  return {
    room,
    clientId: record.clientId,
    registry,
    clientType,
    sessionGeneration,
  };
}

/** Backward-compatible name retained for MPV callers and tests. */
export function requireMpvContext(
  req: Request,
  res: Response,
  registry: RoomRegistry,
): NativeRequestContext | undefined {
  return requireNativeContext(req, res, registry, "mpv");
}

/** Dispatch the restricted native command set using the same Room semantics as Socket.IO. */
export function runNativeCommand(
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

/** Backward-compatible name retained for the MPV side branch. */
export const runMpvCommand = runNativeCommand;

function parseTarget(value: unknown): HandoffTarget | undefined {
  return value === undefined || value === "mpv" || value === "desktop"
    ? (value ?? "mpv")
    : undefined;
}
