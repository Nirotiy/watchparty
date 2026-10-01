import type { Express, Request, RequestHandler, Response } from "express";
import type { Server as CoreServer } from "socket.io";
import {
  DESKTOP_CAPABILITIES,
  DESKTOP_SERVICE_VERSION,
  PROTOCOL_VERSION,
  errorResult,
  type ClientType,
  type CommandAck,
} from "../protocol.ts";
import type { Room, SharedCommand } from "../room/Room.ts";
import type { RoomRegistry } from "../room/registry.ts";
import type { MediaSource } from "../protocol.ts";
import type {
  ResolvedMpvMedia,
  WatchpartyMedia,
} from "../../media/watchparty-media.ts";
import { isValidUUID, validateMediaSource, validateNickname, validateRevision, validateRoomId } from "../media.ts";
import { bearerToken, requestIp, sendError } from "./shared.ts";
import type { ListenerInfo, ReadinessProbe } from "./readiness.ts";
import { mediaForRequest } from "./media-origin.ts";

type NativeClientType = Extract<ClientType, "mpv" | "desktop">;
type HandoffTarget = NativeClientType;

function requireDesktopProtocol(req: Request, res: Response): boolean {
  if (req.header("x-watchparty-protocol") !== String(PROTOCOL_VERSION)) {
    sendError(res, 426, "PROTOCOL_VERSION_MISMATCH");
    return false;
  }
  if (req.header("x-watchparty-client-type") !== "desktop") {
    sendError(res, 403, "FORBIDDEN");
    return false;
  }
  return true;
}

function requireOptionalDesktopProtocol(req: Request, res: Response): boolean {
  const declared = req.header("x-watchparty-protocol");
  if (declared !== undefined && declared !== String(PROTOCOL_VERSION)) {
    sendError(res, 426, "PROTOCOL_VERSION_MISMATCH");
    return false;
  }
  return true;
}

export type DesktopProbeDeps = {
  readiness: ReadinessProbe;
  getListenerInfo: () => ListenerInfo;
};

/** Public, credential-free discovery endpoints used before room entry. */
export function registerDesktopProbeHttp(
  app: Express,
  deps: DesktopProbeDeps,
): void {
  app.get("/api/desktop/health", (req, res): void => {
    if (!requireOptionalDesktopProtocol(req, res)) return;
    res.json({
      status: "ok",
      protocolVersion: PROTOCOL_VERSION,
      serviceVersion: DESKTOP_SERVICE_VERSION,
    });
  });

  app.get("/api/desktop/capabilities", (req, res): void => {
    if (!requireOptionalDesktopProtocol(req, res)) return;
    res.json({
      protocolVersion: PROTOCOL_VERSION,
      serviceVersion: DESKTOP_SERVICE_VERSION,
      capabilities: DESKTOP_CAPABILITIES,
    });
  });

  // Readiness: always 200 while the process answers; status and the stable
  // diagnostic codes carry dependency health. The bare /api/readiness path is
  // a kept alias of the desktop probe route.
  const readinessHandler: RequestHandler = async (req, res) => {
    if (!requireOptionalDesktopProtocol(req, res)) return;
    const snapshot = await deps.readiness.snapshot(deps.getListenerInfo());
    res.json(snapshot);
  };
  app.get("/api/desktop/readiness", readinessHandler);
  app.get("/api/readiness", readinessHandler);
}

/** Native desktop lifecycle endpoints. These mint a real desktop identity;
 * they do not reuse browser access tokens or the optional handoff ticket. */
