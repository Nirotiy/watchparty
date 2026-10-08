import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createBackend } from '../server/app.ts'
import { openCatalogStore } from '../server/media/catalog-store.ts'
import { parseEpisode } from '../server/media/catalog-names.ts'
import { fetchPosterBytes } from '../server/media/catalog-metadata.ts'
import { imageType } from '../server/media/catalog-offline.ts'

const [sourceArg, targetArg] = process.argv.slice(2)
const source = path.resolve(sourceArg ?? ''), target = path.resolve(targetArg ?? '')
const allowed = path.resolve('D:/WatchParty-Diagnostics') + path.sep
if (![source, target].every(dir => dir.startsWith(allowed)) || source === target || fs.existsSync(target)) throw new Error('Fresh isolated target required')
fs.mkdirSync(path.join(target, 'data'), { recursive: true })
const integrity = {}
for (const file of ['data/watchparty-library.sqlite', 'data/watchparty-catalog.sqlite', 'baseline-catalog.sqlite']) {
  const original = new DatabaseSync(path.join(source, file), { readOnly: true })
  original.prepare('VACUUM INTO ?').run(path.join(target, file)); original.close()
  const copied = new DatabaseSync(path.join(target, file), { readOnly: true })
  integrity[file] = copied.prepare('PRAGMA integrity_check').get().integrity_check; copied.close()
  assert.equal(integrity[file], 'ok')
}
fs.cpSync(path.join(source, 'data/poster-cache'), path.join(target, 'data/poster-cache'), { recursive: true })
for (const file of ['draft-preparation.json', 'inventory-comparison.json', 'scan-result.json', 'papaparse.min.js']) {
  fs.copyFileSync(path.join(source, file), path.join(target, file), fs.constants.COPYFILE_EXCL)
}
const database = path.join(target, 'data/watchparty-catalog.sqlite')
const raw = new DatabaseSync(database)
for (const row of raw.prepare('SELECT item_id,cache_path FROM poster_files').all()) {
  raw.prepare('UPDATE poster_files SET cache_path=? WHERE item_id=?').run(path.join(target, 'data/poster-cache', path.basename(row.cache_path)), row.item_id)
}
raw.close()
// This process is an isolated backend, with no MCP or child process inheriting its private environment.
const backend = createBackend({ host: '127.0.0.1', port: 0, pruneIntervalMs: 0,
  libraryDbPath: path.join(target, 'data/watchparty-library.sqlite'), catalogDbPath: database,
  posterDir: path.join(target, 'data/poster-cache'), catalogSidecarDir: path.join(target, 'data/catalog-sidecars') })
