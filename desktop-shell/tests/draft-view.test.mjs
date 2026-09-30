import assert from 'node:assert/strict'
import { test } from 'node:test'

const view = await import('../src/lib/draft-view.ts')

test('已分类的空草稿仍显示审阅与排除清单入口', () => {
  assert.equal(view.emptyKind({ draft: [], classifiedAt: '2026-09-30T00:00:00Z', scan: { rev: 4 }, diff: { dropped: [{ id: 'emptied' }] } }), null)
  assert.equal(view.emptyKind({ draft: [], classifiedAt: '2026-09-30T00:00:00Z', scan: { rev: 4 }, diff: { dropped: [] } }), null)
})

const item = (over = {}) => ({
  itemKey: '/Show A', query: 'Show A', rawName: 'Show A', subtitle: '12 集', files: 12, rev: 1,
  status: 'unmatched', lookupState: 'pending', title: 'Show A', originalTitle: null, year: null,
  overview: null, externalDb: null, externalId: null, confirmedBy: null, posterUrl: null, candidates: [],
  ...over,
})

const diff = (over = {}) => ({
  added: [], dropped: [], moved: [], changed: [], confirmedDrift: [],
  unchanged: 0, autoConfirmed: 0, draftCards: 0, formalCards: 0, ...over,
})

const state = (draft, d) => ({ libraryId: 'lib_x', cards: draft.length, files: draft.reduce((sum, it) => sum + it.files, 0), pending: draft.filter(it => it.lookupState !== 'done').length, classifiedAt: null, scan: { files: 100, enumeratedAt: null, rev: 3 }, draft, diff: d })

test('分桶按 itemKey 认：新增/移动/漂移/一致各归各处', () => {
  const d = diff({
    added: [{ id: '', itemKey: '/New Show', files: 4 }],
    moved: [{ id: 'cat_1', itemKey: '/Moved Show', fromKey: '#split/cat_1', files: 2 }],
    confirmedDrift: [{ id: 'cat_2', itemKey: '/Drifting', title: '漂移', files: { from: 5, to: 4 } }],
    unchanged: 9,
  })
  assert.equal(view.bucketOfItem(item({ itemKey: '/New Show' }), d), 'added')
  assert.equal(view.bucketOfItem(item({ itemKey: '/Moved Show' }), d), 'moved')
  assert.equal(view.bucketOfItem(item({ itemKey: '/Drifting' }), d), 'confirmedDrift')
  assert.equal(view.bucketOfItem(item({ itemKey: '/Whatever' }), d), 'unchanged')
})

test('chips：六个桶计数来自服务端 diff，未判定与待人工按行算', () => {
  const draft = [
    item({ itemKey: '/a', lookupState: 'done', status: 'confirmed', confirmedBy: 'auto', candidates: [{ externalDb: 'bangumi', externalId: '1', title: 'A', originalTitle: null, year: 2020, score: 1 }] }),
    item({ itemKey: '/b', lookupState: 'done', status: 'candidate', candidates: [{ externalDb: 'bangumi', externalId: '2', title: 'B', originalTitle: null, year: null, score: 0.62 }] }),
    item({ itemKey: '/c' }),
  ]
  const d = diff({ added: [{ id: '', itemKey: '/a', files: 3 }], unchanged: 7 })
  const chips = Object.fromEntries(view.draftBuckets(state(draft, d)).map(chip => [chip.key, chip.count]))
  assert.deepEqual(chips, { all: 3, pending: 1, added: 1, dropped: 0, moved: 0, changed: 0, confirmedDrift: 0, unchanged: 7, review: 1 })
  const progress = view.judgeProgress(state(draft, d))
  assert.deepEqual(progress, { judged: 2, total: 3, auto: 1, manual: 1, pending: 1, percent: 67 })
})

