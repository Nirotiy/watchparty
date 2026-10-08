import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openCatalogStore } from '../server/media/catalog-store.ts'
import { inspectOfflineBundle, stageOfflineBundle } from '../server/media/catalog-offline.ts'

const root = '/work'
const baseline = path.join(root, 'catalog-baseline-complete/watchparty-catalog.sqlite')
const destination = path.join(root, 'target-check')
if (fs.existsSync(destination)) throw new Error('A fresh independent target copy is required')
fs.mkdirSync(destination)
const database = path.join(destination, 'watchparty-catalog.sqlite')
const source = new DatabaseSync(baseline, { readOnly: true })
source.prepare('VACUUM INTO ?').run(database)
source.close()
const copy = new DatabaseSync(database)
if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Target integrity failed')
for (const row of copy.prepare('SELECT item_id,cache_path FROM poster_files').all()) {
  copy.prepare('UPDATE poster_files SET cache_path=? WHERE item_id=?').run(path.join(root, 'catalog-baseline-complete/poster-cache', path.basename(row.cache_path)), row.item_id)
}
const approvalsBefore = copy.prepare('SELECT COUNT(*) count FROM catalog_approvals').get().count
copy.close()
const catalog = openCatalogStore(database, path.join(root, 'catalog-baseline-complete/poster-cache'))
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'backend-inventory.json'), 'utf8'))
const reports = []
const bundles = JSON.parse(fs.readFileSync(path.join(root, 'bundle-results.json'), 'utf8')).reports
try {
  for (const library of inventory.libraries) {
    if (!['lib_anime', 'lib_tv', 'lib_film'].includes(library.libraryId)) continue
    const before = catalog.snapshotLibrary(library.libraryId)
    catalog.writeScan(library.libraryId, library.files)
    const bundleId = bundles.find(bundle => bundle.libraryId === library.libraryId)?.bundleId
    if (!bundleId) throw new Error('Reviewed bundle missing')
    const sidecarRoot = path.join(root, 'bundles')
    const report = inspectOfflineBundle(catalog, sidecarRoot, library.libraryId, bundleId).report
    const stage = report.passed ? stageOfflineBundle(catalog, sidecarRoot, library.libraryId, bundleId, report.bundleSha256) : null
    if (JSON.stringify(before) !== JSON.stringify(catalog.snapshotLibrary(library.libraryId))) throw new Error('Formal catalog changed during staging')
    reports.push({ ...report, staged: Boolean(stage), diff: stage?.diff ?? null })
  }
} finally { catalog.close() }
const checked = new DatabaseSync(database, { readOnly: true })
const approvalsAfter = checked.prepare('SELECT COUNT(*) count FROM catalog_approvals').get().count
const integrity = checked.prepare('PRAGMA integrity_check').get().integrity_check
checked.close()
if (approvalsBefore !== approvalsAfter || integrity !== 'ok') throw new Error('Target-copy invariant failed')
fs.writeFileSync(path.join(root, 'target-check-result.json'), JSON.stringify({ productionApplied: false, integrity, approvalsBefore, approvalsAfter, reports }, null, 2) + '\n')
console.log(JSON.stringify({ integrity, approvalsBefore, approvalsAfter, reports: reports.map(report => ({ libraryId: report.libraryId, cards: report.cards, members: report.members, posters: report.posters, conflicts: report.conflicts, unassigned: report.unassigned.length, passed: report.passed, staged: report.staged })) }))
