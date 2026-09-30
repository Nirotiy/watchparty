// 在**真实库的副本**上查一件事：把人确认的空壳卡并掉之后，apply 的结构差异会不会收敛到 0。
// 只读原库；所有写操作都发生在临时目录里的副本上。
// 跑法：node --experimental-strip-types dev/catalog-dropped-triage.mjs [lib_anime] [--merge]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBackend } from "../server/app.ts";

const source = path.join(process.cwd(), "data", "watchparty-catalog.sqlite");
const libraryId = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "lib_anime";
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-dropped-triage-"));
fs.mkdirSync(path.join(workDir, "data"), { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  const from = `${source}${suffix}`;
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(workDir, "data", `watchparty-catalog.sqlite${suffix}`));
}
const copy = path.join(workDir, "data", "watchparty-catalog.sqlite");
process.chdir(workDir);
console.log(`副本：${copy}`);

function stats(label) {
  const db = new DatabaseSync(copy, { readOnly: true });
  try {
    const cards = db.prepare("SELECT COUNT(*) n FROM catalog_items WHERE library_id = ?").get(libraryId).n;
    const files = db.prepare("SELECT COUNT(*) n FROM catalog_children c JOIN catalog_items i ON i.id = c.item_id WHERE i.library_id = ?").get(libraryId).n;
    const human = db.prepare("SELECT COUNT(*) n FROM catalog_items WHERE library_id = ? AND confirmed_by IN ('manual','rebind','unknown')").get(libraryId).n;
    console.log(`  ${label}: 正式卡 ${cards} 张（人工决定 ${human} 张）/ 卡上文件 ${files} 个`);
  } finally {
    db.close();
  }
}

// 这个脚本起的是**副本**后端：要演练的是 apply 语义，不是批准密钥。
// 注意 import 比 chdir 先执行，所以 `server/config.ts` 已经把真 .env 读进 process.env 了 ——
// 这里显式清空，让副本实例待在没有密钥的世界（软边界）。脚本永远不持有那把真密钥。
process.env.WATCHPARTY_CATALOG_APPROVAL_SECRET = "";

const backend = createBackend({ port: 0, serveStatic: false, fetchPoster: async () => undefined });
await backend.start();
const base = `http://127.0.0.1:${backend.port}`;
const post = async (route, body) => {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { status: response.status, body: await response.json().catch(() => null) };
};

try {
  stats("现状");
  const before = await post(`/api/admin/media-libraries/${libraryId}/apply`);
  const structural = before.body?.structural ?? {};
  console.log(`\n裸 apply → ${before.status} ${before.body?.code ?? ""}`);
  console.log(`  结构：＋${structural.added?.length ?? "-"} －${structural.dropped?.length ?? "-"} ↔${structural.moved?.length ?? "-"} ⚑${structural.drift?.length ?? "-"}`);
  const view = await (await fetch(`${base}/api/admin/media-libraries/${libraryId}/classify`)).json();
  console.log(`  草稿 ${view.cards} 张 / 快照 ${view.scan.files} 个文件；草稿没覆盖到的正式卡：`);
  for (const row of view.diff.dropped) {
    console.log(`   - ${row.title}`);
    console.log(`     键位 ${row.itemKey.slice(0, 72)}…`);
    console.log(`     ${row.files} 个文件里 ${row.missingPaths} 个的路径已不在快照中 → 同名文件现在落在：${row.suggestedKeys.join(" , ") || "（没有卡接手）"}`);
  }
  if (!process.argv.includes("--merge") && !process.argv.includes("--unconfirm")) {
    console.log("\n（只报告。--merge 把草稿没覆盖的卡并进接手卡；--unconfirm 撤掉它们的人工确认再 apply，看哪条路能让差异收敛）");
  } else if (process.argv.includes("--unconfirm")) {
    for (const row of view.diff.dropped) {
      const back = await post(`/api/media/catalog/${row.id}/unconfirm`);
      console.log(`  撤销 ${row.id}（${row.title}）的人工确认 → HTTP ${back.status}`);
    }
    stats("撤销之后");
    const first = await post(`/api/admin/media-libraries/${libraryId}/apply?force=1`);
    console.log(`  带凭证都还没给，先裸 apply → ${first.status} ${first.body?.code ?? ""} ${JSON.stringify(first.body?.structural ?? "")}`);
    if (first.body?.code === "CATALOG_APPROVAL_REQUIRED") {
      const granted = await post(`/api/admin/media-libraries/${libraryId}/approval`, { approvedBy: "triage" });
      if (granted.status !== 200 || !granted.body?.approvalToken) {
        // 拿不到凭证就停手：不拿着 undefined 去撞 apply-approved，那只会留下一行看不懂的 401。
        // 真库里这一步本来就该由人在界面点，脚本不持有批准密钥。
        console.log(`  批准没拿到（${granted.status} ${granted.body?.code ?? ""}）⇒ 停在这里。副本上可用不带密钥的实例重跑；真库请人在网页/桌面点批准。`);
      } else {
        const applied = await post(`/api/admin/media-libraries/${libraryId}/apply-approved`, { approvalToken: granted.body.approvalToken, force: 1 });
        console.log(`  批准 ${granted.body?.approvalId} → apply-approved ${applied.status} ${applied.body?.code ?? ""}，新建 ${applied.body?.created} / 写判定 ${applied.body?.updated} / 跳过人工 ${applied.body?.skipped}`);
        stats("批准并应用之后");
        const again = await post(`/api/admin/media-libraries/${libraryId}/apply?force=1`);
        console.log(`  再裸 apply → ${again.status} ${again.body?.code ?? ""}（200 ⇒ 结构差异真的收敛了）`);
      }
    }
  } else {
    const reader = new DatabaseSync(copy, { readOnly: true });
    const idForKey = (key) => reader.prepare("SELECT id FROM catalog_items WHERE library_id = ? AND item_key = ?").get(libraryId, key)?.id;
    for (const row of view.diff.dropped) {
      const keepId = idForKey(row.suggestedKeys[0] ?? "/none");
      if (!keepId) {
        console.log(`  跳过 ${row.id}：接手方还没有正式卡（要先 apply 一次把草稿变成卡）`);
        continue;
      }
      const merged = await post("/api/media/catalog/merge", { keepId, dropIds: [row.id] });
      console.log(`  并掉 ${row.id} → 保留 ${keepId}：HTTP ${merged.status}${merged.status === 200 ? "" : ` ${JSON.stringify(merged.body)}`}`);
    }
    reader.close();
    stats("并掉之后");
    const blocked = await post(`/api/admin/media-libraries/${libraryId}/apply?force=1`);
    console.log(`  再裸 apply（force=1）→ ${blocked.status} ${blocked.body?.code ?? ""}（不再是 APPROVAL_REQUIRED 就说明结构差异收敛了）`);
    if (blocked.body?.code === "CATALOG_APPROVAL_REQUIRED") console.log(`     还剩：${JSON.stringify(blocked.body.structural)}`);
  }
} finally {
  await backend.close();
}
console.log(`\n临时副本：${workDir}`);
