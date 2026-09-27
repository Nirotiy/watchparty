// 录夹具：用仓库自己的 cleanTitle/groupScanFiles 处理 E:/multimedia 真实目录，
// 拿真实查询去问 Bangumi，只留打分需要的字段 → 测试从此离线可复现。
// 需要 NODE_USE_ENV_PROXY=1（Node 24）让原生 fetch 认环境代理。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanTitle, groupScanFiles } from "../server/media/catalog-names.ts";

const ROOT = "E:/multimedia";
const UA = "watchparty/0.1.0 (catalog scrape)";

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(mkv|mp4|ts)$/i.test(entry.name)) out.push({ relativePath: "/" + path.relative(ROOT, full).replace(/\\/g, "/"), name: entry.name, mediaId: out.length + ":" + entry.name });
  }
  return out;
}

const files = walk(ROOT);
const groups = groupScanFiles(files);
const record = [];
for (const group of groups) {
  const query = group.query;
  const hintYear = null;
  const hintFiles = group.files.length;
  const hits = [];
  for (const type of [2, 4, 6]) {
    try {
      const response = await fetch("https://api.bgm.tv/v0/search/subjects", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "user-agent": UA },
        body: JSON.stringify({ keyword: query, filter: { type: [type] }, limit: 5 }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) { console.log(`  ! HTTP ${response.status} for "${query}" type=${type}`); continue; }
      const body = await response.json();
      for (const row of body.data ?? []) {
        const ib = {};
        for (const item of row.infobox ?? []) {
          ib[item.key] = Array.isArray(item.value) ? item.value.map((v) => v.v).join("/") : item.value;
        }
        hits.push({
          externalId: String(row.id),
          name: row.name ?? "",
          name_cn: row.name_cn ?? "",
          type: row.type ?? null,
          total_episodes: row.total_episodes ?? null,
          eps: row.eps ?? null,
          aired_date: row.date ?? null,
          infobox_cn_name: ib["中文名"] ?? null,
          infobox_alias: ib["别名"] ?? null,
          infobox_episodes: ib["话数"] ?? null,
        });
      }
    } catch (error) {
      console.log(`  ! ${error.message} for "${query}" type=${type}`);
    }
  }
  console.log(`${query}  (${hintFiles} 文件, itemKey=${group.itemKey}) → ${hits.length} hits`);
  record.push({ query, itemKey: group.itemKey, fileCount: hintFiles, hits });
}

const target = fileURLToPath(new URL("../server/test/fixtures/bangumi-live-hits.json", import.meta.url));
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(record, null, 2));
console.log("写入", target);
