import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
const js = ts.transpile(readFileSync(new URL('../src/lib/media-library-view.ts', import.meta.url), 'utf8'), { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
const { desktopPlayable, healthLabel, hiddenCardCount, legacyView, libraryKindLabel, mediaErrorText, toCard, toView, visibleCards } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('desktop playability tolerates legacy data and blocks anything else', () => {
  assert.equal(desktopPlayable(undefined), true)
  assert.equal(desktopPlayable(null), true)
  assert.equal(desktopPlayable({ desktop: 'supported' }), true)
  assert.equal(desktopPlayable({ desktop: 'maybe' }), false)
  assert.equal(desktopPlayable({ desktop: 'unsupported' }), false)
  assert.equal(desktopPlayable({ desktop: 'needs-transcode' }), false, '未知枚举也要挡住（值域正在被后端改回旧三值）')
})

test('cards: directories open, blocked files say why, no image in phase 1', () => {
  const dir = toCard({ id: 'd1', name: 'Season 01', type: 'dir', extension: null, relativePath: '/Season 01', compatibility: { desktop: 'unsupported' } })
  assert.equal(dir.kind, 'dir')
  assert.equal(dir.playable, true, '目录只要能打开就算可操作')
  assert.equal(dir.subtitle, '文件夹')

  const file = toCard({ id: 'f1', name: 'Show.mkv', type: 'file', extension: 'mkv', relativePath: '/Season 01/Show.mkv', compatibility: { desktop: 'supported' } })
  assert.equal(file.playable, true)
  assert.equal(file.badge, null)
  assert.equal(file.imageUrl, null)
  assert.equal(file.extension, 'mkv')
  assert.equal(file.subtitle, 'MKV')

  const blocked = toCard({ id: 'f2', name: 'Hevc.mkv', type: 'file', extension: 'mkv', relativePath: '/Hevc.mkv', compatibility: { desktop: 'unsupported', desktopReason: '需要 libmpv' } })
  assert.equal(blocked.playable, false)
  assert.equal(blocked.badge, '桌面端不可播')
  assert.equal(blocked.note, '需要 libmpv', '服务端给了原因就用它')

  const unknown = toCard({ id: 'f3', name: 'x.mp4', type: 'file', extension: 'mp4', relativePath: '/x.mp4', compatibility: { desktop: 'native' } })
  assert.equal(unknown.playable, false)
  assert.match(String(unknown.note), /桌面端无法播放/)
})

test('the library page keeps server order, its own paths and its crumbs', () => {
  const view = toView({
    libraryId: 'lib_a',
    currentPath: '/Season 01',
    breadcrumbs: [{ name: 'Anime', path: '/' }, { name: 'Season 01', path: '/Season 01' }],
    hasMore: true,
    nextCursor: '100',
    items: [
      { id: 'f1', name: 'B.mkv', type: 'file', relativePath: '/Season 01/B.mkv', compatibility: { desktop: 'supported' } },
      { id: 'f0', name: 'A.mkv', type: 'file', relativePath: '/Season 01/A.mkv', compatibility: { desktop: 'supported' } },
    ],
  })
  assert.deepEqual(view.crumbs, [{ name: 'Anime', path: '/' }, { name: 'Season 01', path: '/Season 01' }])
  assert.deepEqual(view.cards.map(card => card.title), ['B.mkv', 'A.mkv'], '顺序照服务端，客户端不排序')
  assert.equal(view.nextCursor, '100')
  assert.equal(view.hasMore, true)
})

test('the legacy adapter rebuilds crumb paths from names only', () => {
  const view = legacyView({
    currentPath: '/Season 01/Specials',
    breadcrumbs: ['Anime', 'Season 01'],
    hasMore: false,
    items: [
      { id: 'd1', name: 'Specials', type: 'dir', compatibility: { desktop: 'supported' } },
      { id: 'f1', name: 'A.mkv', type: 'file', extension: 'mkv', displayPath: '/media/Anime/Season 01/Specials/A.mkv', compatibility: { desktop: 'supported' } },
    ],
  }, '/fallback')
  assert.deepEqual(view.crumbs, [{ name: 'Anime', path: '/Anime' }, { name: 'Season 01', path: '/Anime/Season 01' }])
  assert.equal(view.cards[0].relativePath, '', '旧数据没有相对路径也不编一个')
  assert.equal(view.cards[1].relativePath, '/media/Anime/Season 01/Specials/A.mkv', '旧路由只给了绝对路径，仅用于显示')
  assert.equal(view.cards[1].extension, 'mkv')
})

test('phase 2 artwork: poster ids become card and folder images, through the resolver only', () => {
  const resolve = (posterId) => `http://asset.test/artwork/${encodeURIComponent(posterId)}`
  // 只有 file 会继承目录封面；目录卡自己没有 posterId，所以 imageUrl 保持 null。
  const file = toCard({ id: 'f1', name: 'A.mkv', type: 'file', extension: 'mkv', relativePath: '/A.mkv', compatibility: { desktop: 'supported' }, posterId: 'v2.id.sig' }, resolve)
  assert.equal(file.imageUrl, 'http://asset.test/artwork/v2.id.sig')

  const dir = toCard({ id: 'd1', name: 'Season 01', type: 'dir', relativePath: '/Season 01', compatibility: { desktop: 'supported' } }, resolve)
  assert.equal(dir.imageUrl, null, '目录卡没有封面字段就是没有')

  const view = toView({
    libraryId: 'lib_a',
    currentPath: '/偶像大师 (2011)',
    breadcrumbs: [{ name: 'Anime', path: '/' }],
    hasMore: false,
    posterId: 'v2.folder.sig',
    items: [{ id: 'f1', name: 'A.mp4', type: 'file', relativePath: '/A.mp4', compatibility: { desktop: 'supported' }, posterId: 'v2.inherited.sig' }],
  }, resolve)
  assert.equal(view.posterUrl, 'http://asset.test/artwork/v2.folder.sig')
  assert.equal(view.cards[0].imageUrl, 'http://asset.test/artwork/v2.inherited.sig')

  // 没有解析器（旧路由 / 单测直调）时不许自造 URL。
  const bare = toView({
    libraryId: 'lib_a', currentPath: '/', breadcrumbs: [], hasMore: false, posterId: 'v2.folder.sig',
    items: [{ id: 'f1', name: 'A.mp4', type: 'file', relativePath: '/A.mp4', compatibility: { desktop: 'supported' }, posterId: 'v2.inherited.sig' }],
  })
  assert.equal(bare.posterUrl, null)
  assert.equal(bare.cards[0].imageUrl, null)
})

test('non-video files are hidden in the files view unless asked for', () => {
  const dir = toCard({ id: 'd1', name: 'Season 01', type: 'dir', relativePath: '/Season 01', compatibility: { desktop: 'supported', browser: 'supported' } })
  const video = toCard({ id: 'f1', name: 'A.mkv', type: 'file', extension: 'mkv', relativePath: '/A.mkv', compatibility: { desktop: 'supported', browser: 'unsupported' } })
  const maybe = toCard({ id: 'f2', name: 'B.avi', type: 'file', extension: 'avi', relativePath: '/B.avi', compatibility: { desktop: 'maybe', browser: 'maybe' } })
  const still = toCard({ id: 'f3', name: 'poster.jpg', type: 'file', extension: 'jpg', relativePath: '/poster.jpg', compatibility: { desktop: 'unsupported', browser: 'unsupported' } })
  const subs = toCard({ id: 'f4', name: 'A.ass', type: 'file', extension: 'ass', relativePath: '/A.ass', compatibility: { desktop: 'unsupported', browser: 'unsupported' } })

  assert.equal(dir.nonMedia, false, '目录永远留着')
  assert.equal(video.nonMedia, false)
  assert.equal(maybe.nonMedia, false, 'maybe 是"可能要转码的视频"，不是非视频')
  assert.equal(still.nonMedia, true)
  assert.equal(subs.nonMedia, true)

  const all = [dir, video, maybe, still, subs]
  assert.equal(hiddenCardCount(all), 2)
  assert.equal(visibleCards(all, true).length, 5, '显示全部时一个不少')
  assert.deepEqual(visibleCards(all, false).map(card => card.title), ['Season 01', 'A.mkv', 'B.avi'])
})

test('codes and labels the UI shows', () => {
  assert.equal(libraryKindLabel('anime'), '番剧')
  assert.equal(libraryKindLabel('tv'), '剧集')
  assert.equal(libraryKindLabel('podcast'), 'podcast', '未知类型原样显示，不猜')
  assert.equal(healthLabel('ok'), '可用')
  assert.equal(healthLabel('auth_failed'), '鉴权失败')
  assert.equal(mediaErrorText({ code: 'SOURCE_UNREACHABLE' }, '兜底'), '连不上这个源，检查地址或网络后重试')
  assert.equal(mediaErrorText({ code: 'MEDIA_ROUTE_DENIED' }, '兜底'), '客户端不允许访问这个媒体接口')
  assert.equal(mediaErrorText(new Error('boom'), '兜底'), '兜底')
  assert.equal(mediaErrorText({ code: 'NOPE' }, '兜底'), '兜底')
})