test('过滤：桶、未判定、待人工、搜索可叠加', () => {
  const draft = [
    item({ itemKey: '/a', rawName: 'Wicked 2024', lookupState: 'done', status: 'candidate' }),
    item({ itemKey: '/b', rawName: 'Show B' }),
  ]
  const d = diff({ added: [{ id: '', itemKey: '/a', files: 1 }] })
  const s = state(draft, d)
  assert.deepEqual(view.filterDraft(s, 'added', '').map(i => i.itemKey), ['/a'])
  assert.deepEqual(view.filterDraft(s, 'pending', '').map(i => i.itemKey), ['/b'])
  assert.deepEqual(view.filterDraft(s, 'review', '').map(i => i.itemKey), ['/a'])
  assert.deepEqual(view.filterDraft(s, 'all', 'wicked').map(i => i.itemKey), ['/a'])
  assert.deepEqual(view.filterDraft(s, 'all', 'nope').map(i => i.itemKey), [])
})

test('应用计划与提示语：漂移单独算，未判完时提示语带上未判定数', () => {
  const d = diff({ added: [{ id: '', itemKey: '/a', files: 1 }, { id: '', itemKey: '/b', files: 1 }], confirmedDrift: [{ id: 'cat_1', itemKey: '/c', files: { from: 5, to: 4 } }], moved: [{ id: 'cat_2', itemKey: '/d', fromKey: 'x', files: 1 }], unchanged: 5 })
  const plan = view.applyPlan(state([], d))
  assert.deepEqual(plan, { created: 2, removed: 0, rewritten: 0, moved: 1, drift: 1, unchanged: 5 })
  assert.match(view.applyHeadline(plan, 0), /新建 2/)
  assert.match(view.applyHeadline(plan, 58), /还有 58 张未判定/)
})

test('错误码映射到中文，未知码回落', () => {
  assert.match(view.draftErrorText({ code: 'CATALOG_STALE_SCAN' }), /旧快照/)
  assert.match(view.draftErrorText({ code: 'CATALOG_DRAFT_INCOMPLETE' }), /未判定/)
  assert.match(view.draftErrorText({ code: 'CATALOG_UNAVAILABLE' }), /条目站/)
  assert.equal(view.draftErrorText({ code: 'NOPE' }, '兜底'), '兜底')
  assert.equal(view.draftErrorCode({ code: 'CATALOG_DRAFT_EMPTY' }), 'CATALOG_DRAFT_EMPTY')
})

test('候选分数分档跟着服务端阈值走（不硬编码）', () => {
  const thresholds = { autoScore: 0.9, autoGap: 0.08, candidateScore: 0.5, variantCap: 0.84 }
  assert.equal(view.scoreTone(0.9, thresholds), 'hi')
  assert.equal(view.scoreTone(0.88, thresholds), 'mid')
  assert.equal(view.scoreTone(0.5, thresholds), 'mid')
  assert.equal(view.scoreTone(0.3, thresholds), 'low')
  // 老后端没下发阈值时退回默认线
  assert.equal(view.scoreTone(0.86), 'hi')
  assert.equal(view.scoreTone(0.3), 'low')
})

test('changed[] 的 from/to 形状能被读出来（未确认卡的改写）', () => {
  const changed = [{ id: 'cat_1', itemKey: '/Show A', from: { title: 'Shoujo Kageki Revue Starlight', subtitle: '12 集' }, to: { title: '少女☆歌剧 Revue Starlight', subtitle: '12 集' } }]
  const d = diff({ changed })
  assert.equal(view.bucketOfItem(item({ itemKey: '/Show A' }), d), 'changed')
  assert.equal(view.applyPlan(state([], d)).rewritten, 1)
})

test('应用结果文案分开说 skipped 与 deferred（§8.6）', () => {
  const text = view.applyResultText({ created: 4, updated: 1, skipped: 2, deferred: 58, posters: 3 })
  assert.match(text, /2 张由你定过，未改动/)
  assert.match(text, /58 张还没判定，本次未改其绑定/)
  assert.match(text, /新建 4/)
})

test('409 的错误体数据取得到（pending / 版本号）', () => {
  assert.deepEqual(view.errorData({ data: { pending: 44, draftCards: 64 } }), { pending: 44, draftCards: 64 })
  assert.deepEqual(view.errorData({ data: { draftRev: 1, scanRev: 2 } }), { draftRev: 1, scanRev: 2 })
  assert.deepEqual(view.errorData(new Error('nope')), {})
})

