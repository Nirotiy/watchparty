import { DatabaseSync } from "node:sqlite";
import { titleCandidates } from "../server/media/catalog-names.ts";

const db = new DatabaseSync("data/watchparty-catalog.sqlite", { readOnly: true });
const rows = db.prepare("SELECT id, item_key, query, status FROM catalog_items WHERE status != 'confirmed' ORDER BY 1").all();
for (const row of rows) {
  const names = db.prepare("SELECT name FROM catalog_children WHERE item_id = ?").all(row.id).map((entry) => entry.name);
  const base = row.item_key.split("/").filter(Boolean).pop() ?? "";
  const cands = titleCandidates(names, base, 3);
  console.log(
    String(names.length).padStart(3),
    row.status[0],
    "| 旧:",
    row.query.slice(0, 26).padEnd(26),
    "| 新:",
    cands.map((value) => value.slice(0, 26)).join(" ⧸ "),
  );
}
db.close();
