import { createServer, request } from "node:http";

// Simulation proxy: stands in for the deployment-side fix (Caddy header_down / patched OpenList).
// Forwards byte-for-byte to the local OpenList and adds Access-Control-Expose-Headers,
// so the POC can read Content-Range/Accept-Ranges/ETag. TEST ONLY - not part of the product path.
// Usage: node verify/openlist-header-proxy.mjs [listenPort] [targetPort]
const listenPort = Number(process.argv[2] ?? 5399);
const targetPort = Number(process.argv[3] ?? 5349);

let requests = 0;
let bytesIn = 0;

const server = createServer((req, res) => {
  requests += 1;
  const proxyReq = request(
    { host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers: req.headers },
    (proxyRes) => {
      const headers = { ...proxyRes.headers };
      headers["access-control-expose-headers"] = "Content-Range, Accept-Ranges, ETag, Content-Length";
      if (!headers["access-control-allow-origin"]) headers["access-control-allow-origin"] = "*";
      res.writeHead(proxyRes.statusCode ?? 502, headers);
      proxyRes.on("data", (chunk) => { bytesIn += chunk.length; });
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (error) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(String(error));
  });
  req.pipe(proxyReq);
});

server.listen(listenPort, "127.0.0.1", () => {
  process.stdout.write(`openlist expose-header sim proxy :${listenPort} -> 127.0.0.1:${targetPort}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    process.stdout.write(`proxy stats: requests=${requests} bytes=${bytesIn}\n`);
    server.close(() => process.exit(0));
  });
}
