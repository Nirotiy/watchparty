// 只刷新快照：枚举 OpenList 存进 catalog_scan，不分组、不刮削、不动任何卡。
// 跑法：NODE_USE_ENV_PROXY=1 node --experimental-strip-types dev/catalog-snapshot.mjs [lib_anime ...]
import { createBackend } from "../server/app.ts";

const libraries = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["lib_anime", "lib_film", "lib_tv"];
const backend = createBackend({ port: 0 });
await backend.start();
const base = `http://127.0.0.1:${backend.port}`;
for (const id of libraries) {
  const started = Date.now();
  const response = await fetch(`${base}/api/admin/media-libraries/${id}/scan`, { method: "POST" });
  const body = await response.text();
  console.log(`${id} HTTP ${response.status} ${((Date.now() - started) / 1000).toFixed(1)}s ${body.slice(0, 160)}`);
}
await backend.close();
