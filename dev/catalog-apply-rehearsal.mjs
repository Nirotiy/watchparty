// 在**真实库的副本**上演练 apply：把 data/watchparty-catalog.sqlite 复制到临时目录，
// 在那里起后端、跑 apply、对比前后。你自己的库一行都不动。
// 跑法：node --experimental-strip-types dev/catalog-apply-rehearsal.mjs [lib_anime ...]
// 前置：先跑 dev/catalog-draft-check.mjs --judge 让草稿里有判定结果（这一步才打网络）。
// 脚本用 ?force=1：草稿没判完时默认会被 409 拒掉，这里要看的正是应用结果。
// 结构变更（建卡/删卡/换文件）要人工凭证：脚本先演示"裸 apply 被拒"，再自己签一张
// 批准凭证带上执行 —— 真库里这一步由人在服务端网页点，MCP/命令行拿不到批准权。
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
const call = async (route, body) => {
  const response = await fetch(`${base}/api/admin/media-libraries/${route}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

try {
  for (const id of libraries) {
    console.log(`\n${id} ———`);
    const bare = await call(`${id}/apply?force=1`);
    console.log(`  不带凭证 apply → HTTP ${bare.status}${bare.body?.code ? ` ${bare.body.code}` : ""}`);
    if (bare.body?.code === "CATALOG_APPROVAL_REQUIRED") {
      console.log(`  待批准的结构：＋${bare.body.structural.added.length} －${bare.body.structural.dropped.length} ↔${bare.body.structural.moved.length} ⚑${bare.body.structural.drift.length}`);
    }
    const approved = await call(`${id}/approval`, { approvedBy: "rehearsal" });
    let result = bare;
    let usedToken = null;
    if (approved.status === 200) {
      const token = approved.body.approvalToken;
      usedToken = token;
      result = await call(`${id}/apply-approved`, { approvalToken: token, force: 1 });
      console.log(`  网页批准 ${approved.body.approvalId}（${approved.body.expiresAt.slice(0, 16)} 过期）→ apply-approved HTTP ${result.status}`);
    } else if (approved.status !== 409) {
      console.log(`  批准失败：${JSON.stringify(approved.body)}`);
      continue;
    } else {
      console.log(`  没有结构要批准（${approved.body?.code}），直接用普通 apply 的结果`);
    }
    if (!result.body || result.status !== 200) {
      console.log(`  ${JSON.stringify(result.body)}`);
      continue;
    }
    const body = result.body;
    const ledger = (() => {
      const reader = new DatabaseSync(path.join(workDir, "data", "watchparty-catalog.sqlite"), { readOnly: true });
      try {
        const row = reader.prepare("SELECT id, length(undo_json) bytes, undo_json FROM catalog_approvals WHERE library_id = ? AND used_at IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(id);
        if (!row || !row.bytes) return null;
        const undo = JSON.parse(row.undo_json);
        return { id: row.id, bytes: row.bytes, keys: undo.keys.length, created: undo.counts.created, removed: undo.counts.removed, changed: undo.counts.changed };
      } finally {
        reader.close();
      }
    })();
    console.log(
      `  回滚台账：${ledger ? `${ledger.id} ${Math.round(ledger.bytes / 1024)}KB，覆盖 ${ledger.keys} 个键位（建 ${ledger.created} / 删 ${ledger.removed} / 改 ${ledger.changed}）` : "本次没有结构变更，不留台账"}`,
    );
    console.log(`  草稿 ${body.cards} 张 ⇒ 新建 ${body.created} / 写判定 ${body.updated} / 跳过人工 ${body.skipped} / 未判定不动绑定 ${body.deferred} / 待抓海报 ${body.posters}`);
    console.log(ledger ? `  回滚台账 ${ledger.id}：${ledger.bytes} 字节，覆盖 ＋${ledger.created} －${ledger.removed} ✎${ledger.changed}` : "  这次没有结构变更，不留台账");
    const d = body.diff;
    console.log(`  应用后差异：一致 ${d.unchanged} ＋${d.added.length} －${d.dropped.length} ↔${d.moved.length} ✎${d.changed.length} ⚑${d.confirmedDrift.length}（自动确认 ${d.autoConfirmed}）`);
    const again = await call(`${id}/apply?force=1`);
    const replay = await call(`${id}/apply-approved`, { approvalToken: usedToken ?? "0000000000000000000000000000", force: 1 });
    console.log(`  再 apply 一次：HTTP ${again.status}${again.body?.code ? ` ${again.body.code}` : ""}，新建 ${again.body?.created ?? "-"} / 写判定 ${again.body?.updated ?? "-"} ⇒ 幂等${again.body?.created === 0 ? "成立" : again.status === 200 ? "**不成立**" : "未验证（被守卫拒了）"}`);
    console.log(`  凭证重放必须被拒：${replay.body?.code} ${replay.body?.reason ?? ""}`);
  }
  stats("应用后");
} finally {
  await backend.close();
}
console.log(`\n临时副本留着自查：${workDir}`);
console.log("确认没问题再对真库执行：先 POST .../approval 拿一次性凭证，再 POST .../apply-approved。");