await backend.start()
const catalog = openCatalogStore(database, path.join(target, 'data/poster-cache'))
const libraries = ['lib_anime', 'lib_tv', 'lib_film']
const baseline = libraries.map(id => catalog.snapshotLibrary(id))
const scans = libraries.map(id => catalog.readScan(id))
const confirmed = [], excluded = [], metadata = [], warnings = []
const assets = path.join(target, 'data/catalog-sidecars/offline-assets')
fs.mkdirSync(assets, { recursive: true })
async function json(url, headers = {}) {
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'watchparty offline catalog review', ...headers }, signal: AbortSignal.timeout(20000) })
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
async function details(db, id) {
  if (metadata.some(row => row.db === db && row.id === id)) return metadata.find(row => row.db === db && row.id === id)
  const subject = db === 'bangumi' ? await json('https://api.bgm.tv/v0/subjects/' + id) : await tmdb('/tv/' + id)
  if (db === 'bangumi') assert([2, 6].includes(subject.type), 'Binding is not audiovisual media')
  const detail = { db, id, title: db === 'bangumi' ? subject.name_cn || subject.name : subject.name,
    originalTitle: db === 'bangumi' ? subject.name : subject.original_name,
    date: db === 'bangumi' ? subject.date : subject.first_air_date,
    type: db === 'bangumi' ? subject.type : null,
    overview: db === 'bangumi' ? subject.summary : subject.overview,
    episodes: db === 'bangumi' ? subject.eps || subject.total_episodes : subject.number_of_episodes,
    seasons: db === 'tmdb' ? (subject.seasons ?? []).map(row => ({ season: row.season_number, episodes: row.episode_count })) : [],
    episodeTitles: [], posterUrl: db === 'bangumi' ? subject.images?.large || subject.images?.common : subject.poster_path ? 'https://image.tmdb.org/t/p/w500' + subject.poster_path : null,
    url: db === 'bangumi' ? 'https://bgm.tv/subject/' + id : 'https://www.themoviedb.org/tv/' + id }
  try {
    if (db === 'bangumi') {
      for (let offset = 0; offset < 1000; offset += 100) {
        const page = await json('https://api.bgm.tv/v0/episodes?subject_id=' + id + '&limit=100&offset=' + offset)
        detail.episodeTitles.push(...(page.data ?? []).filter(row => row.type === 0).map(row => ({ season: null, episode: row.sort, title: row.name_cn || row.name })))
        if (offset + 100 >= page.total || !page.data?.length) break
      }
    } else {
      for (const season of detail.seasons.filter(row => row.season > 0 && row.season <= 5)) {
        const page = await tmdb('/tv/' + id + '/season/' + season.season)
        detail.episodeTitles.push(...(page.episodes ?? []).map(row => ({ season: season.season, episode: row.episode_number, title: row.name })))
      }
    }
  } catch { warnings.push({ db, id, reason: 'episode-titles-incomplete' }) }
  metadata.push(detail)
  return detail
}
const cardsByLibrary = new Map(libraries.map(id => [id, catalog.readDraft(id)]))
function card(libraryId, match) {
  const found = cardsByLibrary.get(libraryId).filter(row => row.itemKey.includes(match))
  assert.equal(found.length, 1, 'Card identity changed')
  return found[0]
}
function excludeFiles(libraryId, current, count, select) {
  const chosen = current.children.filter(select)
  assert.equal(chosen.length, count, 'Approved exclusion set changed')
  const paths = new Set(chosen.map(file => file.relativePath))
  current.children = current.children.filter(file => !paths.has(file.relativePath))
  excluded.push(...chosen.map(file => ({ libraryId, relativePath: file.relativePath, reason: 'human-bd-extra' })))
}
function numbered(current, season, count) {
  current.children.forEach(file => {
    const parsed = parseEpisode(file.name)
    file.episode = parsed.episode ?? file.episode
    file.season = season ?? parsed.season ?? file.season
    file.role = 'episode'; file.bonus = false
  })
  const numbers = current.children.map(file => file.episode).sort((a, b) => a - b)
  assert.deepEqual(numbers, Array.from({ length: count }, (_, index) => index + 1), 'Main episode sequence changed')
}
async function bind(libraryId, current, db, id, expected) {
  const detail = await details(db, id)
  Object.assign(current, { title: detail.title, originalTitle: detail.originalTitle, year: Number(detail.date?.slice(0, 4)) || null,
    overview: detail.overview, externalDb: db, externalId: id, posterUrl: null })
  if (detail.posterUrl) {
    const poster = await fetchPosterBytes(detail.posterUrl)
    if (poster) {
      imageType(poster.bytes)
      const hash = createHash('sha256').update(poster.bytes).digest('hex')
      const file = path.join(assets, hash)
      if (!fs.existsSync(file)) fs.writeFileSync(file, poster.bytes, { flag: 'wx' })
      current.posterUrl = 'offline:' + hash
    } else warnings.push({ db, id, reason: 'poster-unavailable' })
  }
  current.children.forEach(file => {
    const title = detail.episodeTitles.find(row => row.episode === file.episode && (db === 'bangumi' || row.season === file.season))?.title
    if (title) file.episodeTitle = title
  })
  confirmed.push({ libraryId, itemKey: current.itemKey, db, id, expected,
    keptPaths: current.children.map(file => file.relativePath) })
  console.log(JSON.stringify({ libraryId, title: current.title, binding: db + ':' + id, files: current.children.length, poster: Boolean(current.posterUrl) }))
}
function split(libraryId, current, suffix, files) {
  assert(files.length)
  const created = { ...current, itemKey: '#split/offline-' + suffix, children: files.map(file => ({ ...file })) }
  const list = cardsByLibrary.get(libraryId)
  list.push(created)
  return created
}
function remove(libraryId, current) {
  cardsByLibrary.set(libraryId, cardsByLibrary.get(libraryId).filter(row => row !== current))
}
try {
  const camp = card('lib_anime', 'Yuru Camp S2'); numbered(camp, 2, 13); await bind('lib_anime', camp, 'bangumi', '262897', [{ season: 2, episodes: 13 }])
  const ghost2 = card('lib_anime', 'S.A.C._2nd_GIG')
  const ghost2Extras = new Set(ghost2.children.slice(0, 13).map(file => file.relativePath))
  excludeFiles('lib_anime', ghost2, 13, file => ghost2Extras.has(file.relativePath)); numbered(ghost2, 2, 26)
  await bind('lib_anime', ghost2, 'bangumi', '326', [{ season: 2, episodes: 26 }])
  const ghost1 = card('lib_anime', '[Stand_Alone_Complex]')
  const ghost1Extras = new Set(ghost1.children.slice(0, 16).map(file => file.relativePath))
  excludeFiles('lib_anime', ghost1, 16, file => ghost1Extras.has(file.relativePath)); numbered(ghost1, 1, 26)
  await bind('lib_anime', ghost1, 'bangumi', '324', [{ season: 1, episodes: 26 }])
  const cowboy = card('lib_anime', '[Cowboy_Bebop]')
  const cowboyExtras = new Set(cowboy.children.slice(0, 7).map(file => file.relativePath))
  excludeFiles('lib_anime', cowboy, 7, file => cowboyExtras.has(file.relativePath)); numbered(cowboy, 1, 26)
  await bind('lib_anime', cowboy, 'bangumi', '253', [{ season: 1, episodes: 26 }])
  const daisan = card('lib_anime', 'Daisan Hikou Shoujotai')
  excludeFiles('lib_anime', daisan, 4, file => !file.name.includes('Musani Staff Credit Ver.'))
  Object.assign(daisan.children[0], { season: null, episode: 1, role: 'episode', bonus: false })
  await bind('lib_anime', daisan, 'bangumi', '126606', [{ season: null, episodes: 1 }])
  const gundam = card('lib_anime', '剧场版三部曲合集')
  for (const [roman, id] of [['I', '38435'], ['II', '38436'], ['III', '38437']]) {
    const files = gundam.children.filter(file => new RegExp('The Movie ' + roman + '(?:\\]| )').test(file.name))
    assert.equal(files.length, 1)
    const next = split('lib_anime', gundam, 'gundam-' + id, files)
    Object.assign(next.children[0], { season: null, episode: 1, role: 'episode', bonus: false })
    await bind('lib_anime', next, 'bangumi', id, [{ season: null, episodes: 1 }])
  }
  remove('lib_anime', gundam)
  const showa = card('lib_anime', '昭和元禄落语心中.2016.全两季')
  for (const [season, text, count, id] of [[1, '第一季', 13, '119394'], [2, '第二季', 12, '176615']]) {
    const next = split('lib_anime', showa, 'showa-' + id, showa.children.filter(file => file.name.includes(text)))
    numbered(next, season, count); await bind('lib_anime', next, 'bangumi', id, [{ season, episodes: count }])
  }
  remove('lib_anime', showa)
  const kamen = card('lib_tv', '[假面骑士W]'); numbered(kamen, 1, 49); await bind('lib_tv', kamen, 'tmdb', '262157', [{ season: 1, episodes: 49 }])
  const minister = card('lib_tv', '/是，大臣')
  const specialFiles = minister.children.filter(file => file.name.includes('Christmas.Special'))
  assert.equal(specialFiles.length, 1)
  minister.children = minister.children.filter(file => !specialFiles.includes(file))
  await bind('lib_tv', minister, 'tmdb', '4549', [1, 2, 3].map(season => ({ season, episodes: 7 })))
  const special = split('lib_tv', minister, 'minister-special-16266', specialFiles)
  Object.assign(special.children[0], { season: null, episode: 1, role: 'episode', bonus: false })
  await bind('lib_tv', special, 'bangumi', '16266', [{ season: null, episodes: 1 }])
  const prime = card('lib_tv', '/是，首相'); await bind('lib_tv', prime, 'tmdb', '12597', [1, 2].map(season => ({ season, episodes: 8 })))
  const wulin = card('lib_tv', '/武林外传'); numbered(wulin, 1, 81); await bind('lib_tv', wulin, 'tmdb', '64709', [{ season: 1, episodes: 81 }])
  await details('bangumi', '18624')
  assert.equal(excluded.length, 40)
  for (const id of libraries) {
    const inventory = new Set(catalog.readScan(id).map(file => file.relativePath))
    const excludedPaths = new Set([...catalog.exclusions(id).items.map(file => file.relativePath), ...excluded.filter(file => file.libraryId === id).map(file => file.relativePath)])
    const cards = cardsByLibrary.get(id)
    const claimed = cards.flatMap(row => row.children.map(file => file.relativePath))
    assert.equal(new Set(claimed).size, claimed.length)
    assert(claimed.every(file => inventory.has(file) && !excludedPaths.has(file)))
    assert.equal(claimed.length + excludedPaths.size, inventory.size)
    catalog.stageOffline(id, cards.map(row => ({ group: { itemKey: row.itemKey, query: row.title || row.query, queries: [row.title || row.query], rawName: row.rawName, files: row.children }, metadata: row })), excluded.filter(file => file.libraryId === id))
  }
  for (const decision of confirmed) assert(catalog.draftEdit(decision.libraryId, decision.itemKey, {}))
  assert.deepEqual(libraries.map(id => catalog.snapshotLibrary(id)), baseline)
  assert.deepEqual(libraries.map(id => catalog.readScan(id)), scans)
  const previous = JSON.parse(fs.readFileSync(path.join(source, 'draft-decisions.json'), 'utf8'))
  const decisions = { ...previous, revision: 'r4', confirmedCards: confirmed,
    excludedFiles: [...previous.excludedFiles, ...excluded], automaticExclusionsApplied: false, productionApplied: false }
  fs.writeFileSync(path.join(target, 'draft-decisions.json'), JSON.stringify(decisions, null, 2) + '\n')
  fs.writeFileSync(path.join(target, 'binding-metadata.json'), JSON.stringify({ metadata, warnings }, null, 2) + '\n')
  fs.writeFileSync(path.join(target, 'revision-result.json'), JSON.stringify({ productionApplied: false, formalUnchanged: true, scanUnchanged: true, integrity,
    confirmed: confirmed.length, newlyExcluded: excluded.length, warnings, libraries: libraries.map(id => ({ id, ...catalog.draftInfo(id), exclusions: catalog.exclusions(id).excluded, diff: catalog.draftDiff(id) })) }, null, 2) + '\n')
  fs.writeFileSync(path.join(target, 'MANIFEST.txt'), JSON.stringify({ derivedFrom: source, snapshotMethod: 'VACUUM INTO', integrity, productionApplied: false }, null, 2) + '\n')
  console.log(JSON.stringify({ confirmed: confirmed.length, newlyExcluded: excluded.length, integrity, warnings, productionApplied: false }))
} finally { catalog.close(); await backend.close() }
