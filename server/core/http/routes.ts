import type { Express, Request, Response } from "express";
import {
  validateMediaSource,
  validateNickname,
  validateRoomId,
} from "../media.ts";
import type { RoomRegistry } from "../room/registry.ts";
import type { AppConfig } from "../../config.ts";
import type { WatchpartyMedia } from "../../media/watchparty-media.ts";
import {
  SUBTITLE_CONTENT_CAP_BYTES,
  SUBTITLE_FORMATS,
  SUBTITLE_TRACKS_PER_MEDIA,
  type SubtitleStore,
} from "../../media/subtitle-store.ts";
import { OpenlistServiceError } from "../../media/openlist.ts";
import { bearerToken, requestIp, sendError, requireRoomAccess } from "./shared.ts";
import { mediaForRequest } from "./media-origin.ts";

/**
 * 上传字幕的路径形状。app.ts 要给这一条路由单独挂一个宽 JSON 解析器（正文上限
 * 512KB，远超全局 100KB），所以导出成常量，而不是在 app.ts 再抄一遍字面量。
 */
export const SUBTITLE_UPLOAD_PATH = /^\/api\/rooms\/[^/]+\/media\/subtitles$/;

/** Register room lifecycle and media APIs. Video bytes never pass through this service. */
export function registerCoreHttp(
  app: Express,
  registry: RoomRegistry,
  appConfig: AppConfig,
  media: WatchpartyMedia,
  subtitles: SubtitleStore,
): void {
  app.get("/ping", (_req, res): void => {
    res.json("pong");
  });
  app.post("/api/rooms", (req, res): void => {
    const clientId = req.body?.clientId;
    const nickname = req.body?.nickname;
    const pin = req.body?.pin;
    const hasInitialMedia = req.body?.initialMedia !== undefined;
    const hasInitialSource = req.body?.initialSource !== undefined;
    const initialValue = hasInitialMedia
      ? req.body.initialMedia
      : req.body?.initialSource;
    const initialMedia =
      initialValue === undefined
        ? undefined
        : validateMediaSource(initialValue);
    if (
      typeof clientId !== "string" ||
      !validateNickname(nickname) ||
      (hasInitialMedia && hasInitialSource) ||
      (pin !== undefined &&
        (typeof pin !== "string" || !/^\d{4}$/.test(pin))) ||
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
      });
      res
        .status(200)
        .json({
          roomId: created.room.id,
          accessToken: created.accessToken,
          ownerToken: created.ownerToken,
        });
    } catch {
      sendError(res, 400, "INVALID_REQUEST");
    }
  });

  app.get("/api/rooms/:roomId", (req, res): void => {
    const roomId = String(req.params.roomId);
    const room = validateRoomId(roomId) ? registry.get(roomId) : undefined;
    if (!room) {
      sendError(res, 404, "ROOM_NOT_FOUND");
      return;
    }
    res.json({
      roomId,
      isProtected: registry.isProtected(roomId),
    });
  });

  app.post("/api/rooms/:roomId/access", (req, res): void => {
    const roomId = String(req.params.roomId);
    if (!validateRoomId(roomId) || !registry.get(roomId)) {
      sendError(res, 404, "ROOM_NOT_FOUND");
      return;
    }
    const { clientId, nickname, pin } = req.body ?? {};
    if (
      typeof clientId !== "string" ||
      typeof nickname !== "string" ||
      !validateNickname(nickname)
    ) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    const result = registry.issueAccess(
      roomId,
      clientId,
      nickname,
      typeof pin === "string" ? pin : undefined,
      requestIp(req),
    );
    if (!result.ok) {
      sendError(res, result.code === "RATE_LIMITED" ? 429 : 401, result.code);
      return;
    }
    res.json({ accessToken: result.accessToken });
  });

  app.get("/api/media/roots", (req, res): void => {
    if (!requireRoomAccess(req, res, registry)) return;
    res.json(media.rootNames());
  });

  app.get("/api/media/list", async (req, res) => {
    if (!requireRoomAccess(req, res, registry)) return;
    const root = req.query.root;
    const relativePath =
      typeof req.query.path === "string" ? req.query.path : "/";
    const cursor =
      typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    if (!media.isRoot(root)) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    try {
      res.json(await media.list(root, relativePath, cursor));
    } catch (error: unknown) {
      respondToError(res, error);
    }
  });

  app.get("/api/media/search", async (req, res) => {
    if (!requireRoomAccess(req, res, registry)) return;
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const root = req.query.root;
    const cursor =
      typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    if (!query || query.length > 200) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    if (root !== undefined && !media.isRoot(root)) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    try {
      res.json(
        await media.search(
          query,
          media.isRoot(root) ? root : undefined,
          cursor,
        ),
      );
    } catch (error: unknown) {
      respondToError(res, error);
    }
  });

  app.post("/api/rooms/:roomId/media/resolve", async (req, res) => {
    const roomId = String(req.params.roomId);
    if (!validateRoomId(roomId) || !registry.get(roomId)) {
      sendError(res, 404, "ROOM_NOT_FOUND");
      return;
    }
    if (!registry.authenticateToken(roomId, bearerToken(req))) {
      sendError(res, 401, "ACCESS_TOKEN_INVALID");
      return;
    }
    if (typeof req.body?.mediaId !== "string" || !req.body.mediaId) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    try {
      const resolved = await media.resolve(req.body.mediaId);
      if (resolved === undefined) {
        sendError(res, 404, "MEDIA_NOT_FOUND");
        return;
      }
      if (resolved === null) {
        sendError(res, 400, "MEDIA_UNSUPPORTED");
        return;
      }
      res.json(mediaForRequest(req, resolved, appConfig.mediaPublicOrigins));
    } catch (error: unknown) {
      respondToError(res, error);
    }
  });

  app.get("/api/rooms/:roomId/media/subtitle", async (req, res) => {
    const roomId = String(req.params.roomId);
    const mediaId =
      typeof req.query.mediaId === "string" ? req.query.mediaId : "";
    if (!validateRoomId(roomId) || !registry.get(roomId)) {
      sendError(res, 404, "ROOM_NOT_FOUND");
      return;
    }
    if (!mediaId) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    if (!registry.authenticateToken(roomId, bearerToken(req))) {
      sendError(res, 401, "ACCESS_TOKEN_INVALID");
      return;
    }
    try {
      const subtitle = await media.loadSubtitle(mediaId);
      if (subtitle === undefined) {
        sendError(res, 404, "MEDIA_NOT_FOUND");
        return;
      }
      res.type("text/plain").send(subtitle);
    } catch (error: unknown) {
      respondToError(res, error);
    }
  });

  app.get("/api/rooms/:roomId/media/subtitles", async (req, res) => {
    const roomId = String(req.params.roomId);
    const mediaId =
      typeof req.query.mediaId === "string" ? req.query.mediaId : "";
    if (!validateRoomId(roomId) || !registry.get(roomId)) {
      sendError(res, 404, "ROOM_NOT_FOUND");
      return;
    }
    if (!mediaId) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    if (!registry.authenticateToken(roomId, bearerToken(req))) {
      sendError(res, 401, "ACCESS_TOKEN_INVALID");
      return;
    }
    try {
      const tracks = await media.discoverSubtitles(mediaId);
      if (tracks === undefined) {
        sendError(res, 404, "MEDIA_NOT_FOUND");
        return;
      }
      // 旁挂字幕带上 source（前端据此分流取内容）；上传字幕按 mediaId 挂在同一张列表后面，
      // 它们是媒体级的，换房间、重开服务都还在。
      res.json([
        ...tracks.map((track) => ({ ...track, source: "sidecar" as const })),
        ...subtitles.list(mediaId),
      ]);
    } catch (error: unknown) {
      respondToError(res, error);
    }
  });

  // 上传字幕（房内任意成员；媒体级持久）。同名覆盖，所以反复修同一份字幕不会堆重复项。
  app.post("/api/rooms/:roomId/media/subtitles", async (req, res) => {
    if (!requireRoomMember(req, res, registry)) return;
    const mediaId = stringField(req.body, "mediaId");
    const name = stringField(req.body, "name").trim();
    const format = stringField(req.body, "format");
    const content = stringField(req.body, "content");
    const language = stringField(req.body, "language").trim();
    if (
      !mediaId ||
      mediaId.length > 4096 ||
      !name ||
      name.length > SUBTITLE_NAME_MAX ||
      CONTROL_CHAR.test(name) ||
      language.length > SUBTITLE_LANGUAGE_MAX
    ) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    if (!SUBTITLE_FORMATS.includes(format)) {
      sendError(res, 400, "SUBTITLE_FORMAT_UNSUPPORTED");
      return;
    }
    if (!content) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    if (Buffer.byteLength(content, "utf8") > SUBTITLE_CONTENT_CAP_BYTES) {
      sendError(res, 413, "SUBTITLE_TOO_LARGE");
      return;
    }
    try {
      // 先让媒体层认领这个 id（签名 + 归属库 + 确实是视频文件）再落库：否则打错的 id
      // 会留下谁也列不到的一行，而 512KB 正文就长期躺在库里。
      if ((await media.discoverSubtitles(mediaId)) === undefined) {
        sendError(res, 404, "MEDIA_NOT_FOUND");
        return;
      }
      const held = subtitles.list(mediaId);
      if (
        held.length >= SUBTITLE_TRACKS_PER_MEDIA &&
        !held.some((track) => track.label === name)
      ) {
        sendError(res, 409, "SUBTITLE_TRACKS_FULL");
        return;
      }
      res.json(
        subtitles.put({
          mediaId,
          name,
          format,
          content,
          ...(language ? { language } : {}),
        }),
      );
    } catch (error: unknown) {
      respondToError(res, error);
    }
  });

  // 上传字幕的正文。旁挂字幕继续走上面的 /media/subtitle?mediaId=（那条要过 OpenList）。
  app.get("/api/rooms/:roomId/media/subtitles/:subtitleId/content", (req, res) => {
    if (!requireRoomMember(req, res, registry)) return;
    const loaded = subtitles.load(String(req.params.subtitleId));
    if (!loaded) {
      sendError(res, 404, "SUBTITLE_NOT_FOUND");
      return;
    }
    res.type("text/plain").send(loaded.content);
  });

  // 删除只给房主：上传字幕是全房间共享的持久数据，不能让一个成员把别人的字幕抽走。
  app.delete("/api/rooms/:roomId/media/subtitles/:subtitleId", (req, res) => {
    const actor = requireRoomMember(req, res, registry);
    if (!actor) return;
    if (!actor.isOwner) {
      sendError(res, 403, "SUBTITLE_OWNER_ONLY");
      return;
    }
    if (!subtitles.remove(String(req.params.subtitleId))) {
      sendError(res, 404, "SUBTITLE_NOT_FOUND");
      return;
    }
    res.json({ removed: true });
  });
}

