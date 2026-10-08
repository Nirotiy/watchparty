import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openCatalogStore } from '../server/media/catalog-store.ts'

const [sourceArgument, targetArgument] = process.argv.slice(2)
const source = path.resolve(sourceArgument ?? '')
const target = path.resolve(targetArgument ?? '')
const allowed = path.resolve('D:/WatchParty-Diagnostics') + path.sep
if (![source, target].every(directory => directory.startsWith(allowed)) || source === target || fs.existsSync(target)) throw new Error('A new independent diagnostic copy is required')
fs.mkdirSync(path.join(target, 'data'), { recursive: true })
const integrity = {}
for (const file of ['data/watchparty-library.sqlite', 'data/watchparty-catalog.sqlite', 'baseline-catalog.sqlite']) {
  const original = new DatabaseSync(path.join(source, file), { readOnly: true })
  original.prepare('VACUUM INTO ?').run(path.join(target, file))
  original.close()
  const copied = new DatabaseSync(path.join(target, file), { readOnly: true })
  integrity[file] = copied.prepare('PRAGMA integrity_check').get().integrity_check
  copied.close()
  if (integrity[file] !== 'ok') throw new Error('Copy integrity failed')
}
fs.cpSync(path.join(source, 'data/poster-cache'), path.join(target, 'data/poster-cache'), { recursive: true, errorOnExist: true })
for (const file of ['draft-preparation.json', 'inventory-comparison.json', 'scan-result.json']) fs.copyFileSync(path.join(source, file), path.join(target, file), fs.constants.COPYFILE_EXCL)
const database = path.join(target, 'data/watchparty-catalog.sqlite')
const copy = new DatabaseSync(database)
for (const row of copy.prepare('SELECT item_id,cache_path FROM poster_files').all()) {
  const poster = path.join(target, 'data/poster-cache', path.basename(row.cache_path))
  if (!fs.existsSync(poster)) throw new Error('Copied poster missing')
  copy.prepare('UPDATE poster_files SET cache_path=? WHERE item_id=?').run(poster, row.item_id)
}
copy.close()
const catalog = openCatalogStore(database, path.join(target, 'data/poster-cache'))
const previous = JSON.parse(fs.readFileSync(path.join(source, 'bundle-results.json'), 'utf8'))
const missingHumanKey = '/[SweetSub] Made in Abyss Compendium Films [BDRip][1080P][AVC 8bit][CHS]'
const extras = previous.reports.find(report => report.libraryId === 'lib_anime').unassigned
if (extras.length !== 28) throw new Error('Approved extra-file set changed')
const reports = []
try {
  const before = catalog.snapshotLibrary('lib_anime')
  const cards = catalog.readDraft('lib_anime')
  const inventory = new Map(catalog.readScan('lib_anime').map(file => [file.relativePath, file]))
  const claimed = new Set(cards.flatMap(card => card.children.map(child => child.relativePath)))
  for (const relativePath of extras) {
    const file = inventory.get(relativePath)
    if (!file || claimed.has(relativePath)) throw new Error('Approved extra-file inventory changed')
    const owners = cards.filter(card => relativePath.startsWith(card.itemKey + '/')).sort((a, b) => b.itemKey.length - a.itemKey.length)
    if (!owners.length || (owners[1] && owners[0].itemKey.length === owners[1].itemKey.length)) throw new Error('Extra file has no unique containing card')
    reports.push({ itemKey: owners[0].itemKey, relativePath, reason: 'bd-extra', visible: false, countsAsEpisode: false })
  }
  catalog.markExcluded('lib_anime', extras, 'bd-extra')
  const exclusions = catalog.exclusions('lib_anime')
  const excluded = new Set(exclusions.items.map(item => item.relativePath))
  const draftMembers = catalog.readDraft('lib_anime').flatMap(card => card.children)
  if (exclusions.excluded !== 28 || exclusions.stale !== 0 || extras.some(file => !excluded.has(file)) ||
      draftMembers.some(file => excluded.has(file.relativePath)) || draftMembers.length + exclusions.excluded !== inventory.size) {
    throw new Error('BD extras must stay in scan inventory and out of visible draft members')
  }
  if (JSON.stringify(before) !== JSON.stringify(catalog.snapshotLibrary('lib_anime'))) throw new Error('Formal cards changed')
  const missing = before.find(card => card.itemKey === missingHumanKey)
  if (!missing || missing.children.some(child => inventory.has(child.relPath))) throw new Error('Approved deletion no longer has all files missing')
  fs.writeFileSync(path.join(target, 'draft-decisions.json'), JSON.stringify({ revision: 'r3', approvedBy: 'user',
    productionApplied: false, deletions: { lib_anime: [missingHumanKey] }, excludedFiles: reports }, null, 2) + '\n')
  fs.writeFileSync(path.join(target, 'revision-result.json'), JSON.stringify({ formalUnchanged: true, integrity,
    extras: reports, scanFiles: inventory.size, draftMembers: draftMembers.length, excluded: exclusions.excluded,
    staleExclusions: exclusions.stale, diff: catalog.draftDiff('lib_anime') }, null, 2) + '\n')
  fs.writeFileSync(path.join(target, 'MANIFEST.txt'), JSON.stringify({ derivedFrom: source, snapshotMethod: 'VACUUM INTO', integrity, productionApplied: false }, null, 2) + '\n')
  console.log(JSON.stringify({ target, integrity, excluded: exclusions.excluded, scanFiles: inventory.size,
    draftMembers: draftMembers.length, owners: [...new Set(reports.map(report => report.itemKey))], formalUnchanged: true }))
} finally { catalog.close() }
