// 把分类草稿与正式卡的差异渲染成一份可翻阅的 HTML（self-contained，离线可看）。
// 跑法：node --experimental-strip-types dev/catalog-draft-report.mjs [lib_anime ...]
// 只读：classify 走生产代码（结果只进 catalog_draft），未进卡的文件用只读连接算。
// 输出 temp-html/catalog-draft-report.html —— 该目录未被 git 记录，别 git add -A。
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBackend } from "../server/app.ts";

const libraries = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["lib_anime", "lib_tv", "lib_film"];
const outPath = path.join(process.cwd(), "temp-html", "catalog-draft-report.html");

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

// 展示用的路径一律是"库内相对路径"，网盘挂载点绝对路径不进这份文件。
const shown = (relPath) => relPath.replace(/^\/media\/[a-z0-9-]+/i, "");

const backend = createBackend({ port: 0, serveStatic: false });
await backend.start();
const base = `http://127.0.0.1:${backend.port}`;

const reports = [];
for (const id of libraries) {
  const url = `${base}/api/admin/media-libraries/${id}/classify`;
  let list = await (await fetch(url)).json();
  // 只有没草稿、或草稿来自旧快照时才重做分类：classify 是整批替换，无条件跑会把
  // 已经判定好的结果擦掉（这个坑我自己踩过一次）。
  if (!list.cards || (list.draft[0]?.rev ?? -1) !== list.scan?.rev) {
    await fetch(url, { method: "POST" });
    list = await (await fetch(url)).json();
  }
  if (!list.cards) {
    console.log(`${id} → 没有草稿，先跑 dev/catalog-draft-check.mjs`);
    continue;
  }
  reports.push(list);
}

const scanDb = new DatabaseSync(path.join(process.cwd(), "data", "watchparty-catalog.sqlite"), { readOnly: true });
const draftStmt = scanDb.prepare("SELECT children FROM catalog_draft WHERE library_id = ?");
const oneChildrenStmt = scanDb.prepare("SELECT children FROM catalog_draft WHERE library_id = ? AND item_key = ?");
const scanStmt = scanDb.prepare("SELECT rel_path FROM catalog_scan WHERE library_id = ? ORDER BY rel_path");

function unfiled(libraryId) {
  const inDraft = new Set();
  for (const row of draftStmt.all(libraryId)) for (const child of JSON.parse(String(row.children))) inDraft.add(child.relativePath);
  const rows = scanStmt.all(libraryId).filter((row) => !inDraft.has(row.rel_path));
  const folders = new Map();
  for (const row of rows) {
    const dir = path.posix.dirname(String(row.rel_path));
    const list = folders.get(dir) ?? [];
    list.push(path.posix.basename(String(row.rel_path)));
    folders.set(dir, list);
  }
  return { count: rows.length, folders: [...folders.entries()].sort((a, b) => b[1].length - a[1].length) };
}

