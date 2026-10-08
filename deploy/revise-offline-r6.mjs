import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { episodeSubtitle } from '../server/media/catalog-names.ts'

const [sourceArgument, targetArgument] = process.argv.slice(2)
const source = path.resolve(sourceArgument ?? '')
const target = path.resolve(targetArgument ?? '')
const allowedRoot = path.resolve('D:/WatchParty-Diagnostics') + path.sep
if (![source, target].every(directory => directory.startsWith(allowedRoot)) || source === target || fs.existsSync(target)) {
  throw new Error('A new independent diagnostic copy is required')
}

const filesToCopy = [
  'binding-metadata.json', 'draft-preparation.json', 'inventory-comparison.json', 'scan-result.json',
  'papaparse.min.js', 'bd-exclusion-suggestions.json', 'bd-exclusion-suggestions.csv',
]
fs.mkdirSync(path.join(target, 'data'), { recursive: true })
fs.cpSync(path.join(source, 'data'), path.join(target, 'data'), { recursive: true })
for (const file of filesToCopy) fs.copyFileSync(path.join(source, file), path.join(target, file), fs.constants.COPYFILE_EXCL)

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
  if (integrity[file] !== 'ok') throw new Error(`Copy integrity failed: ${file}`)
}

for (const file of ['data/watchparty-catalog.sqlite', 'baseline-catalog.sqlite']) {
  const destination = path.join(target, file)
  const copied = new DatabaseSync(destination)
  for (const row of copied.prepare('SELECT item_id,cache_path FROM poster_files').all()) {
    copied.prepare('UPDATE poster_files SET cache_path = ? WHERE item_id = ?')
      .run(path.join(target, 'data/poster-cache', path.basename(row.cache_path)), row.item_id)
  }
  copied.close()
}

const databasePath = path.join(target, 'data/watchparty-catalog.sqlite')
const db = new DatabaseSync(databasePath)
const library = 'lib_anime'
const now = new Date().toISOString()
const sourceDecisions = JSON.parse(fs.readFileSync(path.join(source, 'draft-decisions.json'), 'utf8'))

function requireDraft(itemKey) {
  const row = db.prepare('SELECT * FROM catalog_draft WHERE library_id = ? AND item_key = ?').get(library, itemKey)
  if (!row) throw new Error(`Draft card missing: ${itemKey}`)
  return { ...row, children: JSON.parse(row.children) }
}
function findDraft(predicate, label) {
  const rows = db.prepare('SELECT * FROM catalog_draft WHERE library_id = ?').all(library)
    .map(row => ({ ...row, children: JSON.parse(row.children) }))
  const matches = rows.filter(predicate)
  if (matches.length !== 1) throw new Error(`${label}: expected one card, got ${matches.length}`)
  return matches[0]
}
function signature(children) {
  return [...new Set(children.map(file => file.relativePath ?? `id:${file.mediaId}`))].sort().join('|')
}
function updateDraftChildren(itemKey, children) {
  db.prepare('UPDATE catalog_draft SET children = ?, files = ?, signature = ?, subtitle = ? WHERE library_id = ? AND item_key = ?')
    .run(JSON.stringify(children), children.length, signature(children), episodeSubtitle(children, itemKey), library, itemKey)
}
function updateDraftMetadata(itemKey, metadata) {
  const sets = Object.keys(metadata).map(key => `${key} = ?`).join(', ')
  db.prepare(`UPDATE catalog_draft SET ${sets}, confirmed_by = 'manual', status = 'confirmed', lookup_state = 'done' WHERE library_id = ? AND item_key = ?`)
    .run(...Object.values(metadata), library, itemKey)
}
function updateFormalMetadata(itemKey, metadata) {
  const sets = Object.keys(metadata).map(key => `${key} = ?`).join(', ')
  db.prepare(`UPDATE catalog_items SET ${sets}, confirmed_by = 'manual', status = 'confirmed', lookup_state = 'done', updated_at = ? WHERE library_id = ? AND item_key = ?`)
    .run(...Object.values(metadata), now, library, itemKey)
}
function excludeFiles(itemKey, predicate, reason, expected) {
  const row = requireDraft(itemKey)
  const chosen = row.children.filter(predicate)
  if (chosen.length !== expected) throw new Error(`${itemKey}: expected ${expected} exclusions, got ${chosen.length}`)
  for (const file of chosen) excluded.push({ libraryId: library, itemKey, relativePath: file.relativePath, reason })
}
function addExclusions() {
  excludeFiles(
    '/[DBD-Raws][吊带袜天使][01-13TV全集+SP+特典映像][1080P][BDRip][HEVC-10bit][日英双语][简繁外挂][FLACx2][MKV]',
    file => file.name.includes('Sanitarybox'), 'human-bd-extra', 1,
  )
  excludeFiles(
    '/[DBD-Raws][四叠半神话大系][01-11TV全集+SP+特典映像][1080P][BDRip][HEVC-10bit][简繁日双语外挂][FLAC][MKV]',
    file => file.name.includes('[SP]'), 'human-bd-extra', 3,
  )
  excludeFiles(
    '/[DBD-Raws][机动战士Z高达][01-50TV全集+SP+剧场版][1080P][BDRip][HEVC-10bit][简繁内封][FLAC][MKV]',
    file => file.name.includes('Mobile Suit Z Gundam A New Translation'), 'human-bd-extra', 3,
  )
  excludeFiles(
    '/[DMG&MH&VCB-Studio] Shoujo Kageki Revue Starlight [Ma10p_1080p]',
    file => !(file.role === 'episode' && file.episode >= 1 && file.episode <= 12), 'human-bd-extra', 67,
  )
  excludeFiles(
    '/[Nekomoe kissaten&VCB-Studio] ODDTAXI [Ma10p_1080p]',
    file => !(file.role === 'episode' && file.episode >= 1 && file.episode <= 13), 'human-bd-extra', 20,
  )
  excludeFiles(
    '/[UHA-WINGS&VCB-Studio] Machikado Mazoku 2-Choume [Ma10p_1080p]',
    file => !(file.role === 'episode' && file.episode >= 1 && file.episode <= 12), 'bd-extra', 44,
  )
  excludeFiles(
    '/[VCB-Studio] MAWARU PENGUINDRUM [Ma10p_1080p]',
    file => !(file.role === 'episode' && file.episode >= 1 && file.episode <= 24), 'bd-extra', 29,
  )
  const maruruk = findDraft(row => row.children.some(file => file.name.includes("Maruruk's Everyday - 04")), 'Maruruk')
  excludeFiles(maruruk.item_key, file => file.name.includes("Maruruk's Everyday - 04"), 'human-bd-extra', 1)
}

