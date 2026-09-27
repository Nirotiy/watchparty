// 运维脚本：用**当前代码**对现库做一次重扫（会删非 confirmed 行的候选与封面行）。
// 端口 0 = 临时端口，不抢前端在用的 :8080；管理接口走环回信任。
// 跑法：NODE_USE_ENV_PROXY=1 node --experimental-strip-types dev/catalog-rescan.mjs
import { createBackend } from "../server/app.ts";

const libraries = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["lib_anime", "lib_film", "lib_tv"];
// Bangumi 匿名限速约 60 req/min，每次 search 打两发（type 2 + type 6）；1.2s 足够不撞墙。
const backend = createBackend({ port: 0, catalogInline: true, catalogDelayMs: 1_200 });
await backend.start();
const base = `http://127.0.0.1:${backend.port}`;
console.log(`rescan backend on ${base}`);

for (const id of libraries) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${base}/api/admin/media-libraries/${id}/scrape`, { method: "POST" });
  } catch (error) {
    console.log(`${id} POST 失败:`, error instanceof Error ? error.message : error);
    continue;
  }
  const body = await response.text();
  console.log(`${id} HTTP ${response.status} ${Math.round((Date.now() - started) / 1000)}s ${body.slice(0, 240)}`);
}

await backend.close();
console.log("closed");