test('劈卡配对只读权威字段（§8.3 的四对真样本）', () => {
  const added = [
    { itemKey: '/[SweetSub] Made in Abyss Compendium Films [BDRip][1080P][AVC 8bit][CHS]', files: 2, fromFiles: 2, splitFromKey: '/[Airota][Made in Abyss][BDRip 1080p AVC AAC][CHS]', query: 'Made in Abyss Compendium Films' },
    { itemKey: '/[Nekomoeo kissaten&LoliHouse] Kusuriya no Hitorigoto S2', files: 24, fromFiles: 24, splitFromKey: '/[DBD-Raws] Kusuriya no Hitorigoto', query: 'Kusuriya no Hitorigoto' },
    { itemKey: '/[Nekomoe kissaten&LoliHouse] Apocalypse Hotel Web', files: 11, fromFiles: 11, splitFromKey: '/[Nekomoe kissaten&LoliHouse] Apocalypse Hotel - 01-12', query: '末日后酒店' },
    { itemKey: '/[Prejudice-Studio] Watanare OVA05.mp4', files: 1, fromFiles: 1, splitFromKey: '/[Prejudice-Studio] Watanare OVA01.mp4', query: '我们不可能成为恋人！〜再次闪耀！〜' },
  ]
  const cases = [
    { keys: ['/[Nekomoeo kissaten&LoliHouse] Kusuriya no Hitorigoto S2'], files: { from: 48, to: 24 }, equation: '48 → 24 + 24', moved: 24 },
    { keys: ['/[Nekomoe kissaten&LoliHouse] Apocalypse Hotel Web'], files: { from: 23, to: 12 }, equation: '23 → 12 + 11', moved: 11 },
    { keys: ['/[SweetSub] Made in Abyss Compendium Films [BDRip][1080P][AVC 8bit][CHS]'], files: { from: 15, to: 13 }, equation: '15 → 13 + 2', moved: 2 },
    { keys: ['/[Prejudice-Studio] Watanare OVA05.mp4'], files: { from: 2, to: 1 }, equation: '2 → 1 + 1', moved: 1 },
  ]
  for (const item of cases) {
    const summary = view.splitSummary({ files: item.files, splitIntoKeys: item.keys }, added)
    assert.equal(summary.equation, item.equation)
    assert.equal(summary.movedFiles, item.moved)
    assert.ok(summary.labels.length === 1 && summary.labels[0].length > 0)
  }
  // 没劈卡：不写方程、不提示（比如只有子文件刷新）
  assert.equal(view.splitSummary({ files: { from: 13, to: 13 }, splitIntoKeys: [] }, added).equation, null)
  // 认不出的 key 不算数
  assert.equal(view.splitSummary({ files: { from: 5, to: 4 }, splitIntoKeys: ['/nope'] }, added).equation, null)
  // 后端保证的不变量：from - to == fromFiles 之和
  for (const item of cases) assert.equal(item.files.from - item.files.to, item.moved)
})

test('§8.6 的两句话：有人定过 / 还有未判定才出现', () => {
  assert.deepEqual(view.applySideEffects({ pending: 0, humanConfirmed: 0 }), [])
  assert.deepEqual(view.applySideEffects({ pending: 44, humanConfirmed: 0 }), ['44 张还没判定，本次未改其绑定'])
  assert.deepEqual(view.applySideEffects({ pending: 0, humanConfirmed: 3 }), ['3 张由你定过，未改动'])
})

test('真样本：confirmedDrift 双 null 的 subtitle 也能渲染（用 from/to 直接拼）', () => {
  const drift = [{ id: 'cat_DXx-hDGK6Fg5', itemKey: '/Watanare OVA02.mp4', title: '我们不可能成为恋人！绝对不行。 (※似乎可行？) 〜再次闪耀！〜', subtitle: { from: null, to: null }, files: { from: 2, to: 1 } }]
  const d = diff({ confirmedDrift: drift })
  assert.equal(view.applyPlan(state([], d)).drift, 1)
  assert.equal(view.bucketOfItem(item({ itemKey: '/Watanare OVA02.mp4' }), d), 'confirmedDrift')
})

