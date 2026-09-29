// 只读预览：扫本地目录里的 NFO/JSON，规范化后与快照里的作品卡按文件集合对账。
// 跑法：node --experimental-strip-types dev/catalog-sidecar-preview.mjs <目录> [--library lib_anime]
// 不写任何东西 —— 它回答的是"这批 sidecar 能不能唯一定位到已有作品卡"。
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { folderOf, parseSidecar, sidecarsIn } from "../server/media/catalog-sidecar.ts";

const args = process.argv.slice(2);
const root = args.find((arg) => !arg.startsWith("--"));
const libraryId = args.includes("--library") ? args[args.indexOf("--library") + 1] : "lib_anime";
if (!root || !fs.existsSync(root)) {
  console.log("用法：node --experimental-strip-types dev/catalog-sidecar-preview.mjs <本地目录> [--library lib_anime]");
  process.exit(1);
}

const MEDIA = new Set(["mkv", "mp4", "webm", "m4v", "mov", "avi", "ts", "m2ts", "flv", "wmv", "strm"]);
const extensionOf = (name) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

const folders = new Map();
let mediaFiles = 0;
let walked = 0;
(function walk(dir, depth) {
  if (depth > 6) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const record = { media: [], sidecars: [] };
  for (const entry of entries) {
    walked += 1;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, depth + 1);
      continue;
    }
    const ext = extensionOf(entry.name);
    if (MEDIA.has(ext)) {
      mediaFiles += 1;
      record.media.push(entry.name);
    } else if (ext === "nfo" || ext === "json") {
      record.sidecars.push(entry.name);
    }
  }
  if (record.media.length > 0 || sidecarsIn(record.sidecars).length > 0) folders.set(path.relative(root, dir) || ".", record);
})(root, 0);

console.log(`本地：走查 ${walked} 项，媒体文件 ${mediaFiles} 个，含媒体或 sidecar 的目录 ${folders.size} 个（深度≤6）`);

const parsed = [];
const skipped = [];
for (const [folder, record] of folders) {
  for (const name of sidecarsIn(record.sidecars)) {
    const file = path.join(root, folder, name);
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      skipped.push(`${folder}/${name} 读不了`);
      continue;
    }
    const meta = parseSidecar(name, text, `/${folder.split(path.sep).join("/")}`);
    (meta.title || meta.ids.tmdb || meta.ids.imdb ? parsed : skipped).push(meta.title || meta.ids.tmdb ? meta : `${folder}/${name} 什么字段都没读到`);
  }
}
const usable = parsed.filter((entry) => typeof entry === "object");
console.log(`sidecar：解析出可用元数据 ${usable.length} 份，读不出关键字段 ${skipped.length} 份`);
for (const meta of usable.slice(0, 12)) {
  console.log(`  ${String(meta.folder).slice(0, 44).padEnd(46)} ${meta.kind.padEnd(8)} ${(meta.title ?? "-").slice(0, 24).padEnd(26)} ${meta.year ?? "-"} tmdb=${meta.ids.tmdb ?? "-"} imdb=${meta.ids.imdb ?? "-"}`);
}

const db = new DatabaseSync(path.join(process.cwd(), "data", "watchparty-catalog.sqlite"), { readOnly: true });
const cards = db
  .prepare("SELECT i.id, i.item_key, i.title, i.external_db, i.external_id, COALESCE(i.confirmed_by,'-') confirmed_by FROM catalog_items i WHERE i.library_id = ?")
  .all(libraryId);
const childStmt = db.prepare("SELECT c.rel_path FROM catalog_children c WHERE c.item_id = ?");
const byName = new Map();
for (const card of cards) {
  const names = childStmt.all(card.id).map((row) => String(row.rel_path).split("/").pop());
  card.folders = [...new Set(childStmt.all(card.id).map((row) => folderOf(String(row.rel_path))))];
  for (const name of names) byName.set(name, [...(byName.get(name) ?? []), card]);
}
db.close();

let matched = 0;
let ambiguous = 0;
let orphan = 0;
for (const meta of usable) {
  const folder = meta.folder.replace(/^\//, "");
  const direct = cards.filter((card) => card.folders.some((dir) => dir.replace(/^\//, "").endsWith(folder)));
  const hits = direct.length > 0 ? direct : [];
  if (hits.length === 1) matched += 1;
  else if (hits.length > 1) ambiguous += 1;
  else orphan += 1;
}
console.log(`\n对账（library=${libraryId}，正式卡 ${cards.length} 张）：唯一命中 ${matched}，撞车 ${ambiguous}，找不到对应卡 ${orphan}`);
console.log(matched + ambiguous + orphan === 0 ? "  本地没有可读的 sidecar —— 这条链路目前没有输入。" : "  只读预览：没有写库、没有改卡。");