function respondToError(res: Response, error: unknown): void {
  if (error instanceof OpenlistServiceError) {
    sendError(res, 502, "OPENLIST_UNAVAILABLE", error.message);
    return;
  }
  sendError(res, 400, "INVALID_REQUEST");
}

const SUBTITLE_NAME_MAX = 200;
const SUBTITLE_LANGUAGE_MAX = 16;
/** 控制字符不进标签：它们会毁掉菜单行，且没有任何显示价值。 */
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

function stringField(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * 字幕写/删路由的房间鉴权。失败顺序与既有 `/media/subtitle` 一致（房不存在 404 →
 * 凭据不认 401），并顺带算出这个凭据是不是房主本人的：删除只按 access token 寻址，
 * 房主身份就是"这张票属于 ownerClientId"（转让房主后旧房主的票自动失去资格）。
 */
function requireRoomMember(
  req: Request,
  res: Response,
  registry: RoomRegistry,
): { isOwner: boolean } | undefined {
  const roomId = String(req.params.roomId);
  const room = validateRoomId(roomId) ? registry.get(roomId) : undefined;
  if (!room) {
    sendError(res, 404, "ROOM_NOT_FOUND");
    return undefined;
  }
  const access = registry.authenticateToken(roomId, bearerToken(req));
  if (!access) {
    sendError(res, 401, "ACCESS_TOKEN_INVALID");
    return undefined;
  }
  return { isOwner: access.clientId === room.ownerId };
}
