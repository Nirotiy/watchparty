// 在**真实库的副本**上演练 apply：把 data/watchparty-catalog.sqlite 复制到临时目录，
// 在那里起后端、跑 apply、对比前后。你自己的库一行都不动。
// 跑法：node --experimental-strip-types dev/catalog-apply-rehearsal.mjs [lib_anime ...]
// 前置：先跑 dev/catalog-draft-check.mjs --judge 让草稿里有判定结果（这一步才打网络）。
// 脚本用 ?force=1：草稿没判完时默认会被 409 拒掉，这里要看的正是应用结果。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBackend } from "../server/app.ts";

const source = path.join(process.cwd(), "data", "watchparty-catalog.sqlite");
const libraries = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["lib_anime", "lib_tv", "lib_film"];
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-apply-rehearsal-"));
fs.mkdirSync(path.join(workDir, "data"), { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  const from = `${source}${suffix}`;
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(workDir, "data", `watchparty-catalog.sqlite${suffix}`));
}
process.chdir(workDir);
console.log(`副本：${path.join(workDir, "data", "watchparty-catalog.sqlite")}（原库只读，不动）`);

function stats(label) {
  const db = new DatabaseSync(path.join(workDir, "data", "watchparty-catalog.sqlite"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT library_id, status, COUNT(*) n FROM catalog_items GROUP BY library_id, status").all();
    const byLibrary = new Map();
    for (const row of rows) byLibrary.set(row.library_id, { ...(byLibrary.get(row.library_id) ?? {}), [row.status]: row.n });
    const children = db.prepare("SELECT library_id, COUNT(*) n FROM catalog_children c JOIN catalog_items i ON i.id = c.item_id GROUP BY library_id").all();
    for (const row of children) byLibrary.set(row.library_id, { ...(byLibrary.get(row.library_id) ?? {}), files: row.n });
    console.log(`  ${label}: ${[...byLibrary.entries()].map(([id, s]) => `${id} ${JSON.stringify(s)}`).join("  ")}`);
  } finally {
    db.close();
  }
}

stats("应用前");

const backend = createBackend({ port: 0, serveStatic: false, fetchPoster: async () => undefined });
await backend.start();
const base = `http://127.0.0.1:${backend.port}`;
try {
  for (const id of libraries) {
    const response = await fetch(`${base}/api/admin/media-libraries/${id}/apply?force=1`, { method: "POST" });
    const body = await response.json();
    console.log(`\n${id} apply → HTTP ${response.status}`);
    if (!response.ok) {
      console.log(`  ${JSON.stringify(body)}`);
      continue;
    }
    console.log(`  草稿 ${body.cards} 张 ⇒ 新建 ${body.created} / 写判定 ${body.updated} / 跳过人工 ${body.skipped} / 未判定不动绑定 ${body.deferred} / 待抓海报 ${body.posters}`);
    const d = body.diff;
    console.log(`  应用后差异：一致 ${d.unchanged} ＋${d.added.length} －${d.dropped.length} ↔${d.moved.length} ✎${d.changed.length} ⚑${d.confirmedDrift.length}（自动确认 ${d.autoConfirmed}）`);
    const again = await (await fetch(`${base}/api/admin/media-libraries/${id}/apply?force=1`, { method: "POST" })).json();
    console.log(`  再 apply 一次：新建 ${again.created} / 写判定 ${again.updated} ⇒ 幂等${again.created === 0 ? "成立" : "**不成立**"}`);
  }
  stats("应用后");
} finally {
  await backend.close();
}
console.log(`\n临时副本留着自查：${workDir}`);
console.log(`确认没问题再对真库执行：curl -s --noproxy '*' -X POST http://127.0.0.1:8080/api/admin/media-libraries/<id>/apply`);
