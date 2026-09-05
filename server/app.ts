import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import cors from "cors";
import express, { type Express } from "express";
import { Server } from "socket.io";
import { loadConfig, type AppConfig } from "./config.ts";
import { registerCoreHttp } from "./core/http/routes.ts";
import {
  registerHandoffHttp,
  registerDesktopLifecycleHttp,
  registerNativeClientHttp,
  registerNativeHandoffHttp,
} from "./core/http/native-routes.ts";
import { createWatchpartyMedia } from "./media/watchparty-media.ts";
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

  const media = createWatchpartyMedia(createOpenlistClient(cfg), {
    mediaIdKey: cfg.watchPartyMediaIdKey,
    internalBaseUrl: cfg.openlistUrl,
    publicBaseUrl: cfg.openlistPublicUrl || cfg.openlistUrl,
  });

  bindRooms(io, registry);

  registerCoreHttp(app, registry, cfg, media);
  registerHandoffHttp(app, registry);
  registerDesktopLifecycleHttp(app, registry);
  registerNativeHandoffHttp(app, registry, "mpv");
  registerNativeHandoffHttp(app, registry, "desktop");
  registerNativeClientHttp(app, registry, media, "mpv");
  registerNativeClientHttp(app, registry, media, "desktop", io);

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
