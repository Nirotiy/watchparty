// 评测台（不落生产）：直接 import 生产的 titleCandidates + createBangumiClient +
// rankHits + chooseMatch，对现库里所有非 confirmed 的 items 跑一遍 v2 解析。
// 跑法：NODE_USE_ENV_PROXY=1 node dev/catalog-parse-eval.mjs   （只读打开库，不写文件）
// 对照口径：同一套打分器先跑旧 query（before），再跑 v2 候选（after），
// 差值只可能来自解析层，不掺打分器改动。
import { DatabaseSync } from "node:sqlite";
import { createBangumiClient, rankHits, chooseMatch } from "../server/media/catalog-metadata.ts";
import { titleCandidates, yearFrom } from "../server/media/catalog-names.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const client = createBangumiClient();
let posts = 0;

/** 单个 query 的生产决策；confirmed 立即返回，candidate 只带回最佳一条。 */
async function decide(query, hintYear, hintFiles) {
  posts += 2; // 生产的 createBangumiClient 每次 search 打 type 2 + type 6
  let hits = [];
  try {
    hits = await client.search(query, "anime");
  } catch {
    hits = [];
  }
  const choice = chooseMatch(rankHits(query, hits, hintYear, hintFiles));
  if (choice.status === "confirmed") {
    return { status: "confirmed", score: choice.chosen.score, matched: choice.chosen.title };
  }
  const top = choice.candidates[0];
  return top
    ? { status: "candidate", score: top.score, matched: top.title }
    : { status: "unmatched", score: 0, matched: null };
}

const db = new DatabaseSync("data/watchparty-catalog.sqlite", { readOnly: true });
const rows = db
  .prepare(
    `SELECT i.id, i.item_key, i.query, i.raw_name, i.status,
            (SELECT COUNT(*) FROM catalog_children c WHERE c.item_id = i.id) n
     FROM catalog_items i WHERE i.status != 'confirmed' ORDER BY n DESC`,
  )
  .all();
const namesFor = db.prepare("SELECT name FROM catalog_children WHERE item_id = ?");

const report = [];
for (const row of rows) {
  const names = namesFor.all(row.id).map((entry) => entry.name);
  const segment = row.item_key.split("/").filter(Boolean).pop() ?? row.raw_name;
  const hintYear = yearFrom(row.raw_name);
  const before = await decide(row.query, hintYear, row.n || null);
  await sleep(1150);

  const candidates = titleCandidates(names, segment).slice(0, 3);
  const queries = candidates.length > 0 ? candidates : [row.query];
  let after = { status: "unmatched", score: 0, matched: null };
  let tried = 0;
  for (const query of queries) {
    tried += 1;
    const outcome = await decide(query, hintYear, row.n || null);
    if (outcome.status === "confirmed") {
      after = { ...outcome, query };
      break; // 早停：转正就不再花后面的预算
    }
    if (outcome.status === "candidate" && (after.score ?? 0) < outcome.score) after = { ...outcome, query };
    if ((outcome.score ?? 0) >= 0.75) break;
    await sleep(1150);
  }
  report.push({
    n: row.n,
    status: row.status,
    before,
    after,
    tried,
    query: row.query,
    parsed: queries[0] ?? "(无候选)",
  });
  console.log(
    `${String(row.n).padStart(3)} ${before.status.padEnd(9)}→${after.status.padEnd(9)} ` +
      `${before.score.toFixed(2)}→${after.score.toFixed(2)} 试${tried} | ` +
      `${row.query.slice(0, 20).padEnd(20)} ⇒ ${(queries[0] ?? "-").slice(0, 24)} | ${(after.matched ?? "").slice(0, 16)}`,
  );
  await sleep(1150);
}

const tally = (key) => {
  const items = { confirmed: 0, candidate: 0, unmatched: 0 };
  const files = { confirmed: 0, candidate: 0, unmatched: 0 };
  for (const row of report) {
    items[row[key].status] += 1;
    files[row[key].status] += row.n;
  }
  return { items, files };
};
const beforeTally = tally("before");
const afterTally = tally("after");
console.log("\n=== 非 confirmed 集合上的前后对照（n=" + report.length + " items）===");
for (const status of ["confirmed", "candidate", "unmatched"]) {
  console.log(
    `${status.padEnd(9)} items ${String(beforeTally.items[status]).padStart(2)} → ${String(afterTally.items[status]).padStart(2)}` +
      `   files ${String(beforeTally.files[status]).padStart(3)} → ${String(afterTally.files[status]).padStart(3)}`,
  );
}
console.log("POST 数（每次 search 两发，含 before 基线）≈", posts);
db.close();
