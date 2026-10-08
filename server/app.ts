import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import cors from "cors";
import express, { type Express } from "express";
import { Server } from "socket.io";
import { loadConfig, type AppConfig } from "./config.ts";
import { registerCoreHttp, SUBTITLE_UPLOAD_PATH } from "./core/http/routes.ts";
import { createReadinessProbe } from "./core/http/readiness.ts";
import {
  registerHandoffHttp,
  registerDesktopLifecycleHttp,
  registerDesktopProbeHttp,
  registerNativeClientHttp,
  registerNativeHandoffHttp,
} from "./core/http/native-routes.ts";
import { registerLibraryHttp } from "./core/http/library-routes.ts";
import { GuestAccessStore } from "./core/guest-access.ts";
import { guestReadGuard } from "./core/http/shared.ts";
import { createWatchpartyMedia } from "./media/watchparty-media.ts";
import { createLibraryService, routeLibraryMedia, type LibraryClientFactory } from "./media/library-service.ts";
import { createSubtitleStore } from "./media/subtitle-store.ts";
import { createOpenlistClient } from "./media/openlist.ts";
import { RoomRegistry } from "./core/room/registry.ts";
import { bindRooms } from "./core/socket/bindRooms.ts";
import type {
  ClientToServerEvents,
  CoreServer,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from "./core/protocol.ts";

export type CreateBackendOptions = {
  host?: string;
  port?: number;
  idleTtlMs?: number;
  pruneIntervalMs?: number;
  now?: () => number;
  config?: AppConfig;
  /** Setup-guide readiness cache TTL; 0 disables caching. */
  readinessCacheTtlMs?: number;
  /** Override the OpenList readiness ping budget (ms); default 2000. */
  openlistPingTimeoutMs?: number;
  /** sqlite file for media sources. Defaults to :memory: when NODE_ENV=test. */
  libraryDbPath?: string;
  /** catalog 库路径；测试用临时文件，好让断言能直接读表（默认 `data/watchparty-catalog.sqlite`）。 */
  catalogDbPath?: string;
  /** Test double for per-source OpenList clients. Production uses createOpenlistClient. */
  libraryClientFactory?: LibraryClientFactory;
  /** When false, admin routes require libraryAdminToken even from loopback. Default true. */
  trustLibraryAdminLoopback?: boolean;
  libraryAdminToken?: string;
  /** When true, POST scrape waits until the in-process job finishes or pauses. */
  catalogInline?: boolean;
  catalogDelayMs?: number;
  catalogMaxLookups?: number;
  posterDir?: string;
  /** collection sidecar 根目录；测试用临时目录，默认 `data/catalog-sidecars`。 */
  catalogSidecarDir?: string;
  bangumi?: import("./media/catalog-metadata.ts").MetadataSearcher;
  tmdb?: import("./media/catalog-metadata.ts").MetadataSearcher;
  fetchPoster?: (url: string) => Promise<{ contentType: string; bytes: Buffer } | undefined>;
  /** 枚举/分类同步等待的宽限期（毫秒），超过就回 202。默认 8000。 */
  syncGraceMs?: number;
  /** 上传字幕的 sqlite 路径；默认 `data/watchparty-subtitles.sqlite`（测试用 `:memory:`）。 */
  subtitleDbPath?: string;
  /** 游客凭据有效期（毫秒），默认 12 分钟。 */
  guestReadTtlMs?: number;
  /** 同一 IP 每分钟能签发多少张游客凭据，默认 30。 */
  guestIssueLimitPerMinute?: number;
};

export type Backend = {
  app: Express;
  httpServer: http.Server | https.Server;
  io: CoreServer;
  registry: RoomRegistry;
  host: string;
  get port(): number;
  start(): Promise<void>;
  close(): Promise<void>;
};

/**
 * Assemble Express + Socket.io + the in-memory room table.
 * Does not listen until start() is called.
 */
export function createBackend(options: CreateBackendOptions = {}): Backend {
  const cfg = options.config ?? loadConfig();
  const host = options.host ?? cfg.host;
  const requestedPort = options.port ?? cfg.port;
  const pruneIntervalMs = options.pruneIntervalMs ?? cfg.pruneIntervalMs;
  const idleTtlMs = options.idleTtlMs ?? cfg.roomIdleTtlMs;

  const app = express();
  // Caddy connects over loopback; forwarded clients must keep their own IP.
  app.set("trust proxy", "loopback");
  app.use(cors());
  // 字幕上传的 JSON 体天生比别处大：正文上限 512KB，而最坏情况（整篇控制字符）转义成
  // JSON 要胀到约 3MB。给 4MB 是为了让超限请求落到路由自己的 413 SUBTITLE_TOO_LARGE
  // （带 code），而不是 body-parser 那一个 HTML 413。全局 100KB 上限一字不动。
  const subtitleUploadJson = express.json({ limit: "4mb" });
  app.use((req, res, next) => {
    if (req.method === "POST" && SUBTITLE_UPLOAD_PATH.test(req.path)) {
      subtitleUploadJson(req, res, next);
      return;
    }
    next();
  });
  app.use(express.json());

  // 慢请求日志：桌面那条链路的客户端总超时是 15s（src-tauri/http.rs），所以"服务端到底在哪条
  // 请求上花时间"必须能在服务端这边看到，否则偶发 NETWORK_ERROR 只能靠猜。默认 1s 起报，
  // 设成 0 关掉。只打 path 不打 query —— item 键、凭据都可能出现在 query 里，而归属只需要路由。
  const slowRequestMs = Number(process.env.WATCHPARTY_SLOW_REQUEST_MS ?? 1_000);
  if (Number.isFinite(slowRequestMs) && slowRequestMs > 0) {
    app.use((req, res, next) => {
      const started = Date.now();
      res.on("finish", () => {
        const ms = Date.now() - started;
        if (ms >= slowRequestMs) console.log(`SLOW_REQUEST ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
      });
      next();
    });
  }

  const httpServer: http.Server | https.Server =
    cfg.sslKeyFile && cfg.sslCrtFile
      ? https.createServer(
          {
            key: fs.readFileSync(cfg.sslKeyFile),
            cert: fs.readFileSync(cfg.sslCrtFile),
          },
          app,
        )
      : new http.Server(app);

  // 桌面那条链路用的是 reqwest，池里空闲连接默认留 90s；Node 的 keepAliveTimeout 缺省只有 5s。
  // 服务端先悄悄关掉连接、客户端却不知道，下一条请求就写到一条死连接上 —— 表现是"隔几秒再打
  // 就 15s 超时"（harness 里 scan/delete 之后那条请求）。让服务端的空闲窗口比客户端长，
  // 客户端先关就没这个竞争。headersTimeout 必须更大，否则请求头还没收全就先被掐。
  httpServer.keepAliveTimeout = 120_000;
  httpServer.headersTimeout = 125_000;

  const io: CoreServer = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    cors: {},
    transports: ["polling", "websocket"],
    cleanupEmptyChildNamespaces: true,
  });

  const registry = new RoomRegistry({
    now: options.now,
    idleTtlMs,
  });

  // 未入房只读浏览用的游客凭据表。与房间表共用时钟，方便测试注入。
  const guests = new GuestAccessStore({
    now: options.now,
    ...(options.guestReadTtlMs !== undefined ? { ttlMs: options.guestReadTtlMs } : {}),
    ...(options.guestIssueLimitPerMinute !== undefined
      ? { issueLimit: options.guestIssueLimitPerMinute }
      : {}),
  });

  const media = createWatchpartyMedia(
    createOpenlistClient(cfg, {
      pingTimeoutMs: options.openlistPingTimeoutMs,
    }),
    {
      mediaIdKey: cfg.watchPartyMediaIdKey,
      internalBaseUrl: cfg.openlistUrl,
      publicBaseUrl: cfg.openlistPublicUrl || cfg.openlistUrl,
    },
  );

  const library = createLibraryService({
    cfg,
    dbPath: options.libraryDbPath,
    ...(options.catalogDbPath !== undefined ? { catalogDbPath: options.catalogDbPath } : {}),
    clientFactory: options.libraryClientFactory,
    trustLoopback: options.trustLibraryAdminLoopback,
    adminToken: options.libraryAdminToken,
    ...(options.catalogInline !== undefined ? { catalogInline: options.catalogInline } : {}),
    ...(options.catalogDelayMs !== undefined ? { catalogDelayMs: options.catalogDelayMs } : {}),
    ...(options.catalogMaxLookups !== undefined ? { catalogMaxLookups: options.catalogMaxLookups } : {}),
    ...(options.posterDir !== undefined ? { posterDir: options.posterDir } : {}),
    ...(options.catalogSidecarDir !== undefined ? { catalogSidecarDir: options.catalogSidecarDir } : {}),
    ...(options.bangumi !== undefined ? { bangumi: options.bangumi } : {}),
    ...(options.tmdb !== undefined ? { tmdb: options.tmdb } : {}),
    ...(options.fetchPoster !== undefined ? { fetchPoster: options.fetchPoster } : {}),
    ...(options.syncGraceMs !== undefined ? { syncGraceMs: options.syncGraceMs } : {}),
  });
  // Readiness keeps the original single-source media. Library ids are routed only to HTTP/native playback.
  const routedMedia = routeLibraryMedia(media, library);

  // 媒体级持久的上传字幕（POST /api/rooms/:roomId/media/subtitles）。
  const subtitles = createSubtitleStore({
    ...(options.subtitleDbPath !== undefined ? { dbPath: options.subtitleDbPath } : {}),
    nodeEnv: cfg.nodeEnv,
  });

  const readiness = createReadinessProbe({
    media,
    configStatus: () => cfg.configStatus,
    ...(options.readinessCacheTtlMs !== undefined
      ? { ttlMs: options.readinessCacheTtlMs }
      : {}),
  });
  const getListenerInfo = () => ({
    host,
    configuredPort: requestedPort,
    boundPort,
    secure: Boolean(cfg.sslKeyFile && cfg.sslCrtFile),
  });

  bindRooms(io, registry);

  // 守卫必须早于所有路由：带游客凭据的请求只能进只读白名单，其余路由在触达任何处理器
  // 之前就 403，不会因为某条路由忘了检查而漏出去。
  app.use(guestReadGuard(guests));

  registerLibraryHttp(app, library, registry, guests);
  registerCoreHttp(app, registry, cfg, routedMedia, subtitles);
  registerDesktopProbeHttp(app, { readiness, getListenerInfo });
  registerHandoffHttp(app, registry);
  registerDesktopLifecycleHttp(app, registry);
  registerNativeHandoffHttp(app, registry, "mpv");
  registerNativeHandoffHttp(app, registry, "desktop");
  registerNativeClientHttp(app, registry, routedMedia, "mpv", undefined, cfg.mediaPublicOrigins);
  registerNativeClientHttp(app, registry, routedMedia, "desktop", io, cfg.mediaPublicOrigins);

  const timers: NodeJS.Timeout[] = [];
  let closed = false;
  let boundPort = requestedPort;

  async function start(): Promise<void> {
    if (httpServer.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        httpServer.off("error", onError);
        reject(error);
      };
      httpServer.once("error", onError);
      httpServer.listen(requestedPort, host, () => {
        httpServer.off("error", onError);
        const address = httpServer.address();
        if (address && typeof address === "object") {
          boundPort = address.port;
        }
        resolve();
      });
    });
    if (pruneIntervalMs > 0) {
      const timer = setInterval(() => {
        registry.pruneIdle();
        guests.prune();
      }, pruneIntervalMs);
      timer.unref();
      timers.push(timer);
    }
  }

  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;
    library.close();
    subtitles.close();
    for (const timer of timers) {
      clearInterval(timer);
    }
    timers.length = 0;
    registry.destroyAll();
    if (!httpServer.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      io.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  return {
    app,
    httpServer,
    io,
    registry,
    host,
    get port() {
      return boundPort;
    },
    start,
    close,
  };
}
