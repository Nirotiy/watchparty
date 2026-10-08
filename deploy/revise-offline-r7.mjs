import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { episodeSubtitle } from '../server/media/catalog-names.ts'

const [sourceArgument, targetArgument] = process.argv.slice(2)
const source = path.resolve(sourceArgument ?? '')
const target = path.resolve(targetArgument ?? '')
const allowed = path.resolve('D:/WatchParty-Diagnostics') + path.sep
if (![source, target].every(value => value.startsWith(allowed)) || source === target || fs.existsSync(target)) throw new Error('Fresh diagnostic target required')

fs.mkdirSync(path.join(target, 'data'), { recursive: true })
fs.cpSync(path.join(source, 'data'), path.join(target, 'data'), { recursive: true })
for (const file of ['binding-metadata.json', 'draft-preparation.json', 'inventory-comparison.json', 'scan-result.json', 'papaparse.min.js']) {
  fs.copyFileSync(path.join(source, file), path.join(target, file), fs.constants.COPYFILE_EXCL)
}
const integrity = {}
for (const file of ['data/watchparty-library.sqlite', 'data/watchparty-catalog.sqlite', 'baseline-catalog.sqlite']) {
  const destination = path.join(target, file)
  fs.rmSync(destination, { force: true })
  const original = new DatabaseSync(path.join(source, file), { readOnly: true })
  original.prepare('VACUUM INTO ?').run(destination)
  original.close()
  const copied = new DatabaseSync(destination, { readOnly: true })
  integrity[file] = copied.prepare('PRAGMA integrity_check').get().integrity_check
  copied.close()
  if (integrity[file] !== 'ok') throw new Error(`Integrity check failed: ${file}`)
}
for (const file of ['data/watchparty-catalog.sqlite', 'baseline-catalog.sqlite']) {
  const database = new DatabaseSync(path.join(target, file))
  for (const row of database.prepare('SELECT item_id,cache_path FROM poster_files').all()) {
    database.prepare('UPDATE poster_files SET cache_path=? WHERE item_id=?')
      .run(path.join(target, 'data/poster-cache', path.basename(row.cache_path)), row.item_id)
  }
  database.close()
}

const database = new DatabaseSync(path.join(target, 'data/watchparty-catalog.sqlite'))
const libraryId = 'lib_anime'
const paths = [
  '/[VCB-Studio] SHIROBAKO/[Nekomoe kissaten&VCB-Studio] Gekijouban SHIROBAKO [Ma10p_1080p]/SPs/[Nekomoe kissaten&VCB-Studio] Gekijouban SHIROBAKO [Menu01][Ma10p_1080p][x265_flac].mkv',
  '/[VCB-Studio] SHIROBAKO/[Nekomoe kissaten&VCB-Studio] Gekijouban SHIROBAKO [Ma10p_1080p]/SPs/[Nekomoe kissaten&VCB-Studio] Gekijouban SHIROBAKO [PV][Ma10p_1080p][x265_flac](1).mkv',
]
const scan = new Set(database.prepare('SELECT rel_path FROM catalog_scan WHERE library_id=?').all(libraryId).map(row => row.rel_path))
if (paths.some(file => !scan.has(file))) throw new Error('Approved exclusion path is not in the scan')
const stamp = new Date().toISOString()
for (const file of paths) {
  database.prepare('INSERT INTO catalog_exclusions (library_id,rel_path,reason,created_at) VALUES (?,?,?,?) ON CONFLICT(library_id,rel_path) DO UPDATE SET reason=excluded.reason')
    .run(libraryId, file, 'human-bd-extra', stamp)
}
database.prepare('INSERT INTO catalog_exclusion_libraries (library_id) VALUES (?) ON CONFLICT DO NOTHING').run(libraryId)
const excluded = new Set(database.prepare('SELECT rel_path FROM catalog_exclusions WHERE library_id=?').all(libraryId).map(row => row.rel_path))
function signature(children) { return [...new Set(children.map(file => file.relativePath ?? `id:${file.mediaId}`))].sort().join('|') }
for (const row of database.prepare('SELECT item_key,children FROM catalog_draft WHERE library_id=?').all(libraryId)) {
  const children = JSON.parse(row.children).filter(file => !excluded.has(file.relativePath))
  database.prepare('UPDATE catalog_draft SET children=?,files=?,signature=?,subtitle=? WHERE library_id=? AND item_key=?')
    .run(JSON.stringify(children), children.length, signature(children), episodeSubtitle(children, row.item_key), libraryId, row.item_key)
}
const inventoryCount = database.prepare('SELECT COUNT(*) count FROM catalog_scan WHERE library_id=?').get(libraryId).count
const draftCount = database.prepare('SELECT COALESCE(SUM(files),0) count FROM catalog_draft WHERE library_id=?').get(libraryId).count
const exclusionCount = database.prepare('SELECT COUNT(*) count FROM catalog_exclusions WHERE library_id=?').get(libraryId).count
if (draftCount + exclusionCount !== inventoryCount) throw new Error('Offline anime inventory no longer reconciles')
database.close()

const decisions = JSON.parse(fs.readFileSync(path.join(source, 'draft-decisions.json'), 'utf8'))
decisions.revision = 'r7'
decisions.excludedFiles = [...decisions.excludedFiles, ...paths.map(relativePath => ({ libraryId, relativePath, reason: 'human-bd-extra' }))]
fs.writeFileSync(path.join(target, 'draft-decisions.json'), JSON.stringify(decisions, null, 2) + '\n')
fs.writeFileSync(path.join(target, 'r7-decision-result.json'), JSON.stringify({ revision: 'r7', productionApplied: false, integrity,
  inventoryCount, draftCount, exclusionCount, addedExclusions: paths }, null, 2) + '\n')
fs.writeFileSync(path.join(target, 'MANIFEST.txt'), JSON.stringify({ derivedFrom: source, revision: 'r7', snapshotMethod: 'VACUUM INTO', integrity, productionApplied: false }, null, 2) + '\n')
console.log(JSON.stringify({ target, integrity, inventoryCount, draftCount, exclusionCount, addedExclusions: paths.length, productionApplied: false }))
