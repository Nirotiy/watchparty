import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { reviewBdExtras } from '../server/media/catalog-extra-review.ts'
import { collectionPath } from '../server/media/collection-sidecar.ts'

const [rootArgument, durationArgument] = process.argv.slice(2)
const root = path.resolve(rootArgument ?? '')
if (!root.startsWith(path.resolve('D:/WatchParty-Diagnostics') + path.sep)) throw new Error('Diagnostic root required')
const durationFile = durationArgument ? path.resolve(durationArgument) : ''
if (durationFile && !durationFile.startsWith(path.resolve('D:/WatchParty-Diagnostics') + path.sep)) throw new Error('Diagnostic duration input required')
const durations = durationFile ? JSON.parse(fs.readFileSync(durationFile, 'utf8')) : {}
const decisions = JSON.parse(fs.readFileSync(path.join(root, 'draft-decisions.json'), 'utf8'))
const suggestions = []
const metadataWarnings = []
const metadataCache = new Map()
async function json(url, headers = {}) {
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'watchparty offline catalog review', ...headers }, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('PUBLIC_METADATA_FAILED')
  return response.json()
}
async function tmdb(route) {
  const key = (process.env.TMDB_API_KEY || process.env.TMDB_READ_TOKEN || '').trim()
  if (!key) throw new Error('TMDB_NOT_CONFIGURED')
  const url = new URL('https://api.themoviedb.org/3' + route)
  url.searchParams.set('language', 'zh-CN')
  const headers = key.startsWith('eyJ') ? { authorization: 'Bearer ' + key } : {}
  if (!key.startsWith('eyJ')) url.searchParams.set('api_key', key)
  return json(url, headers)
}
async function expectedCounts(db, id) {
  const key = `${db}:${id}`
  if (metadataCache.has(key)) return metadataCache.get(key)
  let counts
  if (db === 'bangumi') {
    const pages = []
    let total = 0
    for (let offset = 0; offset < 1000; offset += 100) {
      const page = await json(`https://api.bgm.tv/v0/episodes?subject_id=${encodeURIComponent(id)}&limit=100&offset=${offset}`)
      pages.push(...(page.data ?? []).filter(row => row.type === 0))
      total = page.total ?? pages.length
      if (offset + 100 >= total || !page.data?.length) break
    }
    const actualMain = pages.map(row => Number(row.sort)).filter(Number.isSafeInteger)
    counts = actualMain.length ? [{ season: null, episodes: Math.max(...actualMain) }] : []
  } else {
    const subject = await tmdb(`/tv/${encodeURIComponent(id)}`)
    counts = (subject.seasons ?? []).filter(row => row.season_number > 0 && row.episode_count > 0)
      .map(row => ({ season: row.season_number, episodes: row.episode_count }))
  }
  metadataCache.set(key, counts)
  return counts
}
const bundles = JSON.parse(fs.readFileSync(path.join(root, 'bundle-results.json'), 'utf8')).reports
for (const bundle of bundles) {
  const directory = path.join(root, 'review-upload/bundles/offline-bundles', bundle.bundleId)
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  const excluded = new Set(manifest.exclusions.map(file => file.relativePath))
  const humanKept = new Set(decisions.excludedFiles.filter(row => row.action === 'keep').map(row => row.relativePath))
  for (const entry of manifest.entries) {
    const collection = JSON.parse(fs.readFileSync(path.join(directory, entry.collection.file), 'utf8'))
    const members = collection.members.map(member => {
      const relativePath = collectionPath(collection.basePath || '/', member.path)
      if (!relativePath) throw new Error('OFFLINE_COLLECTION_PATH_INVALID')
      return { relativePath, name: path.posix.basename(relativePath), size: member.size ?? null,
        season: member.season ?? null, episode: member.episode ?? null,
        durationSeconds: durations[relativePath] ?? null, keepByHuman: humanKept.has(relativePath) }
    }).filter(file => !excluded.has(file.relativePath))
    let expected = []
    if (collection.external?.id && collection.external?.db) {
      try { expected = await expectedCounts(collection.external.db, collection.external.id) }
      catch { metadataWarnings.push({ itemKey: entry.itemKey, reason: 'episode-count-unavailable' }) }
    }
    // Single-season APIs often omit the season number. Keep the season already
    // assigned to this offline card, including cards explicitly marked S2.
    if (expected.length === 1 && expected[0].season === null) {
      const seasons = [...new Set(members.map(file => file.season).filter(Number.isSafeInteger))]
      if (seasons.length === 1) expected = [{ ...expected[0], season: seasons[0] }]
    }
    const report = reviewBdExtras({ libraryId: bundle.libraryId, itemKey: entry.itemKey, files: members, expected })
    suggestions.push({ bundleId: bundle.bundleId, title: collection.title, external: collection.external, ...report })
    if (suggestions.length % 10 === 0) console.log(JSON.stringify({ reviewedCards: suggestions.length }))
  }
}
const canonical = JSON.stringify({ revision: decisions.revision, suggestions: suggestions.map(row => ({
  libraryId: row.libraryId, itemKey: row.itemKey, fingerprint: row.fingerprint,
  files: row.files.map(file => [file.relativePath, file.action, file.reasons]),
})) })
const output = { schema: 1, revision: decisions.revision, generatedAt: new Date().toISOString(), productionApplied: false,
  policy: { automaticExclusionsApplied: false, humanConfirmationRequired: true,
    durationSource: durationFile ? path.basename(durationFile) : null, noDurationMeansZero: false },
  fingerprint: createHash('sha256').update(canonical).digest('hex'), metadataWarnings, suggestions }
fs.writeFileSync(path.join(root, 'bd-exclusion-suggestions.json'), JSON.stringify(output, null, 2) + '\n')
const csvEscape = value => {
  const text = String(value ?? '')
  return /[\"\r\n,]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
const csv = ['libraryId,itemKey,title,relativePath,size,durationSeconds,action,confidence,reasons,fingerprint']
for (const card of suggestions) for (const file of card.files) csv.push([
  card.libraryId, card.itemKey, card.title, file.relativePath, file.size, file.durationSeconds,
  file.action, file.confidence, file.reasons.join('; '), card.fingerprint,
].map(csvEscape).join(','))
const csvText = csv.join('\r\n') + '\r\n'
fs.writeFileSync(path.join(root, 'bd-exclusion-suggestions.csv'), csvText)
const reviewBundle = path.join(root, 'review-upload/bundles')
if (fs.existsSync(reviewBundle)) fs.writeFileSync(path.join(reviewBundle, 'bd-exclusion-suggestions.csv'), csvText)
console.log(JSON.stringify({ reviewed: suggestions.length,
  proposed: suggestions.reduce((total, row) => total + row.count.proposedExclusions, 0),
  inspect: suggestions.reduce((total, row) => total + row.files.filter(file => file.action === 'inspect').length, 0),
  durationAvailable: Boolean(durationFile), metadataWarnings: metadataWarnings.length, productionApplied: false }))