test('keepsBindingOnKey：绑定跟哪一半能读出来（§8.4 真样本）', () => {
  const draft = [
    { itemKey: '/[DBD-Raws][吊带袜天使…]/[Nekomoe…] Kusuriya no Hitorigoto [WebRip…]', title: '药屋少女的呢喃 第二季' },
    { itemKey: '/[Nekomoeo…] Kusuriya no Hitorigoto S2', query: 'Kusuriya no Hitorigoto' },
  ]
  const row = {
    files: { from: 48, to: 24 },
    splitIntoKeys: ['/[Nekomoeo…] Kusuriya no Hitorigoto S2'],
    keepsBindingOnKey: '/[DBD-Raws][吊带袜天使…]/[Nekomoe…] Kusuriya no Hitorigoto [WebRip…]',
  }
  const added = [{ itemKey: row.splitIntoKeys[0], files: 24, fromFiles: 24, query: 'Kusuriya no Hitorigoto' }]
  const summary = view.splitSummary(row, added)
  assert.equal(summary.keepsBindingOnKey, row.keepsBindingOnKey)
  assert.equal(view.keyLabel(summary.keepsBindingOnKey, draft), '药屋少女的呢喃 第二季')
  assert.deepEqual(summary.newLabels, ['Kusuriya no Hitorigoto'])
  // 草稿里没有这张卡时退回 itemKey 末段，不炸
  assert.equal(view.keyLabel('/a/b/c', []), 'c')
})

test('bindingLabel：保留在自己身上时用正式卡名，落到别的草稿才查草稿名', () => {
  const draft = [
    { itemKey: '/[DBD]/[Nekomoe] Kusuriya no Hitorigoto [WebRip]', title: 'Kusuriya no Hitorigoto' },
    { itemKey: '/[Nekomoeo] Kusuriya no Hitorigoto S2', query: 'Kusuriya no Hitorigoto' },
  ]
  const row = { itemKey: '/[DBD]/[Nekomoe] Kusuriya no Hitorigoto [WebRip]', title: '药屋少女的呢喃 第二季', keepsBindingOnKey: '/[DBD]/[Nekomoe] Kusuriya no Hitorigoto [WebRip]' }
  assert.equal(view.bindingLabel(row, draft), '药屋少女的呢喃 第二季')
  const moved = { ...row, keepsBindingOnKey: '/[Nekomoeo] Kusuriya no Hitorigoto S2' }
  assert.equal(view.bindingLabel(moved, draft), 'Kusuriya no Hitorigoto')
  assert.equal(view.bindingLabel({ itemKey: '/a/b', title: null, keepsBindingOnKey: '/a/b' }, []), 'b')
  // 第三参给「当前承接方」时，标签按它算（确认框里下拉的当前值走这条路）
  assert.equal(view.bindingLabel(row, draft, '/[Nekomoeo] Kusuriya no Hitorigoto S2'), 'Kusuriya no Hitorigoto')
})

test('分桶认得 dropped：判过「删除」的草稿行不该落进「一致」', () => {
  // 漏掉的后果不是显示难看：这些行会顶着「一致」而 apply 时那张卡真会被删。
  const d = diff({ dropped: [{ id: 'cat_9', itemKey: '/Gone Show', title: '要走', files: 6 }] })
  assert.equal(view.bucketOfItem(item({ itemKey: '/Gone Show' }), d), 'dropped')
  assert.equal(view.bucketOfItem(item({ itemKey: '/Still Here' }), d), 'unchanged')
})

test('carrierKeyOf：当前值取草稿行 carriesKey，没设过就指回自己', () => {
  assert.equal(view.carrierKeyOf({ itemKey: '/a', carriesKey: '/b' }), '/b')
  assert.equal(view.carrierKeyOf({ itemKey: '/a', carriesKey: null }), '/a')
  // 后端偶尔给空串（字段是 string|null，实测两边都出现过）：空串等同没设，不能当下拉的值。
  assert.equal(view.carrierKeyOf({ itemKey: '/a', carriesKey: '' }), '/a')
  assert.equal(view.carrierKeyOf({ itemKey: '/a' }), '/a')
})

