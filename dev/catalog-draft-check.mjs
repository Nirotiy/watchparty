// 分类（可选：连判定一起跑）落草稿并打印差异预览。
// 跑法：node --experimental-strip-types dev/catalog-draft-check.mjs [--judge] [--max=N] [lib_anime ...]
// 只写 catalog_draft；正式卡一行不动，所以随时可以反复跑。
// --judge 才会打 Bangumi（匿名 ~60 req/min，用 --max 分批）；不加就只看分类结果。
import { createBackend } from "../server/app.ts";

const args = process.argv.slice(2);
const judge = args.includes("--judge");
const maxArg = args.find((a) => a.startsWith("--max="));
const max = maxArg ? `?max=${maxArg.slice(6)}` : "";
const libraries = args.filter((a) => !a.startsWith("--"));
if (libraries.length === 0) libraries.push("lib_anime", "lib_tv", "lib_film");
const backend = createBackend({ port: 0, serveStatic: false });
await backend.start();
const base = `http://127.0.0.1:${backend.port}`;

const list = (value) => (value.length === 0 ? "-" : value.map((x) => `${x.title ?? x.query ?? x.itemKey}${x.files !== undefined ? `(${x.files})` : ""}`).join("、"));

for (const id of libraries) {
  const started = Date.now();
  const response = await fetch(`${base}/api/admin/media-libraries/${id}/${judge ? "prepare" : "classify"}${judge ? max : ""}`, { method: "POST" });
  if (!response.ok) {
    console.log(`${id} → HTTP ${response.status} ${(await response.text()).slice(0, 120)}`);
    continue;
  }
  const result = await response.json();
  const d = result.diff;
  const judged = result.judged === undefined ? "" : `  本轮判定 ${result.judged} 张（自动确认 ${result.confirmed}，剩 ${result.pending} 张待判）`;
  console.log(
    `\n${id}  ${((Date.now() - started) / 1000).toFixed(1)}s  文件 ${result.files} → 草稿 ${result.cards} 张（库里正式卡 ${d.formalCards}）${judged}`,
  );
  console.log(`  一致 ${d.unchanged} / 新增 ${d.added.length} / 消失 ${d.dropped.length} / 换 key ${d.moved.length} / 改文案 ${d.changed.length} / 已确认卡的文件或集数会变 ${d.confirmedDrift.length} / 草稿里已自动确认 ${d.autoConfirmed}`);
  if (d.added.length) console.log(`  ＋ ${list(d.added.slice(0, 8))}${d.added.length > 8 ? ` …共${d.added.length}` : ""}`);
  if (d.dropped.length) console.log(`  － ${list(d.dropped.slice(0, 8))}${d.dropped.length > 8 ? ` …共${d.dropped.length}` : ""}`);
  if (d.moved.length) console.log(`  ↔ ${d.moved.slice(0, 6).map((m) => `${m.fromKey}→${m.itemKey}(${m.files})`).join("、")}`);
  if (d.changed.length)
    console.log(
      `  ✎ ${d.changed
        .slice(0, 6)
        .map((c) => `${c.from.title}[${c.from.subtitle ?? "-"}]→${c.to.title}[${c.to.subtitle ?? "-"}]`)
        .join("、")}`,
    );
  if (d.confirmedDrift.length)
    console.log(
      `  ⚑人 ${d.confirmedDrift
        .slice(0, 6)
        .map((p) => `${p.title} ${p.files.from}文件[${p.subtitle.from ?? "-"}]→${p.files.to}文件[${p.subtitle.to ?? "-"}]`)
        .join("、")}${d.confirmedDrift.length > 6 ? ` …共${d.confirmedDrift.length}` : ""}`,
    );
}

const cards = (await (await fetch(`${base}/api/admin/media-libraries/${libraries[0]}/classify`)).json()).cards;
console.log(`\n读回草稿：${libraries[0]} 有 ${cards} 张（正式表未变，随时可重跑）`);
await backend.close();
