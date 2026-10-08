import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createBackend } from '../server/app.ts'
import { createBangumiClient, createTmdbClient } from '../server/media/catalog-metadata.ts'

const root = path.resolve(process.argv[2] ?? '')
if (!root.startsWith(path.resolve('D:/WatchParty-Diagnostics') + path.sep)) throw new Error('Independent diagnostic root required')
// This is an isolated backend process. Private provider configuration stays here;
// no MCP or child process is started, and reports contain public metadata only.
const backend = createBackend({ host: '127.0.0.1', port: 0, pruneIntervalMs: 0,
  libraryDbPath: path.join(root, 'data/watchparty-library.sqlite'), catalogDbPath: path.join(root, 'data/watchparty-catalog.sqlite'),
  posterDir: path.join(root, 'data/poster-cache'), catalogSidecarDir: path.join(root, 'data/catalog-sidecars') })
const bangumi = createBangumiClient(fetch, process.env.BANGUMI_TOKEN ?? '')
const tmdb = createTmdbClient()
const specifications = [
  { id: 'camp2', match: 'Yuru Camp S2', bangumi: ['262897'], queries: [], note: '第二季，不采用第一季候选。正片与 SP 分开统计。' },
  { id: 'gundam-films', match: '机动战士高达0079剧场版三部曲合集', bangumi: ['26851'], queries: ['機動戦士ガンダムII 哀・戦士編', '機動戦士ガンダムIII めぐりあい宇宙編'], note: '三部独立电影，建议拆成三张卡；已批准保留的 PV/menu 按片名跟随对应电影，role=bonus。' },
  { id: 'ghost2', match: 'S.A.C._2nd_GIG', bangumi: ['326'], queries: [], note: '2nd GIG 第二季，不采用塔奇克马日常或剧场版。' },
  { id: 'ghost1', match: '[Stand_Alone_Complex]', bangumi: ['324'], queries: [], note: 'STAND ALONE COMPLEX 第一季，与第二季分卡。' },
  { id: 'cowboy', match: '[Cowboy_Bebop]', bangumi: ['253'], queries: [], note: '1998 动画版，不采用 2021 真人版；片头片尾等附加视频不计正片。' },
  { id: 'daisan', match: 'Daisan Hikou Shoujotai', bangumi: [], queries: ['第三飞行少女队', '第三飛行少女隊'], note: '01 两个片尾职员表版本是同一集的不同版本，不能算两集；NCOP/NCED/PV 为附加内容。需要选择主版本。' },
  { id: 'showa', match: '昭和元禄落语心中.2016.全两季', bangumi: ['119394', '176615'], queries: [], note: '第一季 13 集和助六再临篇 12 集在同一目录，建议拆两张卡并写 S1/S2；不能整张绑定第一季。' },
  { id: 'kamenw', match: '[假面骑士W]', tmdb: ['262157'], queries: ['假面骑士W'], note: '2009 假面骑士W 49 集，不采用 1971 总系列或 Wizard。' },
  { id: 'minister', match: '/是，大臣', tmdb: [], queries: ['Yes Minister'], note: '原版 1980 系列，按三个季组织；单独识别 1984 圣诞特别篇。' },
  { id: 'prime-minister', match: '/是，首相', tmdb: [], queries: ['Yes Prime Minister'], note: '原版 1986 系列，两季各 8 集，不采用 2013 重启版。' },
  { id: 'wulin', match: '/武林外传', tmdb: ['64709'], queries: ['武林外传'], note: '2006 电视剧，不采用其它年份同名条目；额外文件与官方集数的关系须逐文件核对。' },
]
const database = new DatabaseSync(path.join(root, 'data/watchparty-catalog.sqlite'), { readOnly: true })
const cards = database.prepare('SELECT library_id,item_key,title,children FROM catalog_draft WHERE external_id IS NULL ORDER BY library_id,item_key').all().map(card => ({ libraryId: card.library_id, itemKey: card.item_key, title: card.title, files: JSON.parse(card.children) }))
database.close()
if (cards.length !== specifications.length) throw new Error('Unresolved card set changed')
const failures = []
async function json(url, headers = {}) {
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'watchparty/0.1.0 (offline review)', ...headers }, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`Provider status ${response.status}`)
  return response.json()
}
function tmdbRequest(route) {
  const key = (process.env.TMDB_API_KEY || process.env.TMDB_READ_TOKEN || '').trim()
  if (!key) throw new Error('TMDB is not configured')
  const url = new URL(`https://api.themoviedb.org/3${route}`)
  url.searchParams.set('language', 'zh-CN')
  const headers = key.startsWith('eyJ') ? { authorization: `Bearer ${key}` } : {}
  if (!key.startsWith('eyJ')) url.searchParams.set('api_key', key)
  return json(url, headers)
}
async function detail(db, id) {
  if (!/^\d+$/.test(id)) throw new Error('Invalid public metadata ID')
  if (db === 'bangumi') {
    const subject = await json(`https://api.bgm.tv/v0/subjects/${id}`)
    const episodes = []
    for (let offset = 0; offset < 500; offset += 100) {
      const page = await json(`https://api.bgm.tv/v0/episodes?subject_id=${id}&limit=100&offset=${offset}`)
      episodes.push(...(page.data ?? []).map(episode => ({ season: null, type: episode.type, number: episode.sort, title: episode.name_cn || episode.name || '', airdate: episode.airdate })))
      if (offset + 100 >= page.total || !page.data?.length) break
    }
    return { db, id, title: subject.name_cn || subject.name, originalTitle: subject.name, date: subject.date,
      type: subject.type, episodeCount: subject.eps, totalEpisodes: subject.total_episodes,
      url: `https://bgm.tv/subject/${id}`, episodes }
  }
  const subject = await tmdbRequest(`/tv/${id}`)
  const seasons = (subject.seasons ?? []).map(season => ({ season: season.season_number, episodes: season.episode_count, date: season.air_date, title: season.name }))
  const episodes = []
  for (const season of seasons.filter(season => season.season > 0 && season.episodes > 0 && season.season <= 5)) {
    const page = await tmdbRequest(`/tv/${id}/season/${season.season}`)
    episodes.push(...(page.episodes ?? []).map(episode => ({ season: season.season, type: 0, number: episode.episode_number, title: episode.name, airdate: episode.air_date })))
  }
  return { db, id, title: subject.name, originalTitle: subject.original_name, date: subject.first_air_date,
    episodeCount: subject.number_of_episodes, seasons, url: `https://www.themoviedb.org/tv/${id}`, episodes }
}
const reports = []
await backend.start()
try {
  for (const specification of specifications) {
    const matched = cards.filter(card => card.itemKey.includes(specification.match))
    if (matched.length !== 1) throw new Error(`Card identity not unique: ${specification.id}`)
    const card = matched[0]
    const provider = specification.tmdb ? 'tmdb' : 'bangumi'
    const hits = []
    for (const query of specification.queries) {
      try {
        const results = await (provider === 'tmdb' ? tmdb : bangumi).search(query, provider === 'tmdb' ? 'tv' : 'anime')
        hits.push(...results.map(hit => ({ db: hit.externalDb, id: hit.externalId, title: hit.title, originalTitle: hit.originalTitle, year: hit.year, episodes: hit.episodes })))
      } catch { failures.push({ card: specification.id, query, operation: 'search' }) }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    const identities = [...new Set([...(specification.bangumi ?? specification.tmdb ?? []), ...hits.filter(hit =>
      specification.id === 'minister' ? hit.year === 1980 : specification.id === 'prime-minister' ? hit.year === 1986 :
      specification.id === 'gundam-films' ? hit.year === 1981 || hit.year === 1982 : specification.id === 'daisan' ? hit.title.includes('飞行少女') || hit.title.includes('飛行少女') : false).map(hit => hit.id)])]
    const details = []
    for (const id of identities) {
      try { details.push(await detail(provider, id)) }
      catch { failures.push({ card: specification.id, id, operation: 'detail' }) }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    reports.push({ ...card, reviewId: specification.id, recommendation: specification.note, hits, details })
    console.log(JSON.stringify({ card: specification.id, files: card.files.length, hits: hits.length, verifiedDetails: details.map(item => ({ db: item.db, id: item.id, title: item.title, date: item.date, episodes: item.episodeCount })) }))
  }
  fs.writeFileSync(path.join(root, 'binding-research.json'), JSON.stringify({ researchedAt: new Date().toISOString(), bindingsApplied: false, reports, failures }, null, 2) + '\n')
  console.log(JSON.stringify({ reviewed: reports.length, failures, bindingsApplied: false }))
} finally { await backend.close() }