test('carriesKey 与 keepsBindingOnKey 分叉：刚改过承接方还没重刷 diff 时读当前值', () => {
  // 这就是确认框原来的 bug：下拉取 row.keepsBindingOnKey（diff 反推的「应用后落在哪」），
  // 而用户刚在草稿行上改过、diff 还没重刷的那一刻，两者不同 —— 下拉会跳回旧值。
  const draft = [item({ itemKey: '/A', title: 'A 卡', carriesKey: '/B' }), item({ itemKey: '/B', title: 'B 卡', carriesKey: null })]
  const row = { itemKey: '/A', title: 'A 卡', keepsBindingOnKey: '/A' } // diff 还没重刷：仍说留在自己身上
  assert.equal(view.carrierKeyOf(draft[0]), '/B')
  assert.notEqual(view.carrierKeyOf(draft[0]), row.keepsBindingOnKey)
  assert.equal(view.bindingLabel({ itemKey: '/A', title: 'A 卡' }, draft, view.carrierKeyOf(draft[0])), 'B 卡')
})

test('编辑接口报错文案：后端新加的两个 reason 说清楚下一步', () => {
  // code 在顶层，reason/keys 在 data 里（与 ipc 抛出来的形状一致）。
  const error = (reason, keys) => Object.assign(new Error('failed'), { code: 'DRAFT_EDIT_INVALID', data: { code: 'DRAFT_EDIT_INVALID', reason, keys } })
  const badList = view.draftEditErrorText(error('bad-keep-list'))
  assert.match(badList, /1024/)
  const unknown = view.draftEditErrorText(error('unknown-media', ['m1', 'm2', 'm3']))
  assert.match(unknown, /3/)
  assert.match(unknown, /刷新/)
  // 老 reason 不能被新分支挤掉
  assert.ok(view.draftEditErrorText(error('nothing-to-split')).length > 0)
  assert.ok(view.draftEditErrorText(error('bad-carrier')).length > 0)
})

test('批准失败文案：reason 说下一步，冲突列 keys，窗口关了不说"过了 48 小时"', () => {
  const err = (code, data) => Object.assign(new Error(code), { code, data })
  assert.match(view.approvalErrorText(err('CATALOG_APPROVAL_INVALID', { reason: 'used' })), /重新批准/)
  assert.match(view.approvalErrorText(err('CATALOG_APPROVAL_INVALID', { reason: 'operations-changed' })), /新的差异/)
  assert.match(view.approvalErrorText(err('CATALOG_APPROVAL_INVALID', { reason: 'scan-revision' })), /重新分类/)
  // 没见过的 reason 走兜底，不空着也不说"失败"
  assert.match(view.approvalErrorText(err('CATALOG_APPROVAL_INVALID', { reason: 'future-reason' })), /重新批准/)
  assert.match(view.approvalErrorText(err('CATALOG_APPROVAL_REQUIRED', {})), /批准/)
  assert.match(view.approvalErrorText(err('CATALOG_APPROVAL_SECRET_REQUIRED', {})), /密钥/)
  assert.match(view.approvalErrorText(err('CATALOG_NOTHING_TO_APPROVE', {})), /直接/)
  const conflict = view.approvalErrorText(err('CATALOG_ROLLBACK_CONFLICT', { keys: ['/A', '/B', '/C'] }))
  assert.match(conflict, /\/A/)
  assert.match(conflict, /整批没有动/)
  assert.match(conflict, /3 张/)
  const closed = view.approvalErrorText(err('CATALOG_ROLLBACK_WINDOW_CLOSED', {}))
  assert.match(closed, /已经落地/)
  assert.doesNotMatch(closed, /48 小时不算/)
  // 401 的形状错（approvalToken 不合法）也按"重新批准"，不重试
  assert.match(view.approvalErrorText(err('CATALOG_APPROVAL_REQUIRED', {})), /批准/)
})