const excluded = []
addExclusions()
const exclusionByPath = new Map(excluded.map(item => [item.relativePath, item]))
for (const row of db.prepare('SELECT library_id,rel_path,reason FROM catalog_exclusions').all()) {
  exclusionByPath.set(row.rel_path, { libraryId: row.library_id, relativePath: row.rel_path, reason: row.reason })
}
for (const item of excluded) {
  db.prepare('INSERT INTO catalog_exclusions (library_id,rel_path,reason,created_at) VALUES (?,?,?,?) ON CONFLICT(library_id,rel_path) DO UPDATE SET reason=excluded.reason')
    .run(item.libraryId, item.relativePath, item.reason, now)
  db.prepare('INSERT INTO catalog_exclusion_libraries (library_id) VALUES (?) ON CONFLICT DO NOTHING').run(item.libraryId)
}
for (const row of db.prepare('SELECT item_key,children FROM catalog_draft WHERE library_id = ?').all(library)) {
  const children = JSON.parse(row.children).filter(file => !exclusionByPath.has(file.relativePath))
  updateDraftChildren(row.item_key, children)
}

const kusuriyaS1 = '/[DBD-Raws][吊带袜天使][01-13TV全集+SP+特典映像][1080P][BDRip][HEVC-10bit][日英双语][简繁外挂][FLACx2][MKV]/[Nekomoe kissaten&LoliHouse] Kusuriya no Hitorigoto [WebRip 1080p HEVC-10bit AAC ASSx2]'
const kusuriyaS2 = '/[Nekomoeo kissaten&LoliHouse] Kusuriya no Hitorigoto S2'
for (const [itemKey, season, id, title] of [[kusuriyaS1, 1, '420628', '药屋少女的呢喃'], [kusuriyaS2, 2, '486347', '药屋少女的呢喃 第二季']]) {
  const row = requireDraft(itemKey)
  const children = row.children.map((file, index) => ({ ...file, season, episode: index + 1, role: file.role ?? 'episode' }))
  updateDraftChildren(itemKey, children)
  updateDraftMetadata(itemKey, { title, external_db: 'bangumi', external_id: id })
  updateFormalMetadata(itemKey, { title: title, external_db: 'bangumi', external_id: id })
  const formal = db.prepare('SELECT id FROM catalog_items WHERE library_id = ? AND item_key = ?').get(library, itemKey)
  for (const file of children) db.prepare('UPDATE catalog_children SET season = ?, episode = ?, role = COALESCE(role, ?) WHERE item_id = ? AND rel_path = ?').run(season, file.episode, 'episode', formal.id, file.relativePath)
  db.prepare('UPDATE catalog_items SET subtitle = ? WHERE id = ?').run(episodeSubtitle(children, itemKey), formal.id)
}

