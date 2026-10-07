#!/usr/bin/env node
// Fault-injection proxy for the signed-URL 403 / renewal tests. TEST ONLY.
// Fronts the local Caddy fix chain (127.0.0.1:5397 -> OpenList 5349), can return 403 for a
// controlled number of probe or range requests, then passes everything through untouched.
// Usage: node verify/inject-proxy.mjs [listenPort=5398] [targetPort=5397]
// Control: GET /__inject?probe403=N | ?range403=N | ?reset=1 ; GET /__stats -> JSON counters
import { createServer, request } from "node:http";

const listenPort = Number(process.argv[2] ?? 5398);
const targetPort = Number(process.argv[3] ?? 5397);

let probe403 = 0;      // remaining probe-shaped requests (Range: bytes=0-65535) to reject
let range403 = 0;      // remaining range requests to reject
const stats = { total: 0, probe: 0, range: 0, injected403: 0, passthrough: 0, upstreamErrors: 0, fullBody200: 0, firstRequestAt: null };

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${listenPort}`);
  if (url.pathname === "/__inject") {
    if (url.searchParams.has("reset")) { probe403 = 0; range403 = 0; }
    if (url.searchParams.has("probe403")) probe403 = Number(url.searchParams.get("probe403")) || 0;
    if (url.searchParams.has("range403")) range403 = Number(url.searchParams.get("range403")) || 0;
    console.log(`[inject] probe403=${probe403} range403=${range403}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ probe403, range403 }) + "\n");
    return;
  }
  if (url.pathname === "/__stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(stats, null, 1) + "\n");
    return;
  }

  stats.total += 1;
  if (stats.firstRequestAt === null) stats.firstRequestAt = Date.now();
  const rangeHeader = req.headers.range;
  const isProbe = rangeHeader === "bytes=0-65535";
  if (isProbe) stats.probe += 1; else if (rangeHeader) stats.range += 1;

  if (isProbe && probe403 > 0) {
    probe403 -= 1;
    stats.injected403 += 1;
    console.log(`[inject] 403 injected for probe (${stats.injected403} total)`);
    res.writeHead(403, { "access-control-allow-origin": "*", "content-type": "text/plain" });
    res.end("injected 403\n");
    return;
  }
  if (!isProbe && rangeHeader && range403 > 0) {
    range403 -= 1;
    stats.injected403 += 1;
    console.log(`[inject] 403 injected for range ${rangeHeader} (${stats.injected403} total)`);
    res.writeHead(403, { "access-control-allow-origin": "*", "content-type": "text/plain" });
    res.end("injected 403\n");
    return;
  }

  const proxyReq = request(
    { host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${targetPort}` } },
    (proxyRes) => {
      stats.passthrough += 1;
      if (proxyRes.statusCode === 200 && Number(proxyRes.headers["content-length"] ?? 0) > 1_000_000) stats.fullBody200 += 1;
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (error) => {
    stats.upstreamErrors += 1;
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream error: ${error.message}\n`);
  });
  req.pipe(proxyReq);
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(`[inject] http://127.0.0.1:${listenPort} -> 127.0.0.1:${targetPort}`);
});