function folderSpread(card) {
  const map = new Map();
  for (const child of card.children ?? []) {
    const dir = path.posix.dirname(String(child.relativePath ?? "/"));
    map.set(dir, (map.get(dir) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

const numCell = (value) => `<td class="num">${value}</td>`;
const cell = (value, index, numeric) => (numeric.includes(index) ? numCell(value) : `<td>${value}</td>`);
const headRow = (cells) => `<tr>${cells.map((label, index) => `<th${index > 0 ? ' class="num"' : ""}>${esc(label)}</th>`).join("")}</tr>`;

function table(headers, rows, empty, numeric = [1]) {
  if (rows.length === 0) return `<p class="empty">${empty}</p>`;
  return `<table><thead>${headRow(headers)}</thead><tbody>${rows
    .map((row) => `<tr>${row.map((value, index) => cell(value, index, numeric)).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function section(report) {
  const d = report.diff;
  const label = report.libraryId;
  // 列表接口不再下发 children（大库首屏几百 KB），审阅稿按张从库里补上。
  const draftCards = (report.draft ?? [])
    .map((card) => ({ ...card, children: JSON.parse(String(oneChildrenStmt.get(report.libraryId, card.itemKey)?.children ?? "[]")) }))
    .sort((a, b) => b.files - a.files || a.query.localeCompare(b.query));
  const missing = unfiled(report.libraryId);

  const added = d.added.map((x) => [esc(x.query), `${x.files}`, `<code>${esc(shown(x.itemKey))}</code>`]);
  const dropped = d.dropped.map((x) => [esc(x.title), `${x.files}`, `<code>${esc(shown(x.itemKey))}</code>`]);
  const moved = d.moved.map((x) => [`${x.files}`, `<code>${esc(shown(x.fromKey))}</code>`, `<code>${esc(shown(x.itemKey))}</code>`]);
  const changed = d.changed.map((c) => [esc(c.from.title), `${c.from.subtitle ?? "-"} → ${c.to.subtitle ?? "-"}`, esc(c.to.title), `<code>${esc(shown(c.itemKey))}</code>`]);
  const confirmed = d.confirmedDrift.map((c) => [esc(c.title), `${c.files.from} → ${c.files.to}`, `${c.subtitle.from ?? "-"} → ${c.subtitle.to ?? "-"}`, `<code>${esc(shown(c.itemKey))}</code>`]);

  const cards = draftCards
    .map((card) => {
      const spread = folderSpread(card);
      const names = (card.children ?? []).slice(0, 6).map((child) => `<li><code>${esc(child.name)}</code></li>`).join("");
      const state =
        card.status === "confirmed"
          ? `<span class="cf">已确认${card.confirmedBy === "auto" ? "（机器）" : ""}</span> <b>${esc(card.title ?? card.query)}</b>`
          : card.lookupState === "done"
            ? `<span class="dim">候选 ${card.candidates.length} 个</span> <b>${esc(card.query)}</b>`
            : `<span class="dim">待判定</span> <b>${esc(card.query)}</b>`;
      return `<details>
  <summary><span class="n">${card.files}</span> ${state} <span class="dim">${esc(card.subtitle ?? "—")}</span></summary>
  <p class="path"><code>${esc(shown(card.itemKey))}</code></p>
  ${card.candidates.length ? `<p class="dim">候选：${card.candidates.slice(0, 3).map((c) => `${esc(c.title)}${c.year ? ` (${c.year})` : ""} ${c.score.toFixed(2)}`).join(" · ")}</p>` : ""}
  <ul class="folders">${spread.map(([dir, count]) => `<li><code>${esc(shown(dir))}</code> <span class="dim">×${count}</span></li>`).join("")}</ul>
  ${card.files > 6 ? `<p class="dim">前 6 个文件（共 ${card.files} 个）：</p>` : ""}
  <ul class="files">${names}</ul>
</details>`;
    })
    .join("");

  return `<section>
  <h2 id="${esc(report.libraryId)}">${esc(label)} <span class="dim">快照 ${report.scan.files} 个文件 @ ${esc(report.scan.enumeratedAt ?? "-")} · 分类 @ ${esc(report.classifiedAt ?? "-")}</span></h2>
  <p class="tally"><span>草稿 ${report.cards} 张</span><span>正式 ${d.formalCards} 张</span><span>一致 ${d.unchanged}</span><span class="add">＋ ${d.added.length}</span><span class="del">－ ${d.dropped.length}</span><span class="mv">↔ ${d.moved.length}</span><span class="ch">✎ ${d.changed.length}</span><span class="cf">⚑ ${d.confirmedDrift.length}</span><span>已自动确认 ${d.autoConfirmed}</span><span class="dim">待判定 ${report.pending}</span><span class="dim">未进卡 ${missing.count}</span></p>

  <h3>＋ 应用后会新建</h3>${table(["标题", "文件", "目录"], added, "没有新增")}
  <h3>－ 应用后会消失</h3>${table(["现标题", "现有文件", "现目录"], dropped, "没有卡会消失")}
  <h3>↔ 同一堆文件换了目录（认成同一张卡）</h3>${table(["文件", "现目录", "草稿目录"], moved, "没有路径变动")}
  <h3>✎ 文案会被改写（只有未确认的卡）</h3>${table(["现标题", "集数行", "草稿标题", "目录"], changed, "文案不变")}
  <h3>⚑ 已确认卡：只会刷子文件与集数行</h3>${table(["现标题", "文件数", "集数行", "目录"], confirmed, "已确认的卡文件与集数都不变")}

  <h3>未进任何卡的文件 <span class="dim">${missing.count} 个（碟片里的 NCOP/PV/menu/特典映像这类，分组时本来就不立卡）</span></h3>
  ${missing.folders.length
    ? missing.folders
        .map(
          ([dir, names]) =>
            `<details><summary><span class="n">${names.length}</span> <code>${esc(shown(dir))}</code></summary><ul class="files">${names
              .map((n) => `<li><code>${esc(n)}</code></li>`)
              .join("")}</ul></details>`,
        )
        .join("")
    : "<p class='empty'>全部文件都进了草稿</p>"}

  <h3>全部草稿卡 <span class="dim">${report.cards} 张，按文件数排序</span></h3>
  ${cards}
</section>`;
}

const overview = reports
  .map((report) => {
    const d = report.diff;
    const cells = [
      `<a href="#${esc(report.libraryId)}">${esc(report.libraryId)}</a>`,
      `${report.scan.files}`,
      `${report.cards}`,
      `${d.formalCards}`,
      `${d.unchanged}`,
      `${d.added.length}`,
      `${d.dropped.length}`,
      `${d.moved.length}`,
      `${d.changed.length}`,
      `${d.confirmedDrift.length}`,
      `${d.autoConfirmed}`,
    ];
    return `<tr>${cells.map((value, index) => cell(value, index, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).join("")}</tr>`;
  })
  .join("");

const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>片源分类草稿与差异</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 20px 64px; background: #000; color: #fff; font: 14px/1.55 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
h1 { font-size: 20px; margin: 0 0 6px; }
h2 { font-size: 17px; margin: 34px 0 8px; padding-top: 14px; border-top: 1px solid #2a2a2a; }
h3 { font-size: 14px; margin: 22px 0 8px; color: #d6d6d6; }
p { margin: 6px 0; }
.dim { color: #9a9a9a; font-weight: 400; font-size: 12.5px; }
code, .n { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }
code { word-break: break-all; }
a { color: #8ec7ff; }
.lead { max-width: 78ch; color: #d6d6d6; }
table { border-collapse: collapse; width: 100%; margin: 4px 0 10px; }
th, td { border-bottom: 1px solid #242424; padding: 6px 10px 6px 0; text-align: left; vertical-align: top; }
th { color: #9a9a9a; font-weight: 600; font-size: 12.5px; white-space: nowrap; }
td.num, th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.empty { color: #6f6f6f; font-size: 13px; margin: 2px 0 10px; }
.tally { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 13px; margin: 0 0 6px; }
.tally span { border: 1px solid #2a2a2a; border-radius: 999px; padding: 1px 9px; }
.add { color: #7ee2a8; } .del { color: #ff8f8f; } .mv { color: #ffd479; } .ch { color: #8ec7ff; } .cf { color: #cbb3ff; }
details { border-left: 2px solid #242424; padding-left: 10px; margin: 4px 0; }
summary { cursor: pointer; }
.path { margin: 2px 0; }
ul { margin: 4px 0; padding-left: 18px; }
ul.files, ul.folders { list-style: none; padding-left: 0; }
ul.files li, ul.folders li { color: #d6d6d6; }
.note { max-width: 78ch; border: 1px solid #2a2a2a; border-radius: 6px; padding: 10px 14px; margin-top: 10px; color: #d6d6d6; }
@media (max-width: 640px) { body { padding: 16px 12px 48px; } th, td { padding-right: 8px; } }
</style>
</head>
<body>
<h1>片源分类草稿与差异</h1>
<p class="lead">分类结果存在 <code>catalog_draft</code>，正式表一行都没动。<b>「应用」这一步还没做</b>，所以下面所有 <code>＋/－/↔/✎/⚑</code> 都只是预览。生成于 ${esc(new Date().toISOString())}。</p>
<table><thead>${headRow(["库", "快照文件", "草稿卡", "正式卡", "一致", "＋新增", "－消失", "↔换目录", "✎改文案", "⚑已确认会动", "已自动确认"])}</thead><tbody>${overview}</tbody></table>
${reports.map(section).join("\n")}
<div class="note">
<p><b>口径</b></p>
<ul>
<li>卡片身份按<b>文件集合</b>认，不按目录：一堆文件换了目录报 <code>↔</code>，不会被当成删一张加一张。</li>
<li>已确认的卡（<code>confirmed_by</code> 是人工/改绑/未知）标题与绑定动不了，<code>⚑</code> 只报文件数与集数行的变化；草稿标题与人工中文名的差别不是差异，所以不进这张表。</li>
<li>集数行与正式卡用同一个函数算（<code>episodeSubtitle</code>）：只有卡片自己目录里的文件、或形状像"季"的子目录才计集数；不足 2 个不写"0 集"，整行不显示。</li>
<li>路径一律是库内相对路径，不含网盘挂载点。</li>
</ul>
<p><b>重跑</b>：<code>node --experimental-strip-types dev/catalog-draft-report.mjs</code>；想连网盘重新枚举先跑 <code>node --experimental-strip-types dev/catalog-snapshot.mjs</code>（也只读）。</p>
</div>
</body>
</html>
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, "utf8");
scanDb.close();
await backend.close();
console.log(`${outPath}  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB  库 ${reports.length} 个`);
