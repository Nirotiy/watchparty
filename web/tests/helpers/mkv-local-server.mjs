// Isolated browser fixture: localhost only, in-memory stores, no real OpenList calls.
// node web/tests/helpers/mkv-local-server.mjs <local MKV> [backendPort] [mediaPort]
import { createReadStream } from "node:fs";
import { stat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { io } from "socket.io-client";
import { createBackend } from "../../../server/app.ts";
import { loadConfig } from "../../../server/config.ts";

const filename = process.argv[2];
if (!filename) throw new Error("Pass a local MKV fixture");
const mediaFile = path.resolve(filename);
const info = await stat(mediaFile);
const backendPort = Number(process.argv[3] ?? 18981);
const mediaPort = Number(process.argv[4] ?? 18983);
const directory = await mkdtemp(path.join(tmpdir(), "next-mkv-fixture-"));
const mediaOrigin = `http://127.0.0.1:${mediaPort}`;
const metrics = { requests: 0, bytes: 0, fullRequests: 0, resolveCalls: 0, expired: 0 };
let generation = 0;
let expiredGeneration = -1;
let stallUntil = 0;
const mediaServer = createServer((req, res) => {
  if (Date.now() < stallUntil && req.method !== "OPTIONS") {
    const timer = setTimeout(() => serveMedia(req, res), stallUntil - Date.now());
    res.once("close", () => clearTimeout(timer));
    return;
  }
  serveMedia(req, res);
});
function serveMedia(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Range, If-Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, ETag");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  if (new URL(req.url, mediaOrigin).searchParams.get("generation") === String(expiredGeneration)) {
    metrics.expired += 1; res.writeHead(403).end(); return;
  }
  const match = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
  if (!match) { metrics.fullRequests += 1; res.writeHead(416).end(); return; }
  const start = Number(match[1]);
  const end = Math.min(info.size - 1, Number(match[2]));
  if (start > end) { res.writeHead(416).end(); return; }
  metrics.requests += 1; metrics.bytes += end - start + 1;
  res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${info.size}`,
    "Content-Length": end - start + 1, "Content-Type": "video/x-matroska", "Accept-Ranges": "bytes", ETag: '"fixture"' });
  const stream = createReadStream(mediaFile, { start, end });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
await new Promise((resolve) => mediaServer.listen(mediaPort, "127.0.0.1", resolve));
const backend = createBackend({
  host: "127.0.0.1", port: backendPort, pruneIntervalMs: 0,
  libraryDbPath: ":memory:", catalogDbPath: ":memory:",
  posterDir: path.join(directory, "posters"), catalogSidecarDir: path.join(directory, "sidecars"),
  config: loadConfig({ NODE_ENV: "test", OPENLIST_URL: mediaOrigin,
    OPENLIST_USERNAME: "fixture", OPENLIST_PASSWORD: "fixture", WATCHPARTY_MEDIA_ID_KEY: "mkv-fixture-only" }),
  libraryClientFactory: () => ({
    list: async (root) => ({ code: 200, data: { content: [
      { name: "marks.mkv", is_dir: false, size: info.size, path: `${root}/marks.mkv` },
    ] } }),
    listShallow: async () => ({ code: 200, data: { content: [] } }),
    search: async () => ({ code: 200, data: { content: [] } }),
    getDownloadInfo: async () => {
      metrics.resolveCalls += 1;
      return { url: `${mediaOrigin}/media?generation=${generation++}`, size: info.size };
    },
    getLinkInfo: async () => null,
    fetchOriginText: async () => undefined,
    ping: async () => ({ ok: true }),
  }),
});
await backend.start();
const base = `http://127.0.0.1:${backend.port}`;
const ownerId = randomUUID();
const room = await (await fetch(`${base}/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ clientId: ownerId, nickname: "Fixture" }) })).json();
const client = io(base, { transports: ["websocket"], auth: { roomId: room.roomId, clientId: ownerId,
  accessToken: room.accessToken, ownerToken: room.ownerToken, clientProtocol: 2 } });
let snapshot;
client.on("REC:snapshot", (value) => { snapshot = value; });
await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("connect_error", reject); });
const page = await (await fetch(`${base}/api/media/list?libraryId=lib_anime`, {
  headers: { "x-watchparty-room": room.roomId, "x-watchparty-token": room.accessToken },
})).json();
const source = { kind: "openlist", mediaId: page.items[0].id, title: "MKV fixture", container: "mkv" };
backend.app.get("/__fixture", (_req, res) => res.json({ room, ownerId, source, metrics, snapshot }));
backend.app.post("/__fixture/command", async (req, res) => {
  const allowed = ["CMD:mediaSet", "CMD:play", "CMD:pause", "CMD:seek", "CMD:rate"];
  if (!allowed.includes(req.body.event)) { res.status(400).end(); return; }
  const payload = { ...req.body.payload, expectedRevision: snapshot?.revision };
  if (req.body.event === "CMD:mediaSet" && !payload.media) payload.media = source;
  const ack = await new Promise((resolve) => client.emit(req.body.event, payload, resolve));
  res.json(ack);
});
backend.app.post("/__fixture/expire", (_req, res) => { expiredGeneration = generation - 1; res.json({ ok: true }); });
backend.app.post("/__fixture/stall", (req, res) => {
  const durationMs = Math.min(10000, Math.max(0, Number(req.body.durationMs) || 0));
  stallUntil = Date.now() + durationMs;
  res.json({ ok: true });
});
console.log(`Local MKV fixture backend ${base}, media ${mediaOrigin}, room ${room.roomId}`);
async function close() {
  client.disconnect();
  await backend.close();
  mediaServer.closeAllConnections();
  await new Promise((resolve) => mediaServer.close(resolve));
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
