import type { Express, Request, Response } from "express";
import { makeUserName } from "../../utils/moniker.ts";
import { validateMediaSource, validateNickname, validateRoomId } from "../media.ts";
import { ERROR_MESSAGES } from "../protocol.ts";
import type { RoomRegistry } from "../room/registry.ts";
import type { AppConfig } from "../../config.ts";
import { createOpenlistClient, OpenlistServiceError } from "../../media/openlist.ts";
import { createWatchpartyMedia } from "../../media/watchparty-media.ts";

/** Register room lifecycle and media APIs. Video bytes never pass through this service. */
export function registerCoreHttp(app: Express, registry: RoomRegistry, appConfig: AppConfig): void {
  const media = createWatchpartyMedia(createOpenlistClient(appConfig), {
    mediaIdKey: appConfig.watchPartyMediaIdKey,
    internalBaseUrl: appConfig.openlistUrl,
    publicBaseUrl: appConfig.openlistPublicUrl || appConfig.openlistUrl,
  });
  app.get("/ping", (_req, res): void => { res.json("pong"); });
  app.get("/generateName", (_req, res): void => { res.send(makeUserName()); });

  app.post("/api/rooms", (req, res): void => {
    const clientId = req.body?.clientId;
    const nickname = req.body?.nickname;
    const pin = req.body?.pin;
    const hasInitialMedia = req.body?.initialMedia !== undefined;
    const hasInitialSource = req.body?.initialSource !== undefined;
    const initialValue = hasInitialMedia ? req.body.initialMedia : req.body?.initialSource;
    const initialMedia = initialValue === undefined ? undefined : validateMediaSource(initialValue);
    if (typeof clientId !== "string" || !validateNickname(nickname) ||
      (hasInitialMedia && hasInitialSource) ||
      (pin !== undefined && (typeof pin !== "string" || !/^\d{4}$/.test(pin))) ||
      (initialValue !== undefined && !initialMedia)) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    try {
      const created = registry.create({ clientId, nickname, pin, initialMedia });
      res.status(200).json({ roomId: created.room.id, accessToken: created.accessToken, ownerToken: created.ownerToken });
    } catch {
      sendError(res, 400, "INVALID_REQUEST");
    }
  });

  app.get("/api/rooms/:roomId", (req, res): void => {
    const roomId = String(req.params.roomId);
    const room = validateRoomId(roomId) ? registry.get(roomId) : undefined;
    if (!room) { sendError(res, 404, "ROOM_NOT_FOUND"); return; }
    res.json({ roomId, isProtected: registry.isProtected(roomId), onlineCount: room.onlineCount });
  });

  app.post("/api/rooms/:roomId/access", (req, res): void => {
    const roomId = String(req.params.roomId);
    if (!validateRoomId(roomId) || !registry.get(roomId)) { sendError(res, 404, "ROOM_NOT_FOUND"); return; }
    const { clientId, nickname, pin } = req.body ?? {};
    if (typeof clientId !== "string" || typeof nickname !== "string" || !validateNickname(nickname)) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    const result = registry.issueAccess(roomId, clientId, nickname, typeof pin === "string" ? pin : undefined, requestIp(req));
    if (!result.ok) { sendError(res, result.code === "RATE_LIMITED" ? 429 : 401, result.code); return; }
    res.json({ accessToken: result.accessToken });
  });

  app.get("/api/media/roots", (_req, res): void => {
    res.json(media.rootNames());
  });

  app.get("/api/media/list", async (req, res) => {
    const root = req.query.root;
    const relativePath = typeof req.query.path === "string" ? req.query.path : "/";
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    if (!media.isRoot(root)) { sendError(res, 400, "INVALID_REQUEST"); return; }
    try { res.json(await media.list(root, relativePath, cursor)); }
    catch (error: unknown) { respondToError(res, error); }
  });

  app.get("/api/media/search", async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const root = req.query.root;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    if (!query || query.length > 200) { sendError(res, 400, "INVALID_REQUEST"); return; }
    if (root !== undefined && !media.isRoot(root)) { sendError(res, 400, "INVALID_REQUEST"); return; }
    try { res.json(await media.search(query, media.isRoot(root) ? root : undefined, cursor)); }
    catch (error: unknown) { respondToError(res, error); }
  });

  app.post("/api/rooms/:roomId/media/resolve", async (req, res) => {
    const roomId = String(req.params.roomId);
    if (!validateRoomId(roomId) || !registry.get(roomId)) { sendError(res, 404, "ROOM_NOT_FOUND"); return; }
    if (!registry.authenticateToken(roomId, bearerToken(req))) { sendError(res, 401, "ACCESS_TOKEN_INVALID"); return; }
    if (typeof req.body?.mediaId !== "string" || !req.body.mediaId) { sendError(res, 400, "INVALID_REQUEST"); return; }
    try {
      const resolved = await media.resolve(req.body.mediaId);
      if (resolved === undefined) { sendError(res, 404, "MEDIA_NOT_FOUND"); return; }
      if (resolved === null) { sendError(res, 400, "MEDIA_UNSUPPORTED"); return; }
      res.json(resolved);
    } catch (error: unknown) { respondToError(res, error); }
  });

  app.get("/api/rooms/:roomId/media/subtitle", async (req, res) => {
    const roomId = String(req.params.roomId);
    const mediaId = typeof req.query.mediaId === "string" ? req.query.mediaId : "";
    if (!validateRoomId(roomId) || !registry.get(roomId)) { sendError(res, 404, "ROOM_NOT_FOUND"); return; }
    if (!mediaId) { sendError(res, 400, "INVALID_REQUEST"); return; }
    if (!registry.authenticateToken(roomId, bearerToken(req))) { sendError(res, 401, "ACCESS_TOKEN_INVALID"); return; }
    try {
      const subtitle = await media.loadSubtitle(mediaId);
      if (subtitle === undefined) { sendError(res, 404, "MEDIA_NOT_FOUND"); return; }
      res.type("text/plain").send(subtitle);
    } catch (error: unknown) { respondToError(res, error); }
  });

  app.get("/api/rooms/:roomId/media/subtitles", async (req, res) => {
    const roomId = String(req.params.roomId);
    const mediaId = typeof req.query.mediaId === "string" ? req.query.mediaId : "";
    if (!validateRoomId(roomId) || !registry.get(roomId)) { sendError(res, 404, "ROOM_NOT_FOUND"); return; }
    if (!mediaId) { sendError(res, 400, "INVALID_REQUEST"); return; }
    if (!registry.authenticateToken(roomId, bearerToken(req))) { sendError(res, 401, "ACCESS_TOKEN_INVALID"); return; }
    try {
      const tracks = await media.discoverSubtitles(mediaId);
      if (tracks === undefined) { sendError(res, 404, "MEDIA_NOT_FOUND"); return; }
      res.json(tracks);
    } catch (error: unknown) { respondToError(res, error); }
  });
}

function requestIp(req: Request): string { return req.ip || req.socket.remoteAddress || "unknown"; }
function bearerToken(req: Request): string | undefined {
  const value = req.headers.authorization;
  if (typeof value !== "string") return undefined;
  const [scheme, token] = value.split(" ");
  return scheme === "Bearer" && token ? token : undefined;
}
function respondToError(res: Response, error: unknown): void {
  if (error instanceof OpenlistServiceError) {
    sendError(res, 502, "OPENLIST_UNAVAILABLE", error.message);
    return;
  }
  sendError(res, 400, "INVALID_REQUEST");
}
function sendError(res: Response, status: number, code: keyof typeof ERROR_MESSAGES, detail?: string): void {
  res.status(status).json({
    code,
    message: detail ? `${ERROR_MESSAGES[code]}: ${detail}` : ERROR_MESSAGES[code],
  });
}
