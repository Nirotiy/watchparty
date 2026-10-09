/* 假 OpenList（阶段 3/5 验收）：fs/link 返回必失败的直链，fs/get 返回可用的 /p/ 回退
 * 用法：node openlist-fake.cjs  （监听 18095）
 * 配套后端环境：OPENLIST_URL=http://127.0.0.1:18095 OPENLIST_PUBLIC_URL=https://127.0.0.1:18443
 */
const http = require("http");

const DIRECT_URL = "https://127.0.0.1:18443/fail-direct";
const FALLBACK_URL = "https://127.0.0.1:18443/p/video.mp4";

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/api/auth/login") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 200, data: { token: "fake-token" } }));
      return;
    }
    if (req.url === "/api/fs/get") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 200, data: { raw_url: FALLBACK_URL, size: 374831 } }));
      return;
    }
    if (req.url === "/api/fs/link") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        code: 200,
        data: { url: DIRECT_URL, header: { "User-Agent": "pan.baidu.com" } },
      }));
      return;
    }
    if (req.url === "/api/fs/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        code: 200,
        data: { content: [{ name: "video.mp4", is_dir: false, size: 374831, path: "/media/openlist-bdyun/Multimedia/Anime/video.mp4" }] },
      }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
}).listen(18095, () => console.log("fake openlist on 18095 (direct always fails, fallback works)"));