export function registerDesktopLifecycleHttp(app: Express, registry: RoomRegistry): void {
  app.post("/api/desktop/rooms", (req, res): void => {
    if (!requireDesktopProtocol(req, res)) return;
    const { clientId, nickname, pin } = req.body ?? {};
    const initialValue = req.body?.initialMedia ?? req.body?.initialSource;
    const initialMedia = initialValue === undefined ? undefined : validateMediaSource(initialValue);
    if (
      typeof clientId !== "string" || !isValidUUID(clientId) ||
      !validateNickname(nickname) ||
      (pin !== undefined && (typeof pin !== "string" || !/^\d{4}$/.test(pin))) ||
      (initialValue !== undefined && !initialMedia)
    ) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    try {
      const created = registry.create({
        clientId,
        nickname,
        pin,
        initialMedia,
        clientType: "desktop",
      });
      res.json({
        protocolVersion: PROTOCOL_VERSION,
        roomId: created.room.id,
        clientId,
        accessToken: created.accessToken,
        ownerToken: created.ownerToken,
        nickname: nickname.trim(),
        clientType: "desktop",
        sessionGeneration: 1,
        onlineCount: created.room.onlineCount,
        snapshot: created.room.snapshot(),
      });
    } catch {
      sendError(res, 400, "INVALID_REQUEST");
    }
  });

  app.post("/api/desktop/rooms/:roomId/access", (req, res): void => {
    if (!requireDesktopProtocol(req, res)) return;
    const roomId = String(req.params.roomId ?? "");
    if (!validateRoomId(roomId) || !registry.get(roomId)) {
      sendError(res, 404, "ROOM_NOT_FOUND");
      return;
    }
    const { clientId, nickname, pin } = req.body ?? {};
    if (typeof clientId !== "string" || !isValidUUID(clientId) || !validateNickname(nickname)) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    if (registry.isProtected(roomId) && pin === undefined) {
      sendError(res, 401, "ROOM_PIN_REQUIRED");
      return;
    }
    const result = registry.issueAccess(
      roomId,
      clientId,
      nickname,
      typeof pin === "string" ? pin : undefined,
      requestIp(req),
      "desktop",
    );
    if (!result.ok) {
      sendError(
        res,
        result.code === "RATE_LIMITED" ? 429 : 401,
        result.code === "INVALID_PIN" ? "ROOM_PIN_REJECTED" : result.code,
      );
      return;
    }
    res.json({ protocolVersion: PROTOCOL_VERSION, roomId, clientId, accessToken: result.accessToken, clientType: "desktop" });
  });
}

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
  io?: CoreServer | null,
  mediaPublicOrigins: readonly string[] = [],
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

    // One-time delivery of an owner token granted by a transferring owner.
    app.post(
      "/api/rooms/:roomId/desktop/owner-grant/claim",
      (req, res): void => {
        const context = requireNativeContext(req, res, registry, "desktop");
        if (!context) return;
        const ownerToken = registry.claimOwnerGrant(
          context.room.id,
          context.clientId,
        );
        if (!ownerToken) {
          res.status(204).end();
          return;
        }
        res.json({ ownerToken });
      },
    );
  }

  app.post(`/api/rooms/:roomId/${prefix}/command`, (req, res): void => {
    const context = requireNativeContext(req, res, registry, clientType);
    if (!context) return;
    if (clientType === "desktop") {
      const ack = runDesktopOwnerAwareCommand(context, req, registry, io);
      res.status(ack.ok ? 200 : errorHttpStatus(ack.error.code)).json(ack);
      return;
    }
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
      res.json(mediaForRequest(req, resolved, mediaPublicOrigins));
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
      room.join(record.clientId, record.nickname, "mpv");
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

/**
 * Dispatch the restricted native command set using the same Room semantics as
 * Socket.IO. Owner-gated commands only execute when the caller proved ownership
 * (desktop: `X-WatchParty-Owner-Token` header; MPV is never an owner).
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

/**
 * Desktop command dispatch. `lock` reuses the shared Room semantics gated by
 * the owner token header; `name` renames the caller; `transferOwner` rotates
 * ownership across client types. Everything else is the restricted native set.
 */
function runDesktopOwnerAwareCommand(
  context: NativeRequestContext,
  req: Request,
  registry: RoomRegistry,
  io: CoreServer | null | undefined,
): CommandAck {
  const body = req.body as Record<string, unknown> | undefined;
  const ownerToken = req.header("x-watchparty-owner-token");
  const isOwner = ownerToken
    ? registry.isOwner(context.room.id, context.clientId, ownerToken)
    : false;

  if (body?.type === "name") {
    const name = body.name;
    if (typeof name !== "string") return errorResult("INVALID_REQUEST");
    const ack = context.room.rename(context.clientId, name);
    if (ack.ok && typeof body.expectedRevision === "number") {
      registry.updateNickname(
        context.room.id,
        bearerToken(req) ?? "",
        name,
      );
    }
    return ack;
  }

  if (body?.type === "transferOwner") {
    const targetClientId = body.targetClientId;
    if (typeof targetClientId !== "string" || !isValidUUID(targetClientId))
      return errorResult("INVALID_REQUEST");
    if (!validateRevision(body.expectedRevision))
      return errorResult("INVALID_REQUEST");
    if (body.expectedRevision !== context.room.snapshot().revision)
      return errorResult("REVISION_CONFLICT");
    if (!isOwner) return errorResult("OWNER_TOKEN_INVALID");
    const result = registry.transferOwner(
      context.room.id,
      context.clientId,
      ownerToken,
      targetClientId,
    );
    if (!result.ok) return errorResult(result.code);
    if (context.room.memberClientType(targetClientId) === "desktop") {
      registry.queueOwnerGrant(context.room.id, targetClientId, result.ownerToken);
    } else if (io) {
      for (const socket of io.sockets.sockets.values()) {
        if (
          socket.data.roomId === context.room.id &&
          socket.data.clientId === targetClientId
        ) {
          socket.data.ownerToken = result.ownerToken;
          io.to(socket.id).emit("REC:ownerToken", result.ownerToken);
        }
      }
    }
    return { ok: true, revision: context.room.snapshot().revision };
  }

  return runNativeCommand(context.room, context.clientId, req.body, isOwner);
}

function parseTarget(value: unknown): HandoffTarget | undefined {
  return value === undefined || value === "mpv" || value === "desktop"
    ? (value ?? "mpv")
    : undefined;
}
