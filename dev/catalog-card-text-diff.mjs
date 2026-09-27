// 只读：把 catalog_children 还原成 groupScanFiles 的输入，跑一遍 v2 分组，
// 对比"重扫之后用户会看到什么"。不写库、不打网络。
//
// 关键口径：upsertScan 对 status='confirmed' 的行是 `continue`（只换 children，
// 不碰 title/query），所以已确认卡片的文案**不会**因重扫而变。
// 跑法：node --experimental-strip-types dev/catalog-card-text-diff.mjs
import { DatabaseSync } from "node:sqlite";
import { episodeSubtitle, groupScanFiles } from "../server/media/catalog-names.ts";

const db = new DatabaseSync("data/watchparty-catalog.sqlite", { readOnly: true });
const rows = db
  .prepare(
    `SELECT i.id, i.library_id, i.item_key, i.kind, i.query, i.status, i.title,
            c.media_id, c.name
     FROM catalog_items i LEFT JOIN catalog_children c ON c.item_id = i.id
     ORDER BY i.library_id, i.item_key, c.sort_index`,
  )
  .all();
db.close();

const files = [];
const oldByKey = new Map();
for (const row of rows) {
  const entry = oldByKey.get(row.item_key) ?? {
    libraryId: row.library_id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    query: row.query,
    mediaIds: new Set(),
  };
  if (row.media_id) {
    entry.mediaIds.add(row.media_id);
    // 库根目录下的散文件：item_key 本身就是文件路径（groupScanFiles 的 "/" 分支）
    const loose = /\.(mp4|mkv|webm|m4v|mov|avi|ts|m2ts|flv|wmv)$/i.test(row.item_key);
    files.push({ relativePath: loose ? row.item_key : `${row.item_key}/${row.name}`, name: row.name, mediaId: row.media_id });
  }
  oldByKey.set(row.item_key, entry);
}

const groups = groupScanFiles(files);
const newByKey = new Map(groups.map((group) => [group.itemKey, group]));
const homeOf = (entry) => {
  for (const group of groups) if (group.files.some((file) => entry.mediaIds.has(file.mediaId))) return group;
  return undefined;
};

console.log("=== 现库 vs v2 重扫（只读换算）===");
console.log(`现库 items            ${oldByKey.size}      v2 items  ${groups.length}`);
const vanished = [...oldByKey.keys()].filter((key) => !newByKey.has(key));
console.log(`卡片合并/换 key       ${vanished.length}  （v2 归并把 SPs 类子目录并进作品层）`);
console.log(`新 key                ${[...newByKey.keys()].filter((key) => !oldByKey.has(key)).length}`);

console.log("\n--- 1) 未确认行：重扫后卡片文案会变（前端要核对的就是这一张表）---");
let changed = 0;
for (const [key, old] of oldByKey) {
  if (old.status === "confirmed") continue;
  const next = newByKey.get(key) ?? homeOf(old);
  if (!next || next.query === old.title) continue;
  changed += 1;
  const merged = newByKey.has(key) ? "" : "  ⟪并进上一张卡⟫";
  console.log(`  [${old.status[0]}] ${old.title.slice(0, 28).padEnd(29)} → ${next.query.slice(0, 28)}${merged}`);
}
console.log(`  小计 ${changed} 张`);

console.log("\n--- 2) 未确认行：key 变化（旧卡消失、文件并进作品层卡）---");
for (const key of vanished) {
  const old = oldByKey.get(key);
  const next = homeOf(old);
  console.log(`  [${old.status[0]}] ${old.title.slice(0, 20).padEnd(21)} (files ${old.mediaIds.size}) → ${next ? `${next.itemKey.slice(-44)} @ ${next.query.slice(0, 24)}` : "（无归属？）"}`);
}

console.log("\n--- 2b) 归并目标卡：文件数变了，但「N 集」只数正片（前端拍板 B）---");
for (const key of vanished) {
  const old = oldByKey.get(key);
  const next = homeOf(old);
  if (!next) continue;
  const target = newByKey.get(next.itemKey);
  const parentOld = oldByKey.get(next.itemKey);
  const before = parentOld ? parentOld.mediaIds.size : 0;
  const subtitle = episodeSubtitle(target.files) ?? "（整行不显示）";
  console.log(
    `  并掉 ${String(old.mediaIds.size).padStart(3)} 个文件 → ${next.query.slice(0, 24).padEnd(25)} 文件 ${String(before).padStart(3)} → ${String(target.files.length).padStart(3)}   subtitle: ${(parentOld ? `${before} 集` : "（父卡原不存在）").padEnd(9)} → ${subtitle}`,
  );
}

console.log("\n--- 3) 已确认行：upsertScan 跳过，文案不动；这里只列「若被重置会长什么样」 ---");
let drift = 0;
for (const [key, old] of oldByKey) {
  if (old.status !== "confirmed") continue;
  const next = newByKey.get(key);
  if (!next || next.query === old.title) continue;
  drift += 1;
  if (drift <= 12) console.log(`  ${old.title.slice(0, 26).padEnd(27)} ⇢ v2 query = ${next.query.slice(0, 26)}`);
}
console.log(`  共 ${drift} 张已确认卡片的 v2 query 与现标题不同（**不会**显示，仅供判断解析漂移面）`);

const confirmedOrphans = vanished.filter((key) => oldByKey.get(key).status === "confirmed");
console.log(`\n--- 4) 已确认但 v2 给不出同 key 的孤儿行：${confirmedOrphans.length} ---`);
for (const key of confirmedOrphans) console.log(`  ${oldByKey.get(key).title}`);
