// Loopback-only real backend and global media throughput limiter for Next acceptance.
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBackend } from "../../../server/app.ts";
import { loadConfig } from "../../../server/config.ts";

const manifest = JSON.parse(await readFile(process.argv[2], "utf8"));
const files = await Promise.all(manifest.files.map(async (item) => ({ ...item,
  filename: path.join(manifest.directory, item.file), size: (await stat(path.join(manifest.directory, item.file))).size })));
const backendPort = Number(process.env.WATCHPARTY_TEST_BACKEND_PORT ?? 18981);
const mediaPort = Number(process.env.WATCHPARTY_TEST_MEDIA_PORT ?? 18983);
const origin = `http://127.0.0.1:${mediaPort}`;
let limit = 0, nextSend = 0;
const waits = new Set();
const resolveDelays = new Map();
const failedMedia = new Set();
const metrics = { fullRequests: 0, requests: 0, sentBytes: 0, resolveCalls: [], transfers: [] };
async function pace(bytes) {
  if (!limit) return;
  nextSend = Math.max(nextSend, Date.now()) + bytes / limit * 1000;
  await new Promise((resolve) => {
    const done = () => { clearTimeout(timer); waits.delete(done); resolve(); };
    const timer = setTimeout(done, Math.max(0, nextSend - Date.now()));
    waits.add(done);
  });
}
const media = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Range, If-Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, ETag");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  const url = new URL(req.url, origin);
  const item = files.find((file) => file.name === url.searchParams.get("name"));
  if (!item) { res.writeHead(404).end(); return; }
  if (failedMedia.has(item.name)) { res.writeHead(503).end(); return; }
  if (!item.name.endsWith(".mkv")) { res.end(await readFile(item.filename)); return; }
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
  if (!range) { metrics.fullRequests++; res.writeHead(416).end(); return; }
  const start = Number(range[1]), end = Math.min(item.size - 1, Number(range[2]));
  if (start > end) { res.writeHead(416).end(); return; }
  metrics.requests++;
  res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${item.size}`, "Content-Length": end - start + 1,
    "Content-Type": "video/x-matroska", ETag: `"${item.name}"` });
  const stream = createReadStream(item.filename, { start, end, highWaterMark: 16384 });
  res.once("close", () => stream.destroy());
  try {
    for await (const chunk of stream) {
      await pace(chunk.length);
      if (res.destroyed) break;
      metrics.sentBytes += chunk.length;
      if (!res.write(chunk)) await new Promise((resolve) => {
        const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
        res.once("drain", done); res.once("close", done);
      });
    }
    if (!res.destroyed) res.end();
  } catch { res.destroy(); }
});
await new Promise((resolve) => media.listen(mediaPort, "127.0.0.1", resolve));
const backend = createBackend({ host: "127.0.0.1", port: backendPort, pruneIntervalMs: 0,
  libraryDbPath: ":memory:", catalogDbPath: ":memory:",
  posterDir: path.join(manifest.directory, "posters"), catalogSidecarDir: path.join(manifest.directory, "sidecars"),
  config: loadConfig({ NODE_ENV: "test", OPENLIST_URL: origin, OPENLIST_USERNAME: "fixture", OPENLIST_PASSWORD: "fixture", WATCHPARTY_MEDIA_ID_KEY: "scenario-fixture-only" }),
  libraryClientFactory: () => ({
    list: async (root) => ({ code: 200, data: { content: files.map((item) => ({ name: item.name, is_dir: false, size: item.size, path: `${root}/${item.name}` })) } }),
    listShallow: async () => ({ code: 200, data: { content: [] } }), search: async () => ({ code: 200, data: { content: [] } }),
    getDownloadInfo: async (filepath) => {
      const item = files.find((file) => file.name === path.posix.basename(filepath));
      if (!item) return null;
      if (resolveDelays.has(item.name)) await new Promise((resolve) => setTimeout(resolve, resolveDelays.get(item.name)));
      metrics.resolveCalls.push(item.name);
      return { url: `${origin}/media?name=${encodeURIComponent(item.name)}`, size: item.size };
    },
    getLinkInfo: async () => null,
    fetchOriginText: async (url) => { const response = await fetch(url); return { status: response.status, text: await response.text() }; },
    ping: async () => ({ ok: true }),
  }),
});
await backend.start();
const base = `http://127.0.0.1:${backendPort}`, ownerId = randomUUID();
const room = await (await fetch(`${base}/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: ownerId, nickname: "Fixture owner" }) })).json();
const core = backend.registry.get(room.roomId);
const page = await (await fetch(`${base}/api/media/list?libraryId=lib_anime`, { headers: { "x-watchparty-room": room.roomId, "x-watchparty-token": room.accessToken } })).json();
const sources = Object.fromEntries(page.items.filter((item) => item.name.endsWith(".mkv")).map((item) => [item.name,
  { kind: "openlist", mediaId: item.id, title: item.name, container: "mkv" }]));
backend.app.get("/__fixture", (_req, res) => res.json({ room, ownerId, sources, snapshot: core.snapshot(), metrics, limitedBytesPerSecond: limit }));
backend.app.post("/__fixture/command", (req, res) => {
  // Fixture setup uses the real room reducer. User operations are tested through actual browser Socket callbacks.
  const { type, ...payload } = req.body;
  if (!["mediaSet", "play", "pause", "seek", "rate", "loop", "playlistAdd", "playlistRemove", "playlistPlay", "playlistNext"].includes(type)) { res.status(400).end(); return; }
  res.json(core.execute(ownerId, { type, ...payload }, core.snapshot().revision, true));
});
backend.app.post("/__fixture/limit", (req, res) => {
  limit = Math.max(0, Math.min(100000000, Number(req.body.bytesPerSecond) || 0));
  nextSend = Date.now();
  for (const done of waits) done();
  res.json({ bytesPerSecond: limit, sentBytes: metrics.sentBytes, epoch: Date.now() });
});
backend.app.post("/__fixture/drop", (req, res) => {
  let closed = 0;
  for (const socket of backend.io.sockets.sockets.values()) if (socket.data.clientId === req.body.clientId) {
    socket.conn.close(); closed++;
  }
  res.json({ closed });
});
backend.app.post("/__fixture/resolve-delay", (req, res) => {
  resolveDelays.clear();
  for (const [name, delay] of Object.entries(req.body)) resolveDelays.set(name, Math.min(3000, Math.max(0, Number(delay) || 0)));
  res.json({ ok: true });
});
backend.app.post("/__fixture/media-failure", (req, res) => {
  failedMedia.clear();
  for (const name of req.body.names ?? []) failedMedia.add(name);
  res.json({ names: [...failedMedia] });
});
console.log(`Scenario fixture ${base}; media ${origin}`);
async function close() {
  for (const done of waits) done();
  await backend.close(); media.closeAllConnections();
  await new Promise((resolve) => media.close(resolve));
  process.exit(0);
}
backend.app.post("/__fixture/close", (_req, res) => { res.json({ ok: true }); setTimeout(() => void close(), 50); });
process.on("SIGINT", close); process.on("SIGTERM", close);
