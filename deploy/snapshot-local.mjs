import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination) || fs.existsSync(destination)) {
  throw new Error("Supply a new absolute snapshot directory after coordinating a no-write window");
}
fs.mkdirSync(path.join(destination, "data"), { recursive: true });
const manifest = { capturedAt: new Date().toISOString(), databases: {}, files: {} };
for (const name of ["watchparty-library.sqlite", "watchparty-catalog.sqlite"]) {
  const source = new DatabaseSync(path.join(repo, "data", name), { readOnly: true });
  const target = path.join(destination, "data", name);
  try { source.prepare("VACUUM INTO ?").run(target); } finally { source.close(); }
  const copy = new DatabaseSync(target, { readOnly: true });
  try {
    const integrity = copy.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new Error("Snapshot integrity failed");
    const tables = copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const counts = Object.fromEntries(tables.map(({ name: table }) => [table, copy.prepare(`SELECT COUNT(*) AS count FROM "${table.replaceAll('"', '""')}"`).get().count]));
    manifest.databases[name] = { integrity: "ok", counts };
  } finally { copy.close(); }
}
for (const name of ["poster-cache", "catalog-sidecars"]) {
  const source = path.join(repo, "data", name);
  if (fs.existsSync(source)) fs.cpSync(source, path.join(destination, "data", name), { recursive: true, force: false, errorOnExist: true });
}
function hashes(directory, prefix = "") {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) hashes(file, relative + "/");
    else manifest.files[relative] = { size: fs.statSync(file).size, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
  }
}
hashes(path.join(destination, "data"));
fs.writeFileSync(path.join(destination, "MANIFEST.txt"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ snapshot: destination, databases: Object.keys(manifest.databases), integrity: "ok", files: Object.keys(manifest.files).length }));
