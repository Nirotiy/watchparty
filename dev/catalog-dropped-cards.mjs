// 只读诊断：正式卡里有哪些是草稿没有覆盖的（apply 的 structural.dropped 恒不为空的原因）。
// 跑法：node dev/catalog-dropped-cards.mjs [lib_anime]
import { DatabaseSync } from "node:sqlite";

const libraryId = process.argv[2] ?? "lib_anime";
const db = new DatabaseSync("data/watchparty-catalog.sqlite", { readOnly: true });
const draft = db.prepare("SELECT item_key, children FROM catalog_draft WHERE library_id = ?").all(libraryId);
const pathsOf = (children) => JSON.parse(children).map((child) => child.relativePath ?? `id:${child.mediaId}`).sort();
const draftSets = new Map(draft.map((row) => [JSON.stringify(pathsOf(row.children)), row.item_key]));
const owner = new Map();
for (const row of draft) for (const relPath of pathsOf(row.children)) owner.set(relPath, row.item_key);
const cards = db
  .prepare(
    "SELECT id, item_key, title, status, confirmed_by, external_id, (SELECT COUNT(*) FROM catalog_children c WHERE c.item_id = i.id) files FROM catalog_items i WHERE library_id = ? ORDER BY item_key",
  )
  .all(libraryId);

console.log(`${libraryId}：正式卡 ${cards.length} 张 / 草稿卡 ${draft.length} 张`);
for (const card of cards) {
  const children = db.prepare("SELECT rel_path, name FROM catalog_children c WHERE c.item_id = ? ORDER BY sort_index").all(card.id);
  const paths = children.map((row) => row.rel_path).sort();
  if (draftSets.has(JSON.stringify(paths))) continue;
  const mine = new Set(paths);
  const owners = [...new Set(paths.map((relPath) => owner.get(relPath) ?? "NONE"))];
  console.log(`\n未被草稿覆盖：${JSON.stringify({ itemKey: card.item_key, title: card.title, status: card.status, confirmedBy: card.confirmed_by, externalId: card.external_id, files: card.files })}`);
  console.log(`  这些文件现在被草稿里的谁认领：${owners.join(" , ")}`);
  for (const relPath of paths.slice(0, 5)) console.log(`   ${mine.has(relPath) ? "·" : " "} ${relPath} → ${owner.get(relPath) ?? "NONE"}`);
  if (card.files > 5) console.log(`   …另 ${card.files - 5} 个`);
  const exact = [...draftSets.entries()].find(([, key]) => key === card.item_key);
  console.log(`  草稿里有同键位的卡吗：${exact ? `有，但文件集合不同（${exact[1]}）` : "没有"}`);
}
