// 在**真实库的副本**上跑一次 apply，并把前后对比写成一份自包含 HTML。
// 跑法：node --experimental-strip-types dev/catalog-apply-report.mjs [lib_anime ...]
// 原库只读、绝不写入；所有变更落在临时副本里。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBackend } from "../server/app.ts";

const source = path.join(process.cwd(), "data", "watchparty-catalog.sqlite");
const libraries = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (libraries.length === 0) libraries.push("lib_anime", "lib_tv", "lib_film");
const outPath = path.join(process.cwd(), "temp-html", "catalog-apply-rehearsal.html");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-apply-report-"));
fs.mkdirSync(path.join(workDir, "data"), { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(`${source}${suffix}`)) fs.copyFileSync(`${source}${suffix}`, path.join(workDir, "data", `watchparty-catalog.sqlite${suffix}`));
const copyDb = path.join(workDir, "data", "watchparty-catalog.sqlite");
process.chdir(workDir);

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const shown = (relPath) => String(relPath ?? "").replace(/^\/media\/[a-z0-9-]+/i, "");
const short = (value, length = 46) => {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};

function snapshot() {
  const db = new DatabaseSync(copyDb, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT i.id, i.library_id, i.item_key, i.title, i.status, COALESCE(i.confirmed_by,'-') confirmed_by,
                i.external_id, COALESCE(i.subtitle,'') subtitle, (SELECT COUNT(*) FROM catalog_children c WHERE c.item_id = i.id) files
         FROM catalog_items i ORDER BY i.library_id, i.item_key`,
      )
      .all();
    return new Map(rows.map((row) => [String(row.id), row]));
  } finally {
    db.close();
  }
}

function tally(before) {
  const byLibrary = new Map();
  for (const row of before.values()) {
    const entry = byLibrary.get(row.library_id) ?? { cards: 0, files: 0, status: {}, by: {} };
    entry.cards += 1;
    entry.files += Number(row.files);
    entry.status[row.status] = (entry.status[row.status] ?? 0) + 1;
    entry.by[row.confirmed_by] = (entry.by[row.confirmed_by] ?? 0) + 1;
    byLibrary.set(row.library_id, entry);
  }
  return byLibrary;
}

const backend = createBackend({ port: 0, serveStatic: false, fetchPoster: async () => undefined });
await backend.start();
const base = `http://127.0.0.1:${backend.port}`;
const call = async (url, init) => {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

const before = snapshot();
const results = [];
for (const id of libraries) {
  const draft = (await call(`${base}/api/admin/media-libraries/${id}/classify`)).body;
  const applied = (await call(`${base}/api/admin/media-libraries/${id}/apply?force=1`, { method: "POST" })).body;
  const again = (await call(`${base}/api/admin/media-libraries/${id}/apply?force=1`, { method: "POST" })).body;
  // 变弱的卡要说清"这次最高分是谁、多少分"，否则看不出是护栏在拦而不是判定坏了。
  const weakened = new Map();
  for (const row of (draft.draft ?? []).filter((entry) => entry.status === "candidate" && entry.files > 0)) {
    const one = await call(`${base}/api/admin/media-libraries/${id}/classify?item=${encodeURIComponent(row.itemKey)}`);
    const top = (one.body?.candidates ?? [])[0];
    if (top) weakened.set(row.itemKey, `${top.title}(${top.score})`);
  }
  results.push({ id, draft, applied, again, weakened });
}
const after = snapshot();
await backend.close();

const beforeTally = tally(before);
const afterTally = tally(after);

function changedRows(id) {
  const rows = [];
  for (const [cardId, post] of after) {
    if (post.library_id !== id) continue;
    const prior = before.get(cardId);
    if (!prior) {
      rows.push({ kind: "新建", id: cardId, key: post.item_key, from: null, to: post });
      continue;
    }
    const moved = prior.item_key !== post.item_key;
    const rebound = prior.external_id !== post.external_id || prior.status !== post.status || prior.confirmed_by !== post.confirmed_by;
    const reshaped = Number(prior.files) !== Number(post.files) || prior.subtitle !== post.subtitle;
    if (moved || rebound || reshaped) {
      rows.push({
        kind: moved && !rebound && !reshaped ? "换键位" : rebound ? "绑定/状态" : "文件与集数",
        id: cardId,
        key: post.item_key,
        from: prior,
        to: post,
      });
    }
  }
  return rows;
}

const cell = (value, numeric = false) => `<td${numeric ? ' class="num"' : ""}>${value}</td>`;
const head = (labels) => `<tr>${labels.map((label, index) => `<th${index > 0 ? ' class="num"' : ""}>${esc(label)}</th>`).join("")}</tr>`;
const table = (labels, rows) => `<table><thead>${head(labels)}</thead><tbody>${rows.join("")}</tbody></table>`;

const overview = libraries.map((id) => {
  const b = beforeTally.get(id) ?? { cards: 0, files: 0, status: {}, by: {} };
  const a = afterTally.get(id) ?? { cards: 0, files: 0, status: {}, by: {} };
  const result = results.find((entry) => entry.id === id);
  const fmt = (tally) => `${tally.cards} 卡 / ${tally.status.confirmed ?? 0} 确认`;
  return `<tr><td><a href="#${esc(id)}">${esc(id)}</a></td>${cell(`${fmt(b)} → <b>${fmt(a)}</b>`)}${cell(`${b.files} → <b>${a.files}</b>`, true)}${cell(result.applied?.created ?? "-", true)}${cell(result.applied?.updated ?? "-", true)}${cell(result.applied?.skipped ?? "-", true)}${cell(result.applied?.deferred ?? "-", true)}${cell(result.again?.created === 0 && result.again?.updated === result.applied?.updated ? "成立" : "不成立")}</tr>`;
});

const sections = libraries.map((id) => {
  const result = results.find((entry) => entry.id === id);
  const rows = changedRows(id);
  const lost = rows.filter((row) => row.from?.status === "confirmed" && row.to.status !== "confirmed");
  const gained = rows.filter((row) => row.from?.status !== "confirmed" && row.to.status === "confirmed");
  const d = result.draft?.diff;
  const drift = d?.confirmedDrift ?? [];
  const equations = drift.map((c) => {
    const taken = (d.added ?? []).filter((a) => a.splitFromKey === c.itemKey);
    const plus = taken.map((a) => ` + ${a.fromFiles}→「${esc(short(a.query ?? a.itemKey, 28))}」`).join("");
    return `<tr>${cell(esc(short(c.title, 30)))}${cell(`${c.files.from} → ${c.files.to}${plus}`, true)}${cell(`${esc(c.subtitle.from ?? "—")} → ${esc(c.subtitle.to ?? "—")}`)}${cell(esc(short(c.itemKey, 60)))}</tr>`;
  });
  const detail = rows.map((row) => {
    const f = row.from;
    const t = row.to;
    return `<tr>${cell(esc(row.kind))}${cell(esc(short(t.title ?? t.item_key, 30)))}${cell(f ? `${esc(f.status)}/${esc(f.confirmed_by)}` : "—（新建）")}${cell(esc(`${t.status}/${t.confirmed_by}`))}${cell(f ? `${f.files} → ${t.files}` : `${t.files}`, true)}${cell(esc(short(t.item_key, 58)))}</tr>`;
  });
  const b = beforeTally.get(id) ?? { cards: 0, files: 0 };
  const a = afterTally.get(id) ?? { cards: 0, files: 0 };
  return `<section>
  <h2 id="${esc(id)}">${esc(id)} <span class="dim">应用前 ${b.cards} 卡 / ${b.files} 文件 → 应用后 ${a.cards} 卡 / ${a.files} 文件</span></h2>
  <p class="tally"><span>新建 ${result.applied?.created ?? "-"}</span><span>写判定 ${result.applied?.updated ?? "-"}</span><span>人工跳过 ${result.applied?.skipped ?? "-"}</span><span>未判定未动 ${result.applied?.deferred ?? "-"}</span><span>待抓海报 ${result.applied?.posters ?? "-"}</span>${d ? `<span class="dim">应用前差异：一致 ${d.unchanged} ＋${d.added.length} －${d.dropped.length} ↔${d.moved.length} ✎${d.changed.length} ⚑${d.confirmedDrift.length}</span>` : ""}</p>
  ${lost.length ? `<div class="warn">应用会让 <b>${lost.length}</b> 张已确认卡变回未确认。这不是判定坏了：护栏把"文件夹声称了季/部、而条目名里没写"的匹配封顶在 ${esc(String(result.draft?.thresholds?.variantCap ?? 0.84))}（自动确认线 ${esc(String(result.draft?.thresholds?.autoScore ?? 0.86))}），而这些卡是 2026-09-27 那次「护栏上线前」自动确认的。要留着就别说"整库重扫"，请逐张人工点候选。</div>${table(["卡", "前 状态/来源", "后 状态/来源", "这次最高候选", "目录"], lost.map((row) => [cell(esc(short(row.to.title ?? row.to.item_key, 26))), cell(`${esc(row.from.status)}/${esc(row.from.confirmed_by)}`), cell(`${esc(row.to.status)}/${esc(row.to.confirmed_by)}`), cell(esc(result.weakened?.get(row.to.item_key) ?? "—")), cell(esc(short(row.to.item_key, 48)))]))}` : ""}
  ${gained.length ? `<p class="dim">另有 ${gained.length} 张卡从"未确认"变成机器自动确认。</p>` : ""}
  ${equations.length ? `<h3>被劈开的卡（文件级证据）</h3>${table(["卡", "文件方程", "集数行", "目录"], equations)}` : ""}
  <h3>逐卡前后 <span class="dim">${rows.length} 行有变化</span></h3>
  ${rows.length ? table(["变化类型", "卡", "前 状态/来源", "后 状态/来源", "文件", "目录"], detail) : `<p class="empty">没有变化</p>`}
</section>`;
});

const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>应用草稿：真实库副本演练前后对比</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 20px 64px; background: #000; color: #fff; font: 14px/1.55 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
h1 { font-size: 20px; margin: 0 0 6px; }
h2 { font-size: 17px; margin: 34px 0 8px; padding-top: 14px; border-top: 1px solid #2a2a2a; }
h3 { font-size: 14px; margin: 20px 0 6px; color: #d6d6d6; }
p { margin: 6px 0; }
.dim { color: #9a9a9a; font-weight: 400; font-size: 12.5px; }
code { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; word-break: break-all; }
a { color: #8ec7ff; }
.lead { max-width: 82ch; color: #d6d6d6; }
.warn { border: 1px solid #6b4a1a; border-radius: 6px; padding: 10px 14px; margin: 12px 0; color: #ffd479; max-width: 82ch; }
table { border-collapse: collapse; width: 100%; margin: 4px 0 10px; }
th, td { border-bottom: 1px solid #242424; padding: 6px 10px 6px 0; text-align: left; vertical-align: top; }
th { color: #9a9a9a; font-weight: 600; font-size: 12.5px; white-space: nowrap; }
td.num, th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.empty { color: #6f6f6f; font-size: 13px; }
.tally { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 13px; margin: 0 0 8px; }
.tally span { border: 1px solid #2a2a2a; border-radius: 999px; padding: 1px 9px; }
.note { max-width: 82ch; border: 1px solid #2a2a2a; border-radius: 6px; padding: 10px 14px; margin-top: 14px; color: #d6d6d6; }
@media (max-width: 640px) { body { padding: 16px 12px 48px; } th, td { padding-right: 8px; } }
</style>
</head>
<body>
<h1>应用草稿：真实库副本演练前后对比</h1>
<p class="lead">生成于 ${esc(new Date().toISOString())}。数据来自 <code>data/watchparty-catalog.sqlite</code> 的一份<b>临时副本</b>：apply 只作用在副本上，<b>你的正式库一行都没动</b>。副本目录见控制台输出。</p>
<div class="warn">这份报告是"如果点应用会发生什么"的预演。其中「人工跳过」= 你确认过的卡整张不动（绑定与候选都不动）；「未判定未动」= 草稿还没判定的卡只对齐结构、不动绑定。</div>
${table(["库", "卡数与确认数", "子文件", "新建", "写判定", "人工跳过", "未判定未动", "重复应用幂等"], overview)}
${sections.join("\n")}
<div class="note">
<p><b>怎么读</b></p>
<ul>
<li>「被劈开的卡」里 <code>48 → 24 + 24→「Kusuriya…」</code> 意思是：这张卡应用后只剩 24 个文件，另外 24 个被一张新卡接走（配对按文件路径归属，不是标题猜）。</li>
<li>「逐卡前后」只列有变化的行；<code>状态/来源</code> 里 <code>confirmed/auto</code> 是机器自己确认的，<code>manual</code>、<code>rebind</code>、<code>unknown</code> 都是人的决定，自动流程不许改。</li>
<li>「重复应用幂等」= 同一份草稿连点两次应用，第二次不新建卡、写判定数不变。</li>
</ul>
<p><b>重跑</b>：<code>node --experimental-strip-types dev/catalog-apply-report.mjs</code>（只读原库）。要真落库由你点头：界面上的「应用草稿…」，或 <code>curl -s --noproxy '*' -X POST http://127.0.0.1:8080/api/admin/media-libraries/&lt;id&gt;/apply</code>。</p>
</div>
</body>
</html>
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, "utf8");
console.log(`${outPath}  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
console.log(`副本（可自查）：${copyDb}`);