test('批准单四类清单：名字从草稿/差异 join，dropped 带空壳原因与落点', () => {
  const d = diff({
    added: [{ id: '', itemKey: '/New', files: 3, query: '新卡', splitFromKey: '/Old', fromFiles: 3 }],
    dropped: [{ id: 'cat_9', itemKey: '/Ghost', title: '幽灵卡', files: 5, missingPaths: 5, suggestedKeys: ['/New'] }],
    moved: [{ id: 'cat_8', itemKey: '/Moved', query: '搬走的卡', files: 2 }],
    confirmedDrift: [{ id: 'cat_7', itemKey: '/Drift', title: '漂移卡', subtitle: { from: null, to: null }, files: { from: 48, to: 24 }, splitIntoKeys: ['/New'], keepsBindingOnKey: '/Drift' }],
  })
  const sheet = view.structuralSheet(
    { added: ['/New'], dropped: ['/Ghost'], moved: ['/Moved'], drift: [{ itemKey: '/Drift', from: 48, to: 24 }] },
    [item({ itemKey: '/New', title: '新卡' }), item({ itemKey: '/Old', title: '老卡' })],
    d,
  )
  assert.equal(sheet.total, 4)
  assert.equal(sheet.added[0].label, '新卡')
  assert.match(sheet.added[0].note ?? '', /老卡/)
  assert.match(sheet.added[0].note ?? '', /3 个文件/)
  assert.equal(sheet.dropped[0].label, '幽灵卡')
  assert.match(sheet.dropped[0].note ?? '', /空壳：5 个文件已不在快照/)
  assert.match(sheet.dropped[0].note ?? '', /新卡/)
  assert.equal(sheet.moved[0].label, '搬走的卡')
  assert.deepEqual(sheet.drift[0], { key: '/Drift', label: '漂移卡', from: 48, to: 24 })
  // join 不到（diff 还没刷新）时退 itemKey 末段，不空着
  const bare = view.structuralSheet({ added: [], dropped: ['/X/Y/Z'], moved: [], drift: [] }, [], null)
  assert.equal(bare.dropped[0].label, 'Z')
})

test('集号覆盖（§16）：只有集号变了才提示，且明说不算结构变更', () => {
  assert.equal(view.episodeNote({ from: 0, to: 81 }), '集号 0 → 81')
  assert.equal(view.episodeNote({ from: 40, to: 770 }), '集号 40 → 770')
  assert.equal(view.episodeNote({ from: 7, to: 7 }), null)
  assert.equal(view.episodeNote(null), null)
  assert.equal(view.episodeNote(undefined), null)
})

test('撤回行只认 rollbackAvailable；windowClosed 不冒充可撤回', () => {
  const row = (over = {}) => ({
    approvalId: 'appr_1', kind: 'apply', approvedBy: '桌面端', createdAt: '', expiresAt: '', usedAt: null,
    revokedAt: null, appliedAt: '2026-09-29T13:23:00.000Z', rolledBackAt: null, targets: null,
    rollbackAvailable: false, windowClosed: false, ...over,
  })
  assert.equal(view.rollbackLine([]), null)
  assert.equal(view.rollbackLine([row({ windowClosed: true })]), null)
  const line = view.rollbackLine([row({ rollbackAvailable: true, keys: ['/A', '/B'], counts: { created: 1, removed: 1, changed: 0 } })])
  assert.match(line.text, /＋1 −1/)
  assert.match(line.text, /2 张卡/)
  assert.match(line.label, /桌面端/)
  const sheet = view.rollbackSheet({ keys: ['/A'], counts: { created: 1, removed: 0, changed: 2 } }).join(" ")
  assert.match(sheet, /海报会一起接回来/)
  assert.match(sheet, /一次性/)
  assert.doesNotMatch(sheet, /重抓/)
  assert.match(view.applyResultText({ created: 1, updated: 2, skipped: 0, deferred: 0, posters: 1, rollbackAvailable: true }), /可撤回/)
})
