import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createBackend } from '../server/app.ts'
import { openCatalogStore } from '../server/media/catalog-store.ts'
import { groupScanFiles, isEpisodeFile } from '../server/media/catalog-names.ts'
import { createBangumiClient, fetchPosterBytes } from '../server/media/catalog-metadata.ts'
import { exportOfflineBundle } from '../server/media/catalog-offline.ts'
import { loadConfig } from '../server/config.ts'

const [mode, rootArgument, inventoryArgument] = process.argv.slice(2)
const root = path.resolve(rootArgument ?? '')
if (!root.startsWith(path.resolve('D:/WatchParty-Diagnostics') + path.sep)) throw new Error('Independent diagnostic root required')
const database = path.join(root, 'data/watchparty-catalog.sqlite')
const reportPath = path.join(root, 'inventory-comparison.json')
const libraryIds = ['lib_anime', 'lib_tv', 'lib_film']
if (mode === 'scan') {
  const backend = createBackend({ host: '127.0.0.1', port: 0, pruneIntervalMs: 0,
    libraryDbPath: path.join(root, 'data/watchparty-library.sqlite'), catalogDbPath: database,
    posterDir: path.join(root, 'data/poster-cache'), catalogSidecarDir: path.join(root, 'data/catalog-sidecars') })
  const reports = []
  await backend.start()
  try {
    const origin = `http://127.0.0.1:${backend.port}`
    for (const id of libraryIds) {
      const route = `${origin}/api/admin/media-libraries/${id}/scan`
      const before = await (await fetch(route)).json()
      const post = await fetch(route, { method: 'POST', signal: AbortSignal.timeout(30000) })
      if (![200, 202].includes(post.status)) throw new Error('Isolated scan rejected')
      const deadline = Date.now() + 360000
      let result
      do {
        await new Promise(resolve => setTimeout(resolve, 1000))
        result = await (await fetch(route)).json()
      } while (result.running && Date.now() < deadline)
      if (result.running || result.rev <= before.rev) throw new Error('Scan did not advance')
      reports.push({ id, files: result.files, beforeRev: before.rev, afterRev: result.rev })
      console.log(JSON.stringify(reports.at(-1)))
    }
    await fs.writeFile(path.join(root, 'scan-result.json'), JSON.stringify({ passed: true, reports }, null, 2) + '\n')
  } finally { await backend.close() }
} else if (mode === 'compare') {
  const inventory = JSON.parse(await fs.readFile(inventoryArgument, 'utf8'))
  const db = new DatabaseSync(database, { readOnly: true })
  const libraries = inventory.libraries.map(library => {
    const local = db.prepare('SELECT rel_path,name,size FROM catalog_scan WHERE library_id=?').all(library.libraryId)
    const targetByPath = new Map(library.files.map(file => [file.relativePath, file]))
    const localByPath = new Map(local.map(file => [file.rel_path, file]))
    const missing = local.filter(file => !targetByPath.has(file.rel_path))
    const added = library.files.filter(file => !localByPath.has(file.relativePath))
    return { libraryId: library.libraryId, localFiles: local.length, targetFiles: library.files.length,
      missing, added, sizeMismatches: local.filter(file => targetByPath.has(file.rel_path) && file.size !== targetByPath.get(file.rel_path).size),
      proposedMoves: added.map(file => ({ to: file.relativePath, from: missing.filter(old => old.name === file.name && old.size === file.size).map(old => old.rel_path) })).filter(move => move.from.length === 1) }
  })
  db.close()
  await fs.writeFile(reportPath, JSON.stringify({ libraries }, null, 2) + '\n')
  console.log(JSON.stringify(libraries.map(library => ({ id: library.libraryId, local: library.localFiles, target: library.targetFiles, missing: library.missing.length, added: library.added.length, sizeMismatches: library.sizeMismatches.length, proposedMoves: library.proposedMoves.length }))))
} else if (mode === 'prepare') {
  const baselineFile = path.join(root, 'baseline-catalog.sqlite')
  const baselineDb = new DatabaseSync(baselineFile, { readOnly: true })
  const integrity = baselineDb.prepare('PRAGMA integrity_check').get().integrity_check
  if (integrity !== 'ok') throw new Error('Baseline integrity failed')
  baselineDb.close()
  const posterDir = path.join(root, 'data/poster-cache')
  const baseline = openCatalogStore(baselineFile, posterDir)
  const catalog = openCatalogStore(database, posterDir)
  const reports = []
  try {
    // Only copied catalog rows change; source poster paths must never be read by export.
    const copy = new DatabaseSync(database)
    for (const id of libraryIds) for (const poster of catalog.posterRows(id)) {
      const destination = path.join(posterDir, path.basename(poster.cachePath))
      await fs.access(destination)
      copy.prepare('UPDATE poster_files SET cache_path=? WHERE item_id=?').run(destination, poster.itemId)
    }
    copy.close()
    for (const id of libraryIds) {
      const previous = baseline.readScan(id)
      const current = catalog.readScan(id)
      const byPath = new Map(current.map(file => [file.relativePath, file]))
      const previousPaths = new Set(previous.map(file => file.relativePath))
      const missing = previous.filter(file => !byPath.has(file.relativePath))
      const added = current.filter(file => !previousPaths.has(file.relativePath))
      const moves = added.flatMap(file => {
        const matches = missing.filter(old => old.name === file.name && old.size !== null && old.size === file.size)
        const targets = added.filter(other => other.name === file.name && other.size === file.size)
        return matches.length === 1 && targets.length === 1 ? [{ from: matches[0].relativePath, to: file.relativePath, size: file.size }] : []
      })
      const movedPaths = new Map(moves.map(move => [move.from, move.to]))
      const excluded = new Set(catalog.exclusions(id).items.filter(item => !item.stale).map(item => item.relativePath))
      const claimed = new Set()
      const formal = baseline.snapshotLibrary(id)
      const oldCards = baseline.readDraft(id)
      const cards = []
      const emptied = []
      for (const old of oldCards) {
        const protectedCard = formal.find(card => card.itemKey === old.itemKey && card.status === 'confirmed')
        const metadata = protectedCard ?? old
        const sourceChildren = protectedCard ? protectedCard.children.map(child => ({ ...child, relativePath: child.relPath })) : old.children
        const files = sourceChildren.flatMap(child => {
          const destination = movedPaths.get(child.relativePath) ?? child.relativePath
          const actual = byPath.get(destination)
          if (!actual || excluded.has(destination)) return []
          if (claimed.has(destination)) throw new Error('Existing cards claim the same current file')
          claimed.add(destination)
          return [{ ...child, relativePath: destination, name: actual.name, mediaId: actual.mediaId,
            role: child.role ?? (isEpisodeFile(child, old.itemKey) ? 'episode' : 'bonus') }]
        })
        if (!files.length) { emptied.push({ itemKey: old.itemKey, title: metadata.title, confirmedBy: metadata.confirmedBy }); continue }
        cards.push({ group: { itemKey: old.itemKey, query: old.query, queries: [old.query], rawName: old.rawName, files },
          metadata: { title: metadata.title, originalTitle: metadata.originalTitle, year: metadata.year, overview: metadata.overview,
            externalDb: metadata.externalDb, externalId: metadata.externalId, posterUrl: old.posterUrl } })
      }
      const newGroups = groupScanFiles(current.filter(file => !claimed.has(file.relativePath) && !excluded.has(file.relativePath)))
      for (const group of newGroups) {
        if (cards.some(card => card.group.itemKey === group.itemKey)) throw new Error('New files overlap an existing card key; review required')
        cards.push({ group, metadata: { title: group.query } })
      }
      catalog.stageOffline(id, cards, [])
      reports.push({ libraryId: id, previousFiles: previous.length, currentFiles: current.length,
        missing: missing.filter(file => !movedPaths.has(file.relativePath)), added: added.filter(file => !moves.some(move => move.to === file.relativePath)),
        moves, emptied, newCards: newGroups.map(group => ({ itemKey: group.itemKey, query: group.query, files: group.files.length })), diff: catalog.draftDiff(id) })
    }
    await fs.writeFile(path.join(root, 'draft-preparation.json'), JSON.stringify({ baselineIntegrity: integrity, productionApplied: false, reports }, null, 2) + '\n')
    console.log(JSON.stringify(reports.map(report => ({ id: report.libraryId, missing: report.missing.length, added: report.added.length, moves: report.moves.length, emptied: report.emptied.length, newCards: report.newCards }))))
  } finally { baseline.close(); catalog.close() }
} else if (mode === 'lookup') {
  const catalog = openCatalogStore(database, path.join(root, 'data/poster-cache'))
  const copy = new DatabaseSync(database)
  try {
    for (const id of libraryIds) {
      for (const card of catalog.readDraft(id)) {
        const formal = catalog.snapshotLibrary(id).find(item => item.itemKey === card.itemKey && item.status === 'confirmed')
        if (!card.externalId && formal) catalog.draftImport(id, card.itemKey, formal)
      }
      copy.prepare("UPDATE catalog_draft SET lookup_state='pending' WHERE library_id=? AND external_id IS NULL AND confirmed_by IS NULL").run(id)
    }
  } finally { copy.close(); catalog.close() }
  const backend = createBackend({ host: '127.0.0.1', port: 0, pruneIntervalMs: 0,
    libraryDbPath: path.join(root, 'data/watchparty-library.sqlite'), catalogDbPath: database,
    posterDir: path.join(root, 'data/poster-cache'), catalogSidecarDir: path.join(root, 'data/catalog-sidecars'), catalogMaxLookups: 100 })
  await backend.start()
  const reports = []
  try {
    for (const id of libraryIds) {
      const response = await fetch(`http://127.0.0.1:${backend.port}/api/admin/media-libraries/${id}/prepare`, { method: 'POST', signal: AbortSignal.timeout(600000) })
      if (response.status !== 200) throw new Error(`Draft lookup rejected: ${response.status}`)
      const result = await response.json()
      reports.push({ libraryId: id, result })
      console.log(JSON.stringify({ libraryId: id, lookups: result.lookups, pending: result.pending }))
    }
    await fs.writeFile(path.join(root, 'lookup-result.json'), JSON.stringify({ reports }, null, 2) + '\n')
  } finally { await backend.close() }
} else if (mode === 'enrich') {
  const catalog = openCatalogStore(database, path.join(root, 'data/poster-cache'))
  const bangumi = createBangumiClient(fetch, loadConfig().bangumiToken)
  const episodeResults = new Map()
  const reports = []
  try {
    for (const id of libraryIds) {
      const cards = catalog.readDraft(id)
      const formal = catalog.snapshotLibrary(id)
      for (const card of cards) {
        const report = { libraryId: id, itemKey: card.itemKey, titles: 0, poster: false, warnings: [] }
        const needsTitles = card.children.some(child => isEpisodeFile(child, card.itemKey) && child.episode !== null && !child.episodeTitle)
        if (card.externalDb === 'bangumi' && card.externalId && needsTitles) {
          if (!episodeResults.has(card.externalId)) {
            try { episodeResults.set(card.externalId, await bangumi.episodeTitles(card.externalId)) }
            catch { episodeResults.set(card.externalId, null) }
            await new Promise(resolve => setTimeout(resolve, 1100))
          }
          const titles = episodeResults.get(card.externalId)
          if (!titles) report.warnings.push('episode-lookup-failed')
          for (const child of card.children) {
            child.role ??= isEpisodeFile(child, card.itemKey) ? 'episode' : 'bonus'
            child.episodeTitle = child.episodeTitle ?? (child.role === 'episode' && child.episode !== null ? titles?.get(child.episode) ?? null : null)
          }
        }
        report.titles = card.children.filter(child => child.episodeTitle).length
        const item = formal.find(item => item.itemKey === card.itemKey && item.externalDb === card.externalDb && item.externalId === card.externalId)
        if (item && catalog.readPoster(item.id)) report.poster = true
        else if (item && card.posterUrl?.startsWith('https://')) {
          const poster = await fetchPosterBytes(card.posterUrl)
          if (poster) { catalog.writePoster(item.id, poster.contentType, poster.bytes); report.poster = true }
          else report.warnings.push('poster-fetch-failed')
        }
        if (!card.externalId) report.warnings.push('binding-required')
        reports.push(report)
        console.log(JSON.stringify({ libraryId: id, completed: reports.length, titles: report.titles, poster: report.poster, warnings: report.warnings }))
      }
      catalog.stageOffline(id, cards.map(card => ({ group: { itemKey: card.itemKey, query: card.query, queries: [card.query], rawName: card.rawName, files: card.children }, metadata: card })), [])
    }
    await fs.writeFile(path.join(root, 'enrichment-result.json'), JSON.stringify({ reports }, null, 2) + '\n')
  } finally { catalog.close() }
} else if (mode === 'export') {
  const catalog = openCatalogStore(database, path.join(root, 'data/poster-cache'))
  try {
    const decisions = await fs.readFile(path.join(root, 'draft-decisions.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return { revision: '', deletions: {} }; throw error })
    if (decisions.revision && !/^r[0-9]+$/.test(decisions.revision)) throw new Error('Invalid revision')
    const reports = libraryIds.map(id => exportOfflineBundle(catalog, path.join(root, 'data/catalog-sidecars'), id, `offline-20261001-${decisions.revision ? decisions.revision + '-' : ''}${id}`, decisions.deletions[id] ?? []))
    await fs.writeFile(path.join(root, 'bundle-results.json'), JSON.stringify({ productionApplied: false, reports }, null, 2) + '\n')
    console.log(JSON.stringify(reports.map(report => ({ id: report.libraryId, cards: report.cards, members: report.members, posters: report.posters, conflicts: report.conflicts, passed: report.passed }))))
  } finally { catalog.close() }
} else throw new Error('Mode must be scan, compare, prepare, lookup, enrich or export')
