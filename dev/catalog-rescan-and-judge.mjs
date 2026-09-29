// 重扫 → 重分类 → 判定跑到干净，一条命令。开跑前自动整份备份两个 sqlite。
// 前置：OpenList 得在跑（.env 的 OPENLIST_URL）。跑法：
//   NO_PROXY=127.0.0.1,localhost,::1 node --experimental-strip-types dev/catalog-rescan-and-judge.mjs [lib_anime ...] [--max=20] [--no-judge]
// 判定分批是因为 Bangumi 有配额（个人 token 也只是配额更高，不是不限）；默认一轮 20 张。
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const maxFlag = args.find((arg) => arg.startsWith("--max="));
const perRound = maxFlag ? Number(maxFlag.split("=")[1]) : 20;
const judge = !args.includes("--no-judge");
const libraries = args.filter((arg) => !arg.startsWith("--"));
const ids = libraries.length > 0 ? libraries : ["lib_anime", "lib_tv", "lib_film"];
const base = process.env.WATCHPARTY_API_BASE ?? "http://127.0.0.1:8080";
const dbFile = path.join(process.cwd(), "data", "watchparty-catalog.sqlite");

const post = async (id, route) => {
  const response = await fetch(`${base}/api/admin/media-libraries/${id}/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${id} ${route} → ${response.status} ${JSON.stringify(body)}`);
  return body;
};

// 扫描会整批替换快照、草稿随之过期；重分类又是不可逆的（非 confirmed 行的候选与海报会被清）。
const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
const backup = path.join(process.cwd(), "data", `backup-pre-rescan-${stamp}`);
fs.mkdirSync(backup, { recursive: true });
for (const file of ["watchparty-catalog.sqlite", "watchparty-library.sqlite", "watchparty-catalog.sqlite-wal", "watchparty-catalog.sqlite-shm"]) {
  if (fs.existsSync(path.join(process.cwd(), "data", file))) fs.copyFileSync(path.join(process.cwd(), "data", file), path.join(backup, file));
}
console.log(`备份：${backup}`);

const sizeReport = () => {
  const reader = new DatabaseSync(dbFile, { readOnly: true });
  try {
    // IFNULL 不是洁癖：SUM(size = 0) 在没有任何命中时是 NULL，直接打出来是"0 字节的 null 个"。
    // 占位符要按库数生成：SQLite 不会把单个 ? 展开成多个绑定值。
    const rows = reader
      .prepare(`SELECT library_id, COUNT(*) rows, SUM(size IS NULL) nulls, IFNULL(SUM(size = 0), 0) zeros FROM catalog_scan WHERE library_id IN (${ids.map(() => "?").join(",")}) GROUP BY library_id`)
      .all(...ids);
    return ids
      .map((id) => {
        const row = rows.find((entry) => entry.library_id === id);
        if (!row) return `${id} 快照里没有行（枚举没成功？）`;
        return `${id} ${Number(row.rows) - Number(row.nulls)}/${row.rows} 有 size（其中 0 字节 ${row.zeros} 个）`;
      })
      .join("\n  ");
  } finally {
    reader.close();
  }
};

for (const id of ids) {
  const started = Date.now();
  const scan = await post(id, "scan");
  console.log(`\n${id}：枚举 ${scan.files} 个文件，快照 rev → ${scan.rev}`);
  if (!judge) {
    const classified = await post(id, "classify");
    const d = classified.diff;
    console.log(`  重分类：草稿 ${classified.cards} 张 ⇒ 一致 ${d.unchanged} ＋${d.added.length} －${d.dropped.length} ↔${d.moved.length} ✎${d.changed.length} ⚑${d.confirmedDrift.length}`);
    continue;
  }
  let rounds = 0;
  let last = null;
  for (;;) {
    const result = await post(id, `prepare?max=${perRound}`);
    rounds += 1;
    console.log(`  第 ${rounds} 轮：判定 ${result.judged} 张（自动确认 ${result.confirmed}），剩 ${result.pending} 张待判${result.items.length === 0 ? " —— 没有新条目可判" : ""}`);
    last = result;
    if (result.pending === 0 || result.judged === 0) break;
    if (rounds > 60) {
      console.log("  超过 60 轮，停手（配额或判定逻辑有问题，别再空转）");
      break;
    }
  }
  const d = last.diff;
  console.log(
    `  完成：草稿 ${last.cards} 张 / ${((Date.now() - started) / 1000).toFixed(0)}s ⇒ 一致 ${d.unchanged} ＋${d.added.length} －${d.dropped.length} ↔${d.moved.length} ✎${d.changed.length} ⚑${d.confirmedDrift.length}（自动确认 ${d.autoConfirmed}）`,
  );
  if (d.added.length + d.dropped.length + d.moved.length + d.confirmedDrift.filter((row) => row.files.from !== row.files.to).length > 0) {
    console.log("  这次要应用得走批准：POST .../approval 换一次性凭证 → POST .../apply-approved");
  }
}
console.log(`\n快照里的 size 覆盖：\n  ${sizeReport()}`);
console.log("\nsize 校验覆盖面看导入回执的 sizeChecks：比过 / 不符 / 没法比，三者分得清。");
