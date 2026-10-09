/* E2E 测试媒体服务器：支持 Range、连接错误容错 */
const https = require("https");
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "test.mp4");

process.on("uncaughtException", (e) => console.error("uncaught:", e.message));

https.createServer({
  key: fs.readFileSync(path.join(__dirname, "key.pem")),
  cert: fs.readFileSync(path.join(__dirname, "cert.pem")),
}, (req, res) => {
  if (req.url === "/fail-direct") {
    // 阶段 3/5 验收：模拟直链失效（403），触发插件 DIRECT → FALLBACK 状态机
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("simulated direct link failure");
    return;
  }
  const file = req.url === "/short.mp4" ? path.join(__dirname, "short.mp4") : path.join(__dirname, "test.mp4");
  const stat = fs.statSync(file);
  const range = req.headers.range;
  const base = { "content-type": "video/mp4", "accept-ranges": "bytes" };
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : stat.size - 1;
    res.writeHead(206, {
      ...base,
      "content-range": `bytes ${start}-${end}/${stat.size}`,
      "content-length": end - start + 1,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...base, "content-length": stat.size });
    fs.createReadStream(file).pipe(res);
  }
}).listen(18443, () => console.log("https media server up on 18443 (range-capable)"));
