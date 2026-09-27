// 离线分类台（只读）：拿快照跑 groupScanFiles，打印"如果现在重扫会得到哪些卡"，
// 并与库里现有卡按**文件集合**对照（不是按路径），所以人工 merge/split 的结果
// 会被认出来而不是被当成新卡。不写库、不打网络。
// 跑法：node --experimental-strip-types dev/catalog-classify.mjs [lib_anime|lib_film|lib_tv]
import { DatabaseSync } from "node:sqlite";
import { episodeSubtitle, groupScanFiles } from "../server/media/catalog-names.ts";

const db = new DatabaseSync("data/watchparty-catalog.sqlite", { readOnly: true });
const libraries = process.argv.slice(2).length > 0 ? process.argv.slice(2) : db.prepare("SELECT DISTINCT library_id id FROM catalog_scan").all().map((row) => row.id);
if (libraries.length === 0) {
  console.log("没有快照。先跑一次刮削，或 node dev/catalog-snapshot.mjs 单独刷新。");
  process.exit(0);
}
const signature = (ids) => [...new Set(ids)].sort().join("|");

for (const libraryId of libraries) {
  const files = db.prepare("SELECT rel_path, name, media_id FROM catalog_scan WHERE library_id = ? ORDER BY rel_path").all(libraryId);
  const stamp = db.prepare("SELECT MAX(enumerated_at) at FROM catalog_scan WHERE library_id = ?").get(libraryId).at;
  const groups = groupScanFiles(files.map((file) => ({ relativePath: file.rel_path, name: file.name, mediaId: file.media_id })));
  const items = db.prepare("SELECT id, item_key, title, status, subtitle FROM catalog_items WHERE library_id = ?").all(libraryId);
  const hasRelPath = db.prepare("PRAGMA table_info(catalog_children)").all().some((column) => column.name === "rel_path");
  const itemByKey = new Map(items.map((item) => [item.id, item]));
  const pathOf = (row) => {
    const key = itemByKey.get(row.item_id)?.item_key ?? "";
    if (row.rel_path) return row.rel_path;
    return /\.(mp4|mkv|webm|m4v|mov|avi|ts|m2ts|flv|wmv)$/i.test(key) ? key : `${key}/${row.name}`;
  };
  const childRows = db
    .prepare(`SELECT c.item_id AS item_id, c.name AS name, c.media_id AS media_id${hasRelPath ? ", c.rel_path AS rel_path" : ""} FROM catalog_children c JOIN catalog_items i ON i.id = c.item_id WHERE i.library_id = ?`)
    .all(libraryId)
    .map((row) => ({ ...row, path: pathOf(row) }));
  const bySignature = new Map();
  for (const item of items) bySignature.set(signature(childRows.filter((row) => row.item_id === item.id).map((row) => row.path)), item);

  console.log(`\n=== ${libraryId}  快照 ${files.length} 个文件 @ ${stamp ?? "?"}  →  ${groups.length} 张卡（库里现有 ${items.length} 张）`);
  for (const group of groups) {
    const matched = bySignature.get(signature(group.files.map((file) => file.relativePath ?? file.mediaId)));
    const flag = matched ? (matched.item_key === group.itemKey ? "同路径" : "换路径·身份保留") : "新卡";
    const title = matched && matched.status === "confirmed" ? matched.title : group.query;
    console.log(`  ${flag.padEnd(11)} [${(matched?.status ?? "pending").padEnd(9)}] ${title.slice(0, 30).padEnd(32)} ${String(group.files.length).padStart(3)} 文件  sub=${episodeSubtitle(group.files) ?? "-"}  ${group.itemKey.slice(0, 46)}`);
  }
  const orphanKeys = items.filter((item) => !groups.some((group) => group.itemKey === item.item_key));
  if (orphanKeys.length > 0) {
    console.log(`  —— 现有 ${orphanKeys.length} 张卡的路径这次没被分组出来（重扫时靠文件集合认身份）：`);
    const groupSignatures = new Set(groups.map((group) => signature(group.files.map((file) => file.mediaId))));
    for (const item of orphanKeys) {
      const own = signature(childRows.filter((row) => row.item_id === item.id).map((row) => row.path));
      const matched = groupSignatures.has(own);
      console.log(`     [${item.status}] ${item.title.slice(0, 26).padEnd(28)} ${matched ? "文件集合能对上 ⇒ 保留（换 key）" : item.status === "confirmed" ? "⚠ 会成为孤儿行" : "会被重扫删掉"}  ${item.item_key.slice(0, 44)}`);
    }
  }
}
db.close();