const utena = findDraft(row => row.item_key === '/[LoliHouse] Shoujo Kakumei Utena [BDRip]', 'Utena')
const movie = utena.children.filter(file => file.name.includes('Adolescence Mokushiroku'))
const tv = utena.children.filter(file => !file.name.includes('Adolescence Mokushiroku'))
if (movie.length !== 1 || tv.length !== 39) throw new Error(`Utena split changed: ${tv.length}+${movie.length}`)
const filmKey = '#split/offline-utenna-film-1891'
if (db.prepare('SELECT 1 FROM catalog_draft WHERE library_id = ? AND item_key = ?').get(library, filmKey)) throw new Error('Utena split key already exists')
updateDraftChildren(utena.item_key, tv)
updateDraftMetadata(utena.item_key, { title: '少女革命', external_db: 'bangumi', external_id: '1453' })
db.prepare(`INSERT INTO catalog_draft
  (library_id,item_key,signature,query,raw_name,subtitle,files,children,enumerated_at,classified_at,rev,title,original_title,year,overview,external_db,external_id,confirmed_by,status,lookup_state,poster_url,candidates)
  SELECT library_id,?, ?, ?, ?, ?, ?, ?, enumerated_at, classified_at, rev, ?, original_title, year, overview, ?, ?, 'manual', 'confirmed', 'done', NULL, '[]'
  FROM catalog_draft WHERE library_id = ? AND item_key = ?`)
  .run(filmKey, signature(movie), '少女革命 思春期默示录', '思春期默示录', episodeSubtitle(movie, filmKey), movie.length, JSON.stringify(movie), '少女革命 思春期默示录', 'bangumi', '1891', library, utena.item_key)
const formalUtena = db.prepare('SELECT id FROM catalog_items WHERE library_id = ? AND item_key = ?').get(library, utena.item_key)
const moviePath = movie[0].relativePath
db.prepare('DELETE FROM catalog_children WHERE item_id = ? AND rel_path = ?').run(formalUtena.id, moviePath)
updateFormalMetadata(utena.item_key, { title: '少女革命', external_db: 'bangumi', external_id: '1453' })
db.prepare('UPDATE catalog_items SET subtitle = ? WHERE id = ?').run(episodeSubtitle(tv, utena.item_key), formalUtena.id)

const scanCount = db.prepare('SELECT COUNT(*) count FROM catalog_scan WHERE library_id = ?').get(library).count
const draftCount = db.prepare('SELECT COALESCE(SUM(files),0) count FROM catalog_draft WHERE library_id = ?').get(library).count
const exclusionCount = db.prepare('SELECT COUNT(*) count FROM catalog_exclusions WHERE library_id = ?').get(library).count
const draftPaths = db.prepare('SELECT children FROM catalog_draft WHERE library_id = ?').all(library).flatMap(row => JSON.parse(row.children).map(file => file.relativePath))
const excludedPaths = db.prepare('SELECT rel_path FROM catalog_exclusions WHERE library_id = ?').all(library).map(row => row.rel_path)
const accounted = new Set([...draftPaths, ...excludedPaths])
const scanPaths = new Set(db.prepare('SELECT rel_path FROM catalog_scan WHERE library_id = ?').all(library).map(row => row.rel_path))
if (accounted.size !== scanCount || [...scanPaths].some(file => !accounted.has(file))) throw new Error('Anime inventory is not fully accounted for')
if (draftCount + exclusionCount !== scanCount) throw new Error('Anime draft/exclusion counts do not reconcile')

const decisions = {
  revision: 'r6', approvedBy: 'user', productionApplied: false,
  deletions: sourceDecisions.deletions ?? {},
  excludedFiles: [...exclusionByPath.values()].map(item => ({ libraryId: item.libraryId, relativePath: item.relativePath, reason: item.reason })),
  manualBindings: [
    { itemKey: kusuriyaS1, db: 'bangumi', id: '420628', title: '药屋少女的呢喃', season: 1 },
    { itemKey: kusuriyaS2, db: 'bangumi', id: '486347', title: '药屋少女的呢喃 第二季', season: 2 },
    { itemKey: utena.item_key, db: 'bangumi', id: '1453', title: '少女革命', files: 39 },
    { itemKey: filmKey, db: 'bangumi', id: '1891', title: '少女革命 思春期默示录', files: 1 },
  ],
  splits: [{ sourceItemKey: utena.item_key, createdItemKey: filmKey, groups: { tv: 39, movie: 1 } }],
  automaticExclusionsApplied: false,
}
fs.writeFileSync(path.join(target, 'draft-decisions.json'), JSON.stringify(decisions, null, 2) + '\n')
fs.writeFileSync(path.join(target, 'r6-decision-result.json'), JSON.stringify({
  revision: 'r6', productionApplied: false, integrity, anime: { scanCount, draftCount, exclusionCount, accounted: accounted.size },
  newExclusions: excluded, utena: { tv: tv.length, movie: movie.length, filmKey }, kusuriya: { s1: 24, s2: 24 },
}, null, 2) + '\n')
db.close()

const manifest = { derivedFrom: source, revision: 'r6', snapshotMethod: 'VACUUM INTO', integrity, productionApplied: false }
fs.writeFileSync(path.join(target, 'MANIFEST.txt'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ target, integrity, anime: { scanCount, draftCount, exclusionCount }, newExclusions: excluded.length, utena: { tv: tv.length, movie: movie.length }, productionApplied: false }))
