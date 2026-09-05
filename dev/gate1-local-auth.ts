// Loopback-only manual acceptance fixture. All credentials and rooms are disposable.
import { createServer, request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { createBackend } from "../server/app.ts";
import { loadConfig } from "../server/config.ts";

const backend = createBackend({ host: "127.0.0.1", port: 0, serveStatic: false,
  config: loadConfig({ NODE_ENV: "test", WATCHPARTY_MEDIA_ID_KEY: "gate1-local-test-only" }) });
await backend.start();
const origin = `http://127.0.0.1:${backend.port}`;
const expected = `Basic ${Buffer.from("watchparty-test:gate1-local-only").toString("base64")}`;
const proxy = createServer(async (req, res) => {
  if (req.headers.authorization !== expected) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Gate 1 local test"' }); res.end(); return;
  }
  if (req.url === "/gate1/ticket" && req.method === "GET") {
    try {
      const created = await fetch(`${origin}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: randomUUID(), nickname: "Gate1 test" }) });
      const room = await created.json() as { roomId: string; accessToken: string };
      const handoff = await fetch(`${origin}/api/rooms/${room.roomId}/handoff`, { method: "POST",
        headers: { "content-type": "application/json", "X-WatchParty-Token": room.accessToken },
        body: JSON.stringify({ target: "desktop" }) });
      res.writeHead(handoff.status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(await handoff.text());
    } catch { res.writeHead(502); res.end(); }
    return;
  }
  const headers = { ...req.headers };
  delete headers.authorization;
  const upstream = httpRequest(`${origin}${req.url}`, { method: req.method, headers }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
  });
  upstream.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
proxy.listen(18080, "127.0.0.1", () => console.log("Gate 1 fixture ready on loopback port 18080"));
async function stop() { proxy.closeAllConnections(); proxy.close(); await backend.close(); }
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
