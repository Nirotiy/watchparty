import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import cors from "cors";
import express, { type Express } from "express";
import { Server } from "socket.io";
import { loadConfig, type AppConfig } from "./config.ts";
import { registerCoreHttp } from "./core/http/routes.ts";
import { createReadinessProbe } from "./core/http/readiness.ts";
import {
  registerHandoffHttp,
  registerDesktopLifecycleHttp,
  registerDesktopProbeHttp,
  registerNativeClientHttp,
  registerNativeHandoffHttp,
} from "./core/http/native-routes.ts";
import { registerLibraryHttp } from "./core/http/library-routes.ts";
import { createWatchpartyMedia } from "./media/watchparty-media.ts";
import { createLibraryService, routeLibraryMedia, type LibraryClientFactory } from "./media/library-service.ts";
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
  serveStatic?: boolean;
  /** Setup-guide readiness cache TTL; 0 disables caching. */
  readinessCacheTtlMs?: number;
  /** Override the OpenList readiness ping budget (ms); default 2000. */
  openlistPingTimeoutMs?: number;
  /** sqlite file for media sources. Defaults to :memory: when NODE_ENV=test. */
  libraryDbPath?: string;
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
  bangumi?: import("./media/catalog-metadata.ts").MetadataSearcher;
  tmdb?: import("./media/catalog-metadata.ts").MetadataSearcher;
  fetchPoster?: (url: string) => Promise<{ contentType: string; bytes: Buffer } | undefined>;
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
  app.use(cors());
  app.use(express.json());

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
    clientFactory: options.libraryClientFactory,
    trustLoopback: options.trustLibraryAdminLoopback,
    adminToken: options.libraryAdminToken,
    ...(options.catalogInline !== undefined ? { catalogInline: options.catalogInline } : {}),
    ...(options.catalogDelayMs !== undefined ? { catalogDelayMs: options.catalogDelayMs } : {}),
    ...(options.catalogMaxLookups !== undefined ? { catalogMaxLookups: options.catalogMaxLookups } : {}),
    ...(options.posterDir !== undefined ? { posterDir: options.posterDir } : {}),
    ...(options.bangumi !== undefined ? { bangumi: options.bangumi } : {}),
    ...(options.tmdb !== undefined ? { tmdb: options.tmdb } : {}),
    ...(options.fetchPoster !== undefined ? { fetchPoster: options.fetchPoster } : {}),
  });
  // Readiness keeps the original single-source media. Library ids are routed only to HTTP/native playback.
  const routedMedia = routeLibraryMedia(media, library);

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

  registerLibraryHttp(app, library);
  registerCoreHttp(app, registry, cfg, routedMedia);
  registerDesktopProbeHttp(app, { readiness, getListenerInfo });
  registerHandoffHttp(app, registry);
  registerDesktopLifecycleHttp(app, registry);
  registerNativeHandoffHttp(app, registry, "mpv");
  registerNativeHandoffHttp(app, registry, "desktop");
  registerNativeClientHttp(app, registry, routedMedia, "mpv");
  registerNativeClientHttp(app, registry, routedMedia, "desktop", io);

  if (options.serveStatic !== false) {
    mountLegacyUi(app, cfg.buildDirectory);
  }

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

function mountLegacyUi(app: Express, buildDirectory: string): void {
  const buildDir = path.resolve(import.meta.dirname, "..", buildDirectory);
  if (!fs.existsSync(buildDir)) {
    return;
  }
  const indexFile = path.join(buildDir, "index.html");
  app.use(express.static(buildDir));
  const sendIndex: express.RequestHandler = (_req, res) => {
    res.sendFile(indexFile);
  };
  app.get("/", sendIndex);
  app.get("/watch/*splat", sendIndex);
}
