import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
const js = ts.transpile(readFileSync(new URL('../src/lib/catalog-view.ts', import.meta.url), 'utf8'), { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
const { catalogStatusLabel, confirmedBySource, groupSeasons, posterHue, scrapeSummary, titleInitial, toDetail, toWall, wallCard, UNCONFIRM_NOTICE } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

const resolve = itemId => `http://asset.test/artwork/poster/${itemId}`

test('wall cards carry the poster only when the backend cached one', () => {
  const withPoster = wallCard({ id: 'cat_1', title: '末日后酒店', year: 2025, kind: 'anime', status: 'confirmed', posterUrl: '/api/media/posters/cat_1', subtitle: '12 集' }, resolve)
  assert.equal(withPoster.posterUrl, 'http://asset.test/artwork/poster/cat_1')
  assert.equal(withPoster.statusLabel, '已确认')
  assert.equal(withPoster.needsReview, false)
  assert.equal(withPoster.subtitle, '12 集')

  const noPoster = wallCard({ id: 'cat_2', title: 'Airota', year: null, kind: 'anime', status: 'candidate', posterUrl: null, subtitle: null }, resolve)
  assert.equal(noPoster.posterUrl, null, '没有缓存就不要编一个地址')
  assert.equal(noPoster.statusLabel, '待确认')
  assert.equal(noPoster.needsReview, true)
  assert.equal(noPoster.year, null)
})

test('the wall keeps server order and reports paging', () => {
  const wall = toWall({
    items: [
      { id: 'b', title: 'B', year: 2020, kind: 'anime', status: 'confirmed', posterUrl: null, subtitle: null },
      { id: 'a', title: 'A', year: 2019, kind: 'anime', status: 'candidate', posterUrl: null, subtitle: null },
    ],
    hasMore: true,
    nextCursor: '100',
  }, resolve)
  assert.deepEqual(wall.cards.map(card => card.title), ['B', 'A'], '顺序照服务端')
  assert.equal(wall.hasMore, true)
  assert.equal(wall.nextCursor, '100')
})

test('episode labels come from the backend, never from the file name', () => {
  const [section] = groupSeasons([
    { mediaId: 'm1', name: 'Show - 01 [1080p].mkv', season: 1, episode: 1 },
    { mediaId: 'm2', name: 'Show - 02 [1080p].mkv', season: 1, episode: 2 },
    { mediaId: 'm4', name: 'Show OVA [1080p].mkv', season: null, episode: null },
  ])
  assert.deepEqual(section.children.map(child => child.label), ['E01', 'E02', '—'])
  assert.equal(section.title, '', '同一目录（都没 relDir）不顶标题行')
})

test('episode titles use scraped data and otherwise avoid file names', () => {
  const [section] = groupSeasons([
    { mediaId: 'm1', name: 'Show - 01 [1080p].mkv', season: 1, episode: 1, episodeTitle: '新的邂逅' },
    { mediaId: 'm2', name: 'Show - 02 [1080p].mkv', season: 1, episode: 2 },
    { mediaId: 'm3', name: 'OVA [1080p].mkv', season: null, episode: null },
  ])
  assert.deepEqual(section.children.map(child => child.title), ['新的邂逅', '第 2 集', '集数未标'])
  assert.deepEqual(section.children.map(child => child.hasEpisodeTitle), [true, false, false])
})

test('children carry their own playability, and old data stays playable', () => {
  const [season] = groupSeasons([
    { mediaId: 'm1', name: 'Show - 01.mkv', season: 1, episode: 1, compatibility: { browser: 'unsupported', desktop: 'supported', browserReason: '浏览器不承担 MKV 播放' } },
    { mediaId: 'm2', name: 'Show - 02.jpg', season: 1, episode: 2, compatibility: { browser: 'unsupported', desktop: 'unsupported', desktopReason: '不是当前媒体扫描器识别的视频文件' } },
    { mediaId: 'm3', name: 'Show - 03.mp4', season: 1, episode: 3, compatibility: { browser: 'supported', desktop: 'supported' } },
  ])
  assert.deepEqual(season.children.map(child => child.playable), [true, false, true], 'mkv 桌面端可播、图片两边都不行')
  assert.equal(season.children[1].note, '不是当前媒体扫描器识别的视频文件', '原因用服务端给的')
  assert.equal(season.children[0].note, null)

  // 旧后端没有 compatibility：按可播处理（缺字段=放行）。
  const [legacy] = groupSeasons([{ mediaId: 'm4', name: 'Old - 01.mkv', season: 1, episode: 1 }])
  assert.equal(legacy.children[0].playable, true)
  assert.equal(legacy.children[0].note, null)
})

test('sections follow relDir, not guessed episode numbers', () => {
  const sections = groupSeasons([
    { mediaId: 'a', name: 'Zeta - 01 [1080p].mkv', season: null, episode: null, relDir: '/泽塔奥特曼/正片' },
    { mediaId: 'b', name: 'Zeta - 02 [1080p].mkv', season: null, episode: null, relDir: '/泽塔奥特曼/正片' },
    { mediaId: 'c', name: 'interview.mkv', season: null, episode: null, relDir: '/泽塔奥特曼/人物访谈' },
  ])
  assert.deepEqual(sections.map(s => s.title), ['正片', '人物访谈'], '一段一个目录，标题取目录名末段')
  assert.deepEqual(sections[0].children.map(c => c.label), ['—', '—'], '没有集号就不编')

  // 同一季多集：季号一致才写「第 N 季」
  const seasonal = groupSeasons([
    { mediaId: 'x', name: 'A 01.mkv', season: 1, episode: 1, relDir: '/A/Season 1' },
    { mediaId: 'y', name: 'A 02.mkv', season: 1, episode: 2, relDir: '/A/Season 1' },
    { mediaId: 'z', name: 'A SP.mkv', season: null, episode: null, relDir: '/A/SPs' },
  ])
  assert.deepEqual(seasonal.map(s => s.title), ['第 1 季', 'SPs'])

  // 只有一段时不重复卡名
  const single = groupSeasons([{ mediaId: 's', name: 'Movie.mkv', season: null, episode: null, relDir: '/Made in Abyss' }])
  assert.equal(single[0].title, '', '单目录卡不再顶一个标题行')
})

test('binding source labels separate humans from the machine', () => {
  assert.equal(confirmedBySource('manual').label, '人工确认')
  assert.equal(confirmedBySource('rebind').label, '人工指定')
  assert.equal(confirmedBySource('auto').label, '机器匹配')
  assert.equal(confirmedBySource('unknown').label, '来源未知')
  assert.equal(confirmedBySource(null), null)
  assert.equal(confirmedBySource('whatever'), null, '未知取值不编文案')
})

test('a detail with one child is the movie case', () => {
  const detail = toDetail({
    id: 'cat_9', title: '魔法坏女巫', year: 2024, kind: 'movie', status: 'confirmed',
    posterUrl: '/api/media/posters/cat_9', subtitle: null, originalTitle: 'Wicked', overview: '…',
    candidates: [],
    children: [{ mediaId: 'v2.x.y', name: 'Wicked.2024.mkv', season: null, episode: null }],
  }, resolve)
  assert.equal(detail.single, true)
  assert.equal(detail.posterUrl, 'http://asset.test/artwork/poster/cat_9')
  assert.equal(detail.originalTitle, 'Wicked')

  const series = toDetail({
    id: 'cat_10', title: '剧集', year: null, kind: 'tv', status: 'candidate', posterUrl: null, subtitle: '12 集',
    originalTitle: null, overview: null,
    candidates: [{ id: 'cand_1', title: '候选题', year: 2025, score: 0.62 }],
    children: [
      { mediaId: 'm1', name: 'a.mkv', season: 1, episode: 1 },
      { mediaId: 'm2', name: 'b.mkv', season: 1, episode: 2 },
    ],
  }, resolve)
  assert.equal(series.single, false)
  assert.equal(series.candidates[0].score, 0.62)
  assert.equal(series.seasons.length, 1)
})

test('poster-less cards get a stable colour and a single-character mark', () => {
  // 同一部片每次渲染、每台机器都要同一个色（颜色只由标题决定）。
  assert.equal(posterHue('来自深渊'), posterHue('来自深渊'))
  assert.notEqual(posterHue('来自深渊'), posterHue('忘却棒球'))
  for (const title of ['来自深渊', 'ODDTAXI', '我们不可能成为恋人！绝对不行。〜再次闪耀！〜']) {
    const hue = posterHue(title)
    assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360, `${title} → ${hue}`)
  }
  assert.equal(titleInitial('来自深渊'), '来')
  assert.equal(titleInitial('  ODDTAXI'), 'O', '前导空格不算首字')
  assert.equal(titleInitial(''), '?', '空标题也得有东西兜底')
})

test('labels and scrape wording', () => {
  assert.equal(catalogStatusLabel('unmatched'), '未匹配')
  assert.equal(catalogStatusLabel('surprise'), 'surprise', '未知状态原样显示，不猜')
  assert.match(scrapeSummary({ status: 'running', total: 71, scanned: 12, matched: 3, lastError: null }), /已扫 12 \/ 71/)
  assert.match(scrapeSummary({ status: 'done', total: 71, scanned: 71, matched: 16, lastError: null }), /71 组，命中 16/)
  assert.match(scrapeSummary({ status: 'failed', total: 0, scanned: 0, matched: 0, lastError: 'BANGUMI_UNAVAILABLE' }), /BANGUMI_UNAVAILABLE/)
})
test('the unconfirm step tells you the card leaves the wall and where it goes', () => {
  // 后端 74cb3af2 起撤销是粘的：卡离开标题墙、落点是草稿审阅页「待人工」。
  // 这句文案是唯一让用户知道"去哪找它"的地方（入口按裁决：只加提醒、不加新面）。
  assert.match(UNCONFIRM_NOTICE, /离开标题墙/)
  assert.match(UNCONFIRM_NOTICE, /待人工/)
  assert.match(UNCONFIRM_NOTICE, /重新确认/)
})
