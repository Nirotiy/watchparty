import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as wait } from 'node:timers/promises'

/** 只给加源用例补凭据：从仓库根 .env 读，值不落日志、不进断言消息。 */
async function openlistLogin() {
  try {
    const env = await readFile(new URL('../../.env', import.meta.url), 'utf8')
    const read = name => env.split(/\r?\n/).find(line => line.startsWith(`${name}=`))?.slice(name.length + 1).trim() ?? ''
    return { username: read('OPENLIST_USERNAME'), password: read('OPENLIST_PASSWORD') }
  } catch {
    return { username: '', password: '' }
  }
}

/**
 * Media library acceptance (multi-source phase 1) against a **real local stack**, not a
 * fixture: real libraries, real files, real screenshot. The folder browser only exists
 * inside a room, so this enters one first.
 *
 *   node electron/launch.mjs --media-check
 *
 * Env: WATCHPARTY_MEDIA_CHECK_ORIGIN (default http://127.0.0.1:8080).
 *
 * **代价（2026-09-29 后端复验时点出来的）**：默认 origin 就是活的后端 + 真库，所以
 * `draft-approval-api` 与 `draft-states` 的批准步会写 `catalog_approvals`（每跑一次 2 行台账 +
 * 一份 undo，临时库整本草稿 60 张 ⇒ ≈667KB；台账行按设计永久留着，undo 靠**全局**
 * `pruneExpiredUndo` 过期回收，不会无界长）。**这两步默认不跑**，要验就开
 * `WATCHPARTY_MEDIA_CHECK_REVIEW=1`（和 titles-edit 的写半步同一把闸）。
 * 要真隔离：把 `WATCHPARTY_MEDIA_CHECK_ORIGIN` 指到隔离服务实例。
 */
/** 右栏的高级区（候选列表 / 撤销确认 / 换绑）2026-09-28 起收在「更多」后面：读之前先展开。 */
async function openRailAdvanced(js) {
  return js(`(() => {
    if (document.querySelector('.catalog-candidates') || document.querySelector('.catalog-edit')) return { alreadyOpen: true }
    const more = Array.from(document.querySelectorAll('button')).find(node => node.textContent.trim().startsWith('更多'))
    if (!more) return { alreadyOpen: false, found: false }
    more.click()
    return { alreadyOpen: false, found: true }
  })()`)
}

export async function runMediaCheck(window, native) {
  const invoke = (command, args = {}) => window.webContents.executeJavaScript(`window.watchpartyDesktop.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`)
  const js = source => window.webContents.executeJavaScript(source)
  async function until(check, label, timeout = 20000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) { if (await check()) return; await wait(100) }
    throw new Error(label)
  }
  const origin = process.env.WATCHPARTY_MEDIA_CHECK_ORIGIN?.trim() || 'http://127.0.0.1:8080'
  // 慢请求归因（2026-09-30）：>1s 的媒体请求把 method/path/ms 打出来（**不打 query**，免得带凭据）。
  const timedInvoke = async (command, args = {}) => {
    if (command !== 'mediaRequest') return invoke(command, args)
    const started = Date.now()
    try { return await invoke(command, args) }
    finally {
      const ms = Date.now() - started
      if (ms > 1000) console.log('MEDIA_REQUEST_SLOW ' + JSON.stringify({ method: args.method, path: args.path, ms }))
    }
  }
  const step = async (label, work) => {
    try { const value = await work(); console.log('MEDIA_CHECK_STEP ' + JSON.stringify({ label, ok: true })); return value }
    catch (error) { console.log('MEDIA_CHECK_STEP ' + JSON.stringify({ label, ok: false, code: error?.code ?? null, message: error?.message ?? String(error) })); throw error }
  }
  const settings = await step('getDesktopSettings', () => invoke('getDesktopSettings'))
  // 首启向导会占住 home 视图，大厅 UI 就不存在：本 harness 自带临时 profile，直接置完成位。
  await step('updateDesktopSettings', () => invoke('updateDesktopSettings', { input: {
    backendOrigin: origin, allowRemoteHttp: settings.allowRemoteHttp, nickname: settings.nickname,
    theme: settings.theme, windowMaterial: settings.windowMaterial,
    playerPreferences: settings.playerPreferences, setupCompleted: true,
  } }))
  await step('verifyBackend', () => invoke('verifyBackend'))
  // Isolated secret-mode runs provision native storage from a server-only test file.
  // Only the filename is inherited by the harness; secret values never enter shell environment or logs.
  if (process.env.WATCHPARTY_MEDIA_CHECK_APPROVAL_FILE) {
    await step('approval-secret-channel', async () => {
      const config = JSON.parse(await readFile(process.env.WATCHPARTY_MEDIA_CHECK_APPROVAL_FILE, 'utf8'))
      const status = await invoke('setCatalogApprovalSecret', { secret: config.secret })
      const readback = await invoke('catalogApprovalSecretStatus')
      assert.ok(status.configured && readback.configured, 'native approval secret was not configured')
      assert.equal(readback.mask, '••••••••', 'native approval readback must be a fixed mask')
      assert.deepEqual(Object.keys(readback).sort(), ['configured', 'mask'])
      console.log('MEDIA_APPROVAL_SECRET_CHANNEL ' + JSON.stringify({ configured: readback.configured, masked: true }))
    })
  }
  // 上一轮跑挂在中途时可能留下测试源：先清干净，这一轮的行数断言才有意义。
  await purgeTestSources(invoke)
  // 写设置是异步进 React 的（native 广播 desktop://settings），大厅得等它换掉向导。
  await until(() => js(`Boolean(document.querySelector('.banguru-lobby'))`), 'banguru lobby', 15000)
  // 新版首页（2026-09-27 方案 A）：状态卡 + 入房卡 + 交接码横带，顺手留一张图。
  await wait(400)
  const lobbyShot = join(tmpdir(), 'watchparty-media-check', 'banguru-lobby.png')
  await mkdir(join(tmpdir(), 'watchparty-media-check'), { recursive: true })
  await writeFile(lobbyShot, (await window.webContents.capturePage()).toPNG())
  const lobbyShape = await js(`(() => ({
    cards: document.querySelectorAll('.banguru-lobby .bh-card').length,
    status: document.querySelector('.banguru-lobby .bh-pill')?.textContent?.trim() ?? null,
    rows: Array.from(document.querySelectorAll('.banguru-lobby .bh-rows dt')).map(node => node.textContent.trim()),
    caps: document.querySelectorAll('.banguru-lobby .bh-cap').length,
    strip: Boolean(document.querySelector('.banguru-lobby .bh-strip')),
    tooltipGone: !document.querySelector('.banguru-service-tooltip'),
  }))()`)
  console.log('MEDIA_LOBBY_SHAPE ' + JSON.stringify({ ...lobbyShape, shot: lobbyShot }))
  assert.equal(lobbyShape.cards, 2, `首页不是两张卡: ${JSON.stringify(lobbyShape)}`)
  assert.equal(lobbyShape.tooltipGone, true, '旧的状态悬浮气泡还在')
  await js(`Array.from(document.querySelectorAll('.banguru-lobby button')).find(node => node.textContent.trim() === '检查服务器')?.click()`)
  await wait(400)
  const details = await js(`(() => {
    const button = Array.from(document.querySelectorAll('.banguru-lobby button')).find(node => node.textContent.trim() === '检查服务器')
    const panel = document.querySelector('.banguru-lobby .bh-details')
    return { expanded: button?.getAttribute('aria-expanded'), text: panel?.textContent?.replace(/\\s+/g, ' ').slice(0, 120) ?? null, rows: panel ? panel.querySelectorAll('.bh-rows > div').length : 0 }
  })()`)
  console.log('MEDIA_LOBBY_DETAILS ' + JSON.stringify(details))
  assert.equal(details?.expanded, 'true', `「检查服务器」没有展开: ${JSON.stringify(details)}`)
  assert.ok((details?.text ?? '').length > 10, `展开里没有内容: ${JSON.stringify(details)}`)
  const detailsShot = join(tmpdir(), 'watchparty-media-check', 'banguru-lobby-details.png')
  await writeFile(detailsShot, (await window.webContents.capturePage()).toPNG())
  console.log('MEDIA_LOBBY_DETAILS_SHOT ' + JSON.stringify({ shot: detailsShot }))

  await js(`Array.from(document.querySelectorAll('.banguru-lobby button')).find(node => node.textContent.trim() === '检查服务器').click()`)

  // 走大厅 UI 建房（只有 UI 那条路才会把视图切进房间）：昵称 + 「创建并进入」。
  await step('lobby-create-room', () => js(`(() => {
    const lobby = document.querySelector('.banguru-lobby')
    if (!lobby) throw new Error('banguru lobby missing')
    const input = Array.from(lobby.querySelectorAll('input')).find(node => node.placeholder === '显示给房间成员')
    if (!input) throw new Error('nickname field missing')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'MediaCheck')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`))
  await until(() => js(`(() => { const button = Array.from(document.querySelectorAll('.banguru-lobby button')).find(node => node.textContent.trim() === '创建并进入'); return Boolean(button && !button.disabled) })()`), 'lobby create enabled')
  await js(`Array.from(document.querySelectorAll('.banguru-lobby button')).find(node => node.textContent.trim() === '创建并进入').click()`)
  await until(() => js(`Boolean(document.querySelector('button[aria-label="添加媒体"]'))`), 'room media button', 25000)
  await js(`document.querySelector('button[aria-label="添加媒体"]').click()`)
  await until(() => js(`Boolean(document.querySelector('.media-lib-chip'))`), 'library switcher')
  // 默认模式是 Titles（相位 3 裁决）：这一组断言量的是文件视图，先切过去；
  // 顺带证明 Titles/Files 开关真的在切换视图。
  await until(() => js(`Boolean(Array.from(document.querySelectorAll('.seg-item')).find(node => node.textContent.trim() === '文件'))`), 'segmented switch', 15000)
  await js(`Array.from(document.querySelectorAll('.seg-item')).find(node => node.textContent.trim() === '文件').click()`)
  await until(() => js(`document.querySelectorAll('.media-card').length > 0`), 'files grid')
  await wait(600)
  const state = await js(`(() => ({
    chips: Array.from(document.querySelectorAll('.media-lib-chip')).map(node => node.textContent.trim()),
    health: Array.from(document.querySelectorAll('.media-lib-chip .media-lib-health')).map(node => node.className.replace('media-lib-health', '').trim() || 'ok'),
    selected: Array.from(document.querySelectorAll('.media-lib-chip')).filter(node => node.getAttribute('aria-pressed') === 'true').map(node => node.textContent.trim()),
    headerButtons: Array.from(document.querySelectorAll('.desktop-page header button')).map(node => node.textContent.trim()),
    cards: document.querySelectorAll('.media-card').length,
    folders: Array.from(document.querySelectorAll('.media-card')).filter(node => node.textContent.includes('文件夹')).length,
    badges: Array.from(document.querySelectorAll('.media-card-badge')).map(node => node.textContent.trim()),
    crumbs: Array.from(document.querySelectorAll('.desktop-page nav[aria-label="目录路径"] button')).map(node => node.textContent.trim()),
    message: document.querySelector('.desktop-page [role="status"]')?.textContent?.trim() ?? null,
  }))()`)
  const dir = join(tmpdir(), 'watchparty-media-check')
  await mkdir(dir, { recursive: true })
  const shotPath = join(dir, 'media-library.png')
  await writeFile(shotPath, (await window.webContents.capturePage()).toPNG())
  console.log('MEDIA_LIBRARY_EVIDENCE ' + JSON.stringify({ origin, ...state, shot: shotPath }))
  assert.ok(state.chips.length >= 1, `切换器里没有库: ${JSON.stringify(state)}`)
  // 旧三根联合若还活着，表头就是三个普通按钮而不是带 kind 标签的 chip。
  assert.ok(state.headerButtons.length > 0 && state.headerButtons.every(text => state.chips.includes(text) || ['点播', '文件'].includes(text)), `表头仍有非库 chip 的按钮（旧三根联合）: ${JSON.stringify(state.headerButtons)}`)
  assert.ok(state.cards > 0, `目录里没有卡片: ${JSON.stringify(state)}`)
  assert.ok(state.crumbs.length >= 1, `没有面包屑: ${JSON.stringify(state)}`)
  assert.equal(new Set(state.crumbs).size, state.crumbs.length, `面包屑有重复项: ${JSON.stringify(state.crumbs)}`)
  assert.equal(state.selected.length, 1, `没有选中态（或选了多个库）: ${JSON.stringify(state)}`)

  // 管理端：保存一个连不上的源必须整体被拒（计划：任一路径浅列非 200 就不写入）。
  // 这里走的是裸 IPC，拿到的就是侧车的 {status, body}，状态码得自己看（渲染层那份包装在 ipc.ts）。
  const save = await invoke('mediaRequest', {
    method: 'POST', path: '/api/admin/media-sources', query: null,
    body: { name: 'Dead check', internalBaseUrl: 'http://127.0.0.1:1', publicBaseUrl: 'http://127.0.0.1:1', username: '', password: '', libraries: [{ name: 'Dead', kind: 'other', path: '/' }] },
  })
  const saved = (() => { try { return JSON.parse(save.body) } catch { return {} } })()
  const saveCode = String(saved.code ?? saved.error ?? '')
  console.log('MEDIA_SOURCE_SAVE ' + JSON.stringify({ status: save.status, code: saveCode }))
  assert.ok(save.status >= 400, `连不上的源竟然保存成功了: ${JSON.stringify(save)}`)
  assert.ok(['SOURCE_UNREACHABLE', 'LIBRARY_ROOT_NOT_FOUND', 'SOURCE_AUTH_FAILED'].includes(saveCode), `拒绝原因不是预期的源健康码: ${JSON.stringify(save)}`)
  // 半写状态是禁止的：被拒的源不得留下任何一行。
  const sources = await invoke('mediaRequest', { method: 'GET', path: '/api/admin/media-sources', query: null, body: null })
  const rows = (() => { try { return JSON.parse(sources.body).sources ?? [] } catch { return [] } })()
  console.log('MEDIA_SOURCE_ROWS ' + JSON.stringify(rows.map(row => row.name)))
  assert.equal(rows.some(row => row.name === 'Dead check'), false, `被拒的源写进去了: ${JSON.stringify(rows)}`)

  // 客户端白名单之外的路由在 sidecar 就被拒，码要能到渲染层（P1-1 的保真映射）。
  const denied = await invoke('mediaRequest', { method: 'GET', path: '/api/media/roots', query: null, body: null }).then(() => null, error => error)
  assert.equal(denied?.code, 'MEDIA_ROUTE_DENIED', `白名单外没有被拒: ${JSON.stringify(denied)}`)
  console.log('MEDIA_LIBRARY_CHECK_OK')
  await runArtworkCheck({ window, js, until, step })
  await runTitlesCheck({ window, js, invoke, until, step })
  await runSourceFormCheck({ window, js, invoke, until, step })
  await runDraftCheck({ window, js, invoke, until, step })
  await runDraftEditCheck({ js, invoke: timedInvoke, until, step, origin })
  await runDraftApprovalCheck({ invoke: timedInvoke, step })
  await runSourceIsolationCheck({ js, invoke, until, step, origin })
  await runPlayCheck({ window, js, until, step })
}

/**
 * 相位 3：标题墙。真实库已经刮过（71 组：16 已确认 / 39 待确认 / 16 未匹配），所以这一条
 * 直接量真数据：墙上有卡、未匹配不在墙上、选一张能在右栏看到候选、确认一次会改标题。
 */
async function runTitlesCheck({ window, js, invoke, until, step }) {
  await step('titles-wall', async () => {
    // 已经在媒体视图里（上一步的封面检查停在这里）：切回 Titles 即可。
    await js(`Array.from(document.querySelectorAll('.seg-item')).find(node => node.textContent.trim() === '点播').click()`)
    await until(() => js(`document.querySelectorAll('.catalog-card').length > 0`), 'catalog wall', 25000)
    await wait(600)
    const state = await js(`(() => ({
      mode: Array.from(document.querySelectorAll('.seg-item')).filter(node => node.getAttribute('aria-pressed') === 'true').map(node => node.textContent.trim()),
      cards: document.querySelectorAll('.catalog-card').length,
      withPoster: Array.from(document.querySelectorAll('.catalog-art img')).length,
      badges: Array.from(document.querySelectorAll('.catalog-badge.status')).map(node => node.textContent.trim()).reduce((acc, label) => (acc[label] = (acc[label] ?? 0) + 1, acc), {}),
      years: document.querySelectorAll('.catalog-badge.year').length,
      unmatchedLine: document.querySelector('.catalog-unmatched')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
      scrape: document.querySelector('.desktop-page [role="status"]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
    }))()`)
    const shot = join(tmpdir(), 'watchparty-media-check', 'catalog-wall.png')
    await mkdir(join(tmpdir(), 'watchparty-media-check'), { recursive: true })
    await writeFile(shot, (await window.webContents.capturePage()).toPNG())
    console.log('MEDIA_TITLES_WALL ' + JSON.stringify({ ...state, shot }))
    assert.deepEqual(state.mode, ['点播'], `默认不在「点播」模式: ${JSON.stringify(state)}`)
    assert.ok(state.cards > 0, `标题墙没有卡片: ${JSON.stringify(state)}`)
    assert.ok(state.withPoster > 0, `一张海报都没取到（posters 路由或缓存有问题）: ${JSON.stringify(state)}`)
    assert.ok((state.badges['未匹配'] ?? 0) === 0, `未匹配不该出现在墙里: ${JSON.stringify(state)}`)
    assert.match(state.unmatchedLine ?? '', /未匹配的/, `墙下没有未匹配出口那一行: ${JSON.stringify(state)}`)

    // 文案长度容忍度（后端解析层 v2 会给未确认卡换上更长的名字）：把三个样本注入真卡片量一遍，
    // 只看两件事——图上的名字最多三行、卡片本身不横向溢出、卡片高度不被撑开。
    const samples = ['Panty & Stocking with Garterbelt', 'Shoujo Kageki Revue Starlight', 'Kamiina Botan, Yoeru Sugata wa Yuri no Hana']
    // 先选一张卡，右栏标题才有东西量。
    await js(`document.querySelector('.catalog-card')?.click()`)
    await until(() => js(`Boolean(document.querySelector('.catalog-rail-title b'))`), 'rail title for the tolerance check', 20000)
    const tolerance = await js(`(() => {
      const samples = ${JSON.stringify(samples)}
      const cards = Array.from(document.querySelectorAll('.catalog-card'))
      const tinted = cards.find(card => card.querySelector('.catalog-art-tinted'))
      const poster = cards.find(card => card.querySelector('.catalog-art-img'))
      // 取色卡是数据决定的（这一轮刮削把每张卡都配上了海报，墙上就可能一张都没有）：
      // 有就一起量，没有就只量海报卡，别把"数据里恰好没有"当成回归。
      const target = tinted ?? poster
      if (!target || !poster) return null
      const heightsBefore = { tinted: Math.round(target.getBoundingClientRect().height), poster: Math.round(poster.getBoundingClientRect().height) }
      const out = []
      for (const sample of samples) {
        const artName = tinted ? tinted.querySelector('.catalog-art-name') : null
        const caption = poster.querySelector('.catalog-title')
        const railTitle = document.querySelector('.catalog-rail-title b')
        const artNameBefore = artName ? artName.textContent : null
        const captionBefore = caption ? caption.textContent : null
        const railBefore = railTitle ? railTitle.textContent : null
        if (artName) artName.textContent = sample
        if (caption) caption.textContent = sample
        if (railTitle) railTitle.textContent = sample
        const style = artName ? getComputedStyle(artName) : null
        const lineHeight = style ? parseFloat(style.lineHeight) || 0 : 0
        out.push({
          sample,
          length: [...sample].length,
          artName: artName ? {
            clamp: style.webkitLineClamp,
            clientHeight: artName.clientHeight,
            scrollHeight: artName.scrollHeight,
            lines: lineHeight ? Math.round(artName.clientHeight / lineHeight) : null,
            horizontalOverflow: artName.scrollWidth > artName.clientWidth + 1,
          } : null,
          card: {
            horizontalOverflow: target.scrollWidth > target.clientWidth + 1,
            height: Math.round(target.getBoundingClientRect().height),
          },
          caption: caption ? { truncated: caption.scrollWidth > caption.clientWidth, horizontalOverflow: poster.scrollWidth > poster.clientWidth + 1 } : null,
          rail: railTitle ? { horizontalOverflow: railTitle.scrollWidth > railTitle.clientWidth + 1, height: Math.round(railTitle.getBoundingClientRect().height) } : null,
        })
        if (artName && artNameBefore !== null) artName.textContent = artNameBefore
        if (caption && captionBefore !== null) caption.textContent = captionBefore
        if (railTitle && railBefore !== null) railTitle.textContent = railBefore
      }
      return { tintedPresent: Boolean(tinted), heightsBefore, heightsAfter: { tinted: Math.round(target.getBoundingClientRect().height), poster: Math.round(poster.getBoundingClientRect().height) }, samples: out }
    })()`)
    console.log('MEDIA_TITLES_TOLERANCE ' + JSON.stringify(tolerance))
    assert.ok(tolerance, '墙上找不到海报卡，量不了文案容忍度')
    for (const item of tolerance.samples) {
      if (item.artName) {
        assert.equal(item.artName.horizontalOverflow, false, `图上名字横向溢出: ${JSON.stringify(item)}`)
        assert.ok(item.artName.lines !== null && item.artName.lines <= 3, `图上名字超过三行: ${JSON.stringify(item)}`)
      }
      assert.equal(item.card.horizontalOverflow, false, `卡片横向溢出: ${JSON.stringify(item)}`)
      assert.ok(item.rail, `右栏标题没量到: ${JSON.stringify(item)}`)
      assert.equal(item.rail.horizontalOverflow, false, `右栏标题横向溢出: ${JSON.stringify(item)}`)
    }
    // 重扫之后墙上是真数据：直接量「当前最长的那张卡」的几何量，比注入样本更有说服力。
    const longest = await js(`(() => {
      const cards = Array.from(document.querySelectorAll('.catalog-card'))
      const measure = card => {
        const artName = card.querySelector('.catalog-art-name')
        const caption = card.querySelector('.catalog-title')
        const node = artName ?? caption
        if (!node) return null
        const style = getComputedStyle(node)
        const lineHeight = parseFloat(style.lineHeight) || 0
        return {
          title: node.textContent.trim(),
          length: [...node.textContent.trim()].length,
          where: artName ? 'art' : 'caption',
          lines: lineHeight ? Math.round(node.clientHeight / lineHeight) : null,
          clamp: style.webkitLineClamp,
          truncated: node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1,
          cardOverflow: card.scrollWidth > card.clientWidth + 1,
          cardHeight: Math.round(card.getBoundingClientRect().height),
          poster: Boolean(card.querySelector('.catalog-art-img')),
        }
      }
      return cards.map(measure).filter(Boolean).sort((a, b) => b.length - a.length).slice(0, 3)
    })()`)
    console.log('MEDIA_TITLES_LONGEST ' + JSON.stringify(longest))
    for (const item of longest) {
      assert.equal(item.cardOverflow, false, `真实最长卡横向溢出: ${JSON.stringify(item)}`)
      if (item.where === 'art') assert.ok(item.lines !== null && item.lines <= 3, `图上名字超过三行: ${JSON.stringify(item)}`)
    }
    assert.ok(longest.length > 0 && longest[0].length >= 20, `量到的真实标题太短，不像真数据: ${JSON.stringify(longest)}`)

    assert.equal(tolerance.heightsAfter.tinted, tolerance.heightsBefore.tinted, '注入长文案后卡片高度被撑开了')
    assert.equal(tolerance.heightsAfter.poster, tolerance.heightsBefore.poster, '注入长文案后海报卡高度被撑开了')

    // 右栏（2026-09-28 用户裁决）：徽标不能压在标题上；Bangumi 简介默认三行 + 展开/收起。
    const rail = await js(`(() => {
      const title = document.querySelector('.catalog-rail-title b')
      const badge = document.querySelector('.catalog-rail-meta .catalog-badge')
      const overview = document.querySelector('.catalog-overview')
      const toggle = document.querySelector('.catalog-overview-toggle')
      const lineHeight = overview ? parseFloat(getComputedStyle(overview).lineHeight) || 0 : 0
      return {
        titleBottom: title ? Math.round(title.getBoundingClientRect().bottom) : null,
        badgeTop: badge ? Math.round(badge.getBoundingClientRect().top) : null,
        badgeText: badge?.textContent?.trim() ?? null,
        overview: overview ? {
          clientHeight: overview.clientHeight,
          scrollHeight: overview.scrollHeight,
          lines: lineHeight ? Math.round(overview.clientHeight / lineHeight) : null,
          clamped: overview.classList.contains('clamped'),
        } : null,
        toggle: toggle?.textContent?.trim() ?? null,
      }
    })()`)
    const railShot = join(tmpdir(), 'watchparty-media-check', 'catalog-rail.png')
    await wait(300)
    await writeFile(railShot, (await window.webContents.capturePage()).toPNG())
    console.log('MEDIA_TITLES_RAIL ' + JSON.stringify({ ...rail, shot: railShot }))
    assert.ok(rail.badgeTop === null || rail.badgeTop >= rail.titleBottom - 1, `徽标压在标题上了: ${JSON.stringify(rail)}`)
    if (rail.overview && rail.overview.scrollHeight > rail.overview.clientHeight + 2) {
      // 简介长到被裁：必须是三行 + 有「展开」。
      assert.ok(rail.overview.lines !== null && rail.overview.lines <= 3, `简介没有裁到三行: ${JSON.stringify(rail)}`)
      assert.equal(rail.overview.clamped, true, `长简介没有 clamped: ${JSON.stringify(rail)}`)
      assert.equal(rail.toggle, '展开', `裁了却没有展开按钮: ${JSON.stringify(rail)}`)
      await js(`document.querySelector('.catalog-overview-toggle')?.click()`)
      await wait(300)
      const expanded = await js(`(() => {
        const overview = document.querySelector('.catalog-overview')
        const toggle = document.querySelector('.catalog-overview-toggle')
        return { clamped: overview.classList.contains('clamped'), toggle: toggle?.textContent?.trim(), grew: overview.clientHeight > ${rail.overview.clientHeight} }
      })()`)
      console.log('MEDIA_TITLES_RAIL_EXPAND ' + JSON.stringify(expanded))
      assert.equal(expanded.clamped, false, `点开展开后还是裁的: ${JSON.stringify(expanded)}`)
      assert.equal(expanded.toggle, '收起', `展开后按钮文案没变: ${JSON.stringify(expanded)}`)
      await js(`document.querySelector('.catalog-overview-toggle')?.click()`)
      await wait(200)
    }

    // 只看待确认（冠军稿里的筛选）：点一下之后墙上只剩待确认的卡。
    const review = await js(`(() => {
      const button = Array.from(document.querySelectorAll('.desktop-page button')).find(node => node.textContent.trim() === '只看待确认')
      if (!button) return null
      const before = document.querySelectorAll('.catalog-card').length
      button.click()
      return { before }
    })()`)
    if (review) {
      await wait(400)
      const after = await js(`(() => ({
        cards: document.querySelectorAll('.catalog-card').length,
        allReview: Array.from(document.querySelectorAll('.catalog-card')).every(node => node.textContent.includes('待确认')),
        pressed: Array.from(document.querySelectorAll('.desktop-page button')).find(node => node.textContent.trim() === '只看待确认')?.getAttribute('aria-pressed') ?? null,
      }))()`)
      console.log('MEDIA_TITLES_REVIEW_FILTER ' + JSON.stringify({ ...review, ...after }))
      assert.ok(after.cards > 0 && after.cards < review.before, `筛选后卡数没变少: ${JSON.stringify({ ...review, ...after })}`)
      assert.equal(after.allReview, true, `筛选后还有非待确认的卡: ${JSON.stringify(after)}`)
      assert.equal(after.pressed, 'true', `按钮没有按下态: ${JSON.stringify(after)}`)
      // 关掉筛选，后面的用例还要用完整墙。
      await js(`Array.from(document.querySelectorAll('.desktop-page button')).find(node => node.textContent.trim() === '只看待确认').click()`)
      await wait(300)
    }

    // 没有海报的条目：取色底 + 首字 + 泛光，名字写在图里，下面不重复标题。
    const tinted = await js(`(() => {
      const node = document.querySelector('.catalog-art-tinted')
      if (!node) return null
      node.scrollIntoView({ block: 'center' })
      const card = node.closest('.catalog-card')
      return {
        glyph: node.querySelector('.catalog-art-glyph')?.textContent ?? null,
        name: node.querySelector('.catalog-art-name')?.textContent?.trim() ?? null,
        background: getComputedStyle(node).backgroundImage.slice(0, 41),
        captionTitles: card ? card.querySelectorAll('.catalog-title').length : null,
      }
    })()`)
    const dir = join(tmpdir(), 'watchparty-media-check')
    await mkdir(dir, { recursive: true })
    const fallbackShot = join(dir, 'catalog-fallback.png')
    await wait(300)
    await writeFile(fallbackShot, (await window.webContents.capturePage()).toPNG())
    console.log('MEDIA_TITLES_FALLBACK ' + JSON.stringify({ ...tinted, shot: fallbackShot }))
    // 取色兜底卡同样是数据决定的：这一轮刮削之后可能每张卡都有海报。没有样本就显式跳过
    // （纯函数那条线由 tests/catalog-view.test.mjs 守着），别把"库里恰好没这种卡"当回归。
    if (!tinted) console.log('MEDIA_TITLES_FALLBACK_SKIPPED ' + JSON.stringify({ reason: '墙上没有取色兜底卡（这一轮每张卡都有海报）' }))
    else {
      assert.equal([...(tinted.glyph ?? '')].length, 1, `首字不是单个字符: ${JSON.stringify(tinted)}`)
      assert.match(tinted.background, /radial-gradient/, `兜底底没有泛光: ${JSON.stringify(tinted)}`)
      assert.equal(tinted.captionTitles, 0, `图上写了名字却又在下面写了标题: ${JSON.stringify(tinted)}`)
    }
  })

  await step('titles-review', async () => {
    // 选一张「待确认」的卡（它一定有候选），右栏应给出候选列表。
    const picked = await js(`(() => {
      const card = Array.from(document.querySelectorAll('.catalog-card')).find(node => node.textContent.includes('待确认'))
      if (!card) return null
      card.click()
      return card.textContent.trim().slice(0, 40)
    })()`)
    // 待确认卡是数据决定的：判定/刮削把候选都确认掉之后，墙上就可能一张都不剩。
    if (!picked) {
      console.log('MEDIA_TITLES_REVIEW_SKIPPED ' + JSON.stringify({ reason: '墙上没有待确认的卡（这一轮判定已把候选确认完）' }))
      return
    }
    // 候选列表在「更多」后面（2026-09-28 起）：等右栏先渲染完再展开，否则 更多 按钮还不存在。
    await until(() => js(`Boolean(document.querySelector('.catalog-rail-title b') || document.querySelector('.catalog-detail-page'))`), 'rail after card click', 20000)
    await wait(600)
    const advanced = await openRailAdvanced(js)
    console.log('MEDIA_TITLES_REVIEW_ADVANCED ' + JSON.stringify({ picked, advanced }))
    await until(() => js(`document.querySelectorAll('.catalog-candidate').length > 0`), 'candidate list', 25000)
    const before = await js(`(() => ({
      title: document.querySelector('.catalog-rail-title b')?.textContent?.trim() ?? null,
      candidates: Array.from(document.querySelectorAll('.catalog-candidate')).map(node => ({ text: node.querySelector('b')?.textContent?.trim() ?? null, score: node.querySelector('.score')?.textContent?.trim() ?? null })),
      episodeRows: document.querySelectorAll('.catalog-ep').length,
    }))()`)
    const shot = join(tmpdir(), 'watchparty-media-check', 'catalog-review.png')
    await wait(300)
    await writeFile(shot, (await window.webContents.capturePage()).toPNG())
    console.log('MEDIA_TITLES_REVIEW ' + JSON.stringify({ picked, ...before, shot }))
    assert.ok(before.candidates.length > 0, `右栏没有候选: ${JSON.stringify(before)}`)
    assert.ok(before.candidates[0].score, `候选没有分数: ${JSON.stringify(before)}`)

    // 确认会真的写进用户标题库（没有撤销接口），所以默认只验候选渲染，
    // 要跑写入路径就显式开 WATCHPARTY_MEDIA_CHECK_REVIEW=1。
    if (process.env.WATCHPARTY_MEDIA_CHECK_REVIEW !== '1') {
      const buttons = await js(`Array.from(document.querySelectorAll('.catalog-candidate .acts button')).map(node => node.textContent.trim())`)
      console.log('MEDIA_TITLES_CONFIRM_SKIPPED ' + JSON.stringify({ buttons: buttons.slice(0, 4) }))
      assert.ok(buttons.includes('确认') && buttons.includes('拒绝'), `候选行缺确认/拒绝按钮: ${JSON.stringify(buttons)}`)
      return
    }
    // 确认第一个候选：标题应当换成候选标题，状态变已确认。
    await js(`document.querySelector('.catalog-candidate .acts button').click()`)
    // 等待条件必须要求"非空且变了"：右栏在换库/重取期间会短暂清空，旧写法（只要不等于旧标题）
    // 会把 null 当成"变了"直接放行，然后在下一行断言里红成"状态不对"（09-30 在慢实例上踩到）。
    await until(() => js(`(() => {
      const text = document.querySelector('.catalog-rail-title b')?.textContent?.trim() ?? null
      return Boolean(text) && text !== ${JSON.stringify(before.title)}
    })()`), 'confirm rewrote the title', 25000)
    await wait(500)
    const after = await js(`(() => ({
      title: document.querySelector('.catalog-rail-title b')?.textContent?.trim() ?? null,
      status: document.querySelector('.catalog-rail-meta .catalog-badge')?.textContent?.trim() ?? null,
      message: document.querySelector('.desktop-page [role="status"]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
      wallTitles: Array.from(document.querySelectorAll('.catalog-title')).map(node => node.textContent.trim()),
    }))()`)
    console.log('MEDIA_TITLES_CONFIRM ' + JSON.stringify({ before: before.title, ...after }))
    assert.equal(after.status, '已确认', `确认后状态不对: ${JSON.stringify(after)}`)
    assert.equal(after.wallTitles.includes(after.title), true, `确认后的标题没有回到墙上: ${JSON.stringify({ title: after.title, sample: after.wallTitles.slice(0, 5) })}`)
  })

  // 人工修绑定（后端 2026-09-27 的编辑 API）：撤销确认 → 搜 Bangumi → 换绑，走 UI。
  await step('titles-edit', async () => {
    // 目标从 API 现挑（标题会被重扫改，别写死）：已确认、且 relDir 多于一个——正好一次覆盖
    // 「人工修绑定」和「多目录分节」两件事。
    const target = await window.webContents.executeJavaScript(`(async () => {
      const get = async (path, query) => {
        const reply = await window.watchpartyDesktop.invoke('mediaRequest', { method: 'GET', path, query, body: null })
        return JSON.parse(reply.body)
      }
      const list = await get('/api/media/catalog', 'libraryId=lib_anime')
      for (const card of (list.items ?? []).filter(item => item.status === 'confirmed')) {
        const detail = await get('/api/media/catalog/' + card.id, null)
        const dirs = [...new Set((detail.children ?? []).map(child => child.relDir))]
        if (dirs.length >= 2 && (detail.children ?? []).length >= 3) return {
          id: card.id, title: card.title, dirs: dirs.length, children: detail.children.length,
          // 撤销确认之后卡会离开标题墙（裁决 ③）：UI 里没有回去的路，所以要把原绑定抄下来，
          // 走 rebind 接口把它恢复原样（这也是这条写半步对 rebind 端点的覆盖）。
          restore: { externalDb: detail.externalDb, externalId: detail.externalId, title: detail.title, originalTitle: detail.originalTitle, year: detail.year, overview: detail.overview },
          // 正式卡身份键：撤销现在会连草稿那份判定一起降级（后端 74cb3af2），所以恢复要把两边都写回去，
          // 否则真库会留下一条"卡已确认、草稿还是候选"的差异。
          itemKey: detail.itemKey ?? null,
        }
      }
      return null
    })()`)
    assert.ok(target, '库里找不到「已确认 + 多目录」的卡，编辑流程没法验')
    const clicked = await js(`(() => {
      const card = Array.from(document.querySelectorAll('.catalog-card')).find(node => node.textContent.includes(${JSON.stringify('__TITLE__')}))
      if (!card) return false
      card.click()
      return true
    })()`.replace('__TITLE__', target.title.slice(0, 24)))
    assert.equal(clicked, true, `墙上找不到目标卡: ${JSON.stringify(target)}`)
    await until(() => js(`Boolean(document.querySelector('.catalog-rail-title b'))`), 'rail for the edit flow', 20000)
    await wait(800)
    const before = await js(`(() => ({
      title: document.querySelector('.catalog-rail-title b')?.textContent?.trim() ?? null,
      status: Array.from(document.querySelectorAll('.catalog-rail-meta .catalog-badge')).map(n => n.textContent.trim()),
      source: document.querySelector('.catalog-rail-meta .catalog-source')?.textContent?.trim() ?? null,
      sections: Array.from(document.querySelectorAll('.catalog-seasons h4')).map(n => n.textContent.trim()),
      children: document.querySelectorAll('.catalog-ep').length,
    }))()`)
    console.log('MEDIA_EDIT_BEFORE ' + JSON.stringify({ target: target.title, dirs: target.dirs, ...before }))
    assert.equal(before.status.includes('已确认'), true, `这张卡不是已确认态: ${JSON.stringify(before)}`)
    // relDir 分节（只读）：真库里的多目录卡必须分段，且节标题非空。
    assert.ok(before.sections.length >= 2, `多目录卡没有分节: ${JSON.stringify(before)}`)
    assert.ok(before.sections.every(title => title.length > 0), `分节标题为空: ${JSON.stringify(before)}`)
    if (process.env.WATCHPARTY_MEDIA_CHECK_REVIEW !== '1') {
      console.log('MEDIA_EDIT_SKIPPED ' + JSON.stringify({ reason: '撤销/换绑会写用户真库，开 WATCHPARTY_MEDIA_CHECK_REVIEW=1 才跑', card: target.title, dirs: target.dirs, sections: before.sections }))
      return
    }

    // 1) 撤销确认
    // 右栏的编辑区（撤销确认 / 换绑条目）2026-09-28 起收在「更多」开关后面：先展开，
    // 否则 `.catalog-edit` 整个不渲染（这条写半步之前一直没跑，静默坏了）。
    const openedPanel = await openRailAdvanced(js)
    await until(() => js(`Boolean(document.querySelector('.catalog-edit'))`), 'rebind panel open', 10000)
    const unconfirmButton = await js(`(() => {
      const button = Array.from(document.querySelectorAll('.catalog-edit button')).find(node => node.textContent.trim() === '撤销确认')
      if (!button) return { found: false, editButtons: Array.from(document.querySelectorAll('.catalog-edit button')).map(node => node.textContent.trim()) }
      button.click()
      return { found: true, disabled: button.disabled }
    })()`)
    // 两步确认（09-30 起）：第一步只出提醒（卡会离开标题墙、落点在审阅页「待人工」），第二步才真发。
    // 用 `>` 限定直系子元素：`.catalog-rebind` 里那个搜索消息也挂 `.catalog-edit-note`。
    const unconfirmConfirm = await js(`(() => {
      const note = document.querySelector('.catalog-edit > .catalog-edit-note')
      const button = Array.from(document.querySelectorAll('.catalog-edit button')).find(node => node.textContent.trim() === '确认撤销')
      if (!button) return { found: false, note: note?.textContent ?? null, editButtons: Array.from(document.querySelectorAll('.catalog-edit button')).map(node => node.textContent.trim()) }
      const text = note?.textContent?.trim() ?? ''
      button.click()
      return { found: true, note: text }
    })()`)
    console.log('MEDIA_EDIT_UNCONFIRM_NOTICE ' + JSON.stringify(unconfirmConfirm))
    assert.equal(unconfirmConfirm.found, true, `两步确认的「确认撤销」没出现: ${JSON.stringify(unconfirmConfirm)}`)
    assert.ok(unconfirmConfirm.note.includes('标题墙') && unconfirmConfirm.note.includes('待人工'), `提醒文案不达意: ${JSON.stringify(unconfirmConfirm.note)}`)
    // 后端把撤销后的状态打回 unmatched（重新排队判定），不是 candidate。
    try {
      await until(() => js(`!Array.from(document.querySelectorAll('.catalog-rail-meta .catalog-badge')).some(n => n.textContent.trim() === '已确认')`), 'status leaves confirmed', 25000)
    } catch (error) {
      // 2026-09-29 晚第一次以 REVIEW=1 跑时这条红了：把现场（按钮/徽标/状态行）一起打出来。
      const dump = await js(`(() => ({
        badges: Array.from(document.querySelectorAll('.catalog-rail-meta .catalog-badge')).map(n => n.textContent.trim()),
        title: document.querySelector('.catalog-rail-title b')?.textContent?.trim() ?? null,
        status: document.querySelector('.desktop-page [role="status"]')?.textContent?.trim() ?? null,
        editButtons: Array.from(document.querySelectorAll('.catalog-edit button')).map(n => ({ text: n.textContent.trim(), disabled: n.disabled })),
      }))()`)
      console.log('MEDIA_EDIT_UNCONFIRM_STUCK ' + JSON.stringify({ target, openedPanel, button: unconfirmButton, ...dump }))
      throw error
    }
    const unconfirmed = await js(`(() => ({
      title: document.querySelector('.catalog-rail-title b')?.textContent?.trim() ?? null,
      status: Array.from(document.querySelectorAll('.catalog-rail-meta .catalog-badge')).map(n => n.textContent.trim()),
      source: document.querySelector('.catalog-rail-meta .catalog-source')?.textContent?.trim() ?? null,
      children: document.querySelectorAll('.catalog-ep').length,
      message: document.querySelector('.desktop-page [role="status"]')?.textContent?.trim() ?? null,
    }))()`)
    console.log('MEDIA_EDIT_UNCONFIRM ' + JSON.stringify({ ...unconfirmed, note: '卡离开标题墙（裁决 ③：未匹配不进墙），右栏随之清空' }))
    assert.equal(unconfirmed.status.includes('已确认'), false, `撤销确认后状态不对: ${JSON.stringify(unconfirmed)}`)
    // 文件数从接口核（DOM 里那张卡已经不在墙上了）。
    const afterUnconfirm = await window.webContents.executeJavaScript(`(async () => {
      const reply = await window.watchpartyDesktop.invoke('mediaRequest', { method: 'GET', path: '/api/media/catalog/' + ${JSON.stringify('__ID__')}, query: null, body: null })
      return JSON.parse(reply.body)
    })()`.replace('__ID__', target.id))
    assert.equal((afterUnconfirm.children ?? []).length, target.children, `撤销确认丢了文件: ${(afterUnconfirm.children ?? []).length} vs ${target.children}`)
    assert.equal(afterUnconfirm.status, 'unmatched', `撤销确认后服务端状态不是 unmatched: ${JSON.stringify(afterUnconfirm.status)}`)

    // 2) 恢复：UI 里没有回头路（未匹配卡不进墙、墙下那行只通 Files），所以用 rebind 把原绑定写回去
    //    ——顺带就是这条写半步对 rebind 端点的覆盖。恢复后卡回到墙上，下面的分节检查才有对象。
    const restored = await window.webContents.executeJavaScript(`(async () => {
      const reply = await window.watchpartyDesktop.invoke('mediaRequest', { method: 'POST', path: '/api/media/catalog/' + ${JSON.stringify(target.id)} + '/rebind', query: null, body: ${JSON.stringify(target.restore)} })
      return { status: reply.status, body: (() => { try { return JSON.parse(reply.body) } catch { return reply.body } })() }
    })()`)
    console.log('MEDIA_EDIT_RESTORE ' + JSON.stringify({ http: restored.status, status: restored.body?.status, confirmedBy: restored.body?.confirmedBy, title: restored.body?.title, children: (restored.body?.children ?? []).length, restoreFrom: { externalDb: target.restore.externalDb, externalId: target.restore.externalId } }))
    assert.equal(restored.status, 200, `恢复（rebind）失败: ${JSON.stringify(restored).slice(0, 240)}`)
    assert.equal(restored.body?.status, 'confirmed', `恢复后状态不是 confirmed: ${JSON.stringify(restored.body?.status)}`)
    assert.equal(restored.body?.confirmedBy, 'rebind', `恢复后 confirmedBy 不是 rebind: ${JSON.stringify(restored.body?.confirmedBy)}`)
    assert.equal((restored.body?.children ?? []).length, target.children, '恢复后文件数不对')
    // 卡恢复了不算完：撤销（`74cb3af2` 起）把**草稿那份判定**也降级了，不写回去真库会留一条
    // "卡已确认 / 草稿还是候选"的差异，下一次 apply 还会把绑定再抹掉。用草稿的 `edit` 把行写回 confirmed
    // （`edit` 不要求绑条在候选里，`confirm` 要求 —— 人工 rebind 过的绑定常常不在候选里）。
    if (target.itemKey) {
      const draftRestore = await window.webContents.executeJavaScript(`(async () => {
        const reply = await window.watchpartyDesktop.invoke('mediaRequest', { method: 'POST', path: '/api/admin/media-libraries/lib_anime/draft/edit', query: null, body: { itemKey: ${JSON.stringify(target.itemKey)}, title: ${JSON.stringify(target.restore.title)}, externalDb: ${JSON.stringify(target.restore.externalDb)}, externalId: ${JSON.stringify(target.restore.externalId)} } })
        return { status: reply.status, body: (() => { try { return JSON.parse(reply.body) } catch { return reply.body } })() }
      })()`)
      console.log('MEDIA_EDIT_DRAFT_RESTORE ' + JSON.stringify({ http: draftRestore.status, itemKey: target.itemKey, status: draftRestore.body?.card?.status, confirmedBy: draftRestore.body?.card?.confirmedBy, title: draftRestore.body?.card?.title }))
      assert.equal(draftRestore.status, 200, `草稿行恢复失败: ${JSON.stringify(draftRestore).slice(0, 240)}`)
    } else {
      console.log('MEDIA_EDIT_DRAFT_RESTORE_SKIPPED ' + JSON.stringify({ reason: '详情没带 itemKey（老接口），草稿行没恢复', id: target.id }))
    }
    // 恢复走的是接口，墙不会自己知道：切到「文件」再切回「点播」逼它重取一次。
    await js(`Array.from(document.querySelectorAll('.seg-item')).find(node => node.textContent.trim() === '文件')?.click()`)
    await until(() => js(`document.querySelectorAll('.media-card').length > 0`), 'files grid after restore', 20000)
    await js(`Array.from(document.querySelectorAll('.seg-item')).find(node => node.textContent.trim() === '点播')?.click()`)
    await until(() => js(`document.querySelectorAll('.catalog-card').length > 0`), 'wall reloaded after restore', 25000)
    await wait(600)

    // 3) 多目录卡的分节（换绑后这张卡上仍然看得到）
    await js(`Array.from(document.querySelectorAll('.catalog-card')).find(node => node.textContent.includes(${JSON.stringify('__TITLE2__')}))?.click()`.replace('__TITLE2__', target.title.slice(0, 24)))
    await wait(1400)
    const sections = await js(`(() => ({
      titles: Array.from(document.querySelectorAll('.catalog-seasons h4')).map(n => n.textContent.replace(/\\s+/g, ' ').trim()),
      rows: document.querySelectorAll('.catalog-ep').length,
    }))()`)
    const server = await window.webContents.executeJavaScript(`(async () => {
      const reply = await window.watchpartyDesktop.invoke('mediaRequest', { method: 'GET', path: '/api/media/catalog/' + ${JSON.stringify('__ID__')}, query: null, body: null })
      return JSON.parse(reply.body)
    })()`.replace('__ID__', target.id))
    console.log('MEDIA_EDIT_SERVER ' + JSON.stringify({
      id: server.id, title: server.title, year: server.year, status: server.status,
      confirmedBy: server.confirmedBy, posterUrl: server.posterUrl, subtitle: server.subtitle,
      children: (server.children ?? []).length,
      relDirs: [...new Set((server.children ?? []).map(child => child.relDir))].length,
    }))
    console.log('MEDIA_EDIT_SECTIONS ' + JSON.stringify(sections))
    assert.ok(sections.titles.length >= 2, `多目录卡没有分节: ${JSON.stringify(sections)}`)
    assert.ok(sections.titles.every(title => title.length > 0), `分节标题为空: ${JSON.stringify(sections)}`)
  })

  await step('files-hides-non-video', async () => {
    await js(`Array.from(document.querySelectorAll('.seg-item')).find(node => node.textContent.trim() === '文件').click()`)
    await until(() => js(`document.querySelectorAll('.media-card').length > 0`), 'files grid', 25000)
    await wait(400)
    const state = await js(`(() => {
      const cards = Array.from(document.querySelectorAll('.media-card'))
      const line = document.querySelector('.catalog-unmatched')
      return {
        cards: cards.length,
        extensions: Array.from(new Set(cards.map(card => (card.textContent.match(/\\b(JPG|PNG|NFO|MKV|MP4|JPE?G)\\b/) ?? ['?'])[0]))),
        hidden: line?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
        toggle: Boolean(Array.from(document.querySelectorAll('.catalog-unmatched button')).find(node => node.textContent.includes('显示全部'))),
      }
    })()`)
    console.log('MEDIA_FILES_FILTER ' + JSON.stringify(state))
    assert.equal(state.hidden !== null, true, `没有隐藏计数那一行: ${JSON.stringify(state)}`)
    assert.equal(state.toggle, true, `没有「显示全部」开关: ${JSON.stringify(state)}`)
    assert.equal(state.extensions.includes('JPG') || state.extensions.includes('PNG') || state.extensions.includes('JPE'), false, `非视频文件还在: ${JSON.stringify(state)}`)
    // 打开开关后它们要回来。
    await js(`Array.from(document.querySelectorAll('.catalog-unmatched button')).find(node => node.textContent.includes('显示全部')).click()`)
    await wait(400)
    const shown = await js(`(() => ({ cards: document.querySelectorAll('.media-card').length, images: Array.from(document.querySelectorAll('.media-card')).filter(card => /\\b(JPG|PNG)\\b/.test(card.textContent)).length }))()`)
    console.log('MEDIA_FILES_FILTER_SHOWN ' + JSON.stringify(shown))
    assert.ok(shown.cards > state.cards, `显示全部后卡片没有变多: ${JSON.stringify({ before: state.cards, ...shown })}`)
  })
}

/**
 * 相位 2：目录自己的封面。用真实库里唯一带 poster.jpg 的目录（偶像大师 (2011)）验，
 * 断言的是 `<img>` 真的解码出像素（naturalWidth > 0）——那一步只有整条链路
 * （资产服务器 → 侧车带站点凭据 → OpenList 字节）都通了才会成立。
 */
async function runArtworkCheck({ window, js, until, step }) {
  await step('artwork-missing', async () => {
    // 走 HTML 的 <img>（渲染层 CSP 允许 img-src 'self'），不 fetch。
    const loaded = await js(`new Promise(resolve => {
      const image = new Image()
      image.onload = () => resolve({ ok: true, width: image.naturalWidth })
      image.onerror = () => resolve({ ok: false })
      image.src = '/artwork/' + encodeURIComponent('v2.not.a.real.id')
      setTimeout(() => resolve({ ok: false, timeout: true }), 8000)
    })`)
    console.log('MEDIA_ARTWORK_MISSING ' + JSON.stringify(loaded))
    assert.equal(loaded.ok, false, `编造的 mediaId 竟然出了图: ${JSON.stringify(loaded)}`)
  })

  await step('artwork-folder', async () => {
    const listOnce = query => window.webContents.executeJavaScript(`window.watchpartyDesktop.invoke('mediaRequest', { method: 'GET', path: '/api/media/list', query: ${JSON.stringify(query)}, body: null })`)
      .then(reply => { try { return JSON.parse(reply.body) } catch { return {} } })
    const root = await listOnce('libraryId=lib_anime&path=%2F')
    const folder = (root.items ?? []).find(item => item.type === 'dir' && item.name.includes('偶像大师'))
    assert.ok(folder, `真实库里没找到带封面的目录: ${JSON.stringify((root.items ?? []).slice(0, 4).map(item => item.name))}`)
    const inside = await listOnce(`libraryId=lib_anime&path=${encodeURIComponent(folder.relativePath)}`)
    // 先证传输：直接问侧车要这张图，看清是链路问题还是渲染问题。
    const probe = await window.webContents.executeJavaScript(`window.watchpartyDesktop.invoke('mediaImage', { kind: 'media', id: ${JSON.stringify(inside.posterId ?? '')} }).then(
      value => ({ ok: true, contentType: value?.contentType ?? null, bytes: (value?.base64 ?? '').length }),
      error => ({ ok: false, code: error?.code ?? String(error) })
    )`)
    console.log('MEDIA_ARTWORK_TRANSPORT ' + JSON.stringify({ folder: folder.name, folderPosterId: Boolean(inside.posterId), ...probe }))
    assert.ok(inside.posterId, `这个目录本来该有封面: ${JSON.stringify({ folder: folder.name })}`)
    assert.equal(probe.ok, true, `侧车取不到这张封面: ${JSON.stringify(probe)}`)
    assert.ok(probe.bytes > 1000, `封面字节太少: ${JSON.stringify(probe)}`)
    await until(() => js(`Array.from(document.querySelectorAll('.media-card-open')).some(node => node.textContent.includes(${JSON.stringify(folder.name)}))`), 'poster folder card', 20000)
    await js(`Array.from(document.querySelectorAll('.media-card-open')).find(node => node.textContent.includes(${JSON.stringify(folder.name)})).click()`)
    await until(() => js(`Boolean(document.querySelector('.media-folder-banner img'))`), 'folder banner', 25000)
    const banner = await js(`new Promise(resolve => {
      const image = document.querySelector('.media-folder-banner img')
      const done = () => resolve({
        complete: image.complete,
        width: image.naturalWidth,
        height: image.naturalHeight,
        name: document.querySelector('.media-folder-banner-name')?.textContent?.trim() ?? null,
      })
      if (image.complete) return done()
      image.addEventListener('load', done, { once: true })
      image.addEventListener('error', done, { once: true })
      setTimeout(done, 15000)
    })`)
    const dir = join(tmpdir(), 'watchparty-media-check')
    await mkdir(dir, { recursive: true })
    const shot = join(dir, 'media-folder-cover.png')
    await wait(400)
    await writeFile(shot, (await window.webContents.capturePage()).toPNG())
    console.log('MEDIA_ARTWORK_BANNER ' + JSON.stringify({ folder: folder.name, ...banner, shot }))
    assert.ok(banner.width > 0 && banner.height > 0, `横幅图没有解码出像素: ${JSON.stringify(banner)}`)
  })

  // 卡片封面：需要一个既有 poster.jpg 又有视频文件的目录 —— 真实库里没有这种目录
  // （偶像大师那个只有图和 nfo），所以这一条跑在夹具源上：先
  // `node electron/artwork-fixture.mjs start`，没有那个库时这一步自动跳过。
  await step('artwork-card', async () => {
    const hasFixture = await js(`Array.from(document.querySelectorAll('.media-lib-chip')).some(node => node.textContent.includes('Fixture'))`)
    if (!hasFixture) {
      console.log('MEDIA_ARTWORK_CARD_SKIPPED {"reason":"夹具源不在库列表里"}')
      return
    }
    await js(`Array.from(document.querySelectorAll('.media-lib-chip')).find(node => node.textContent.includes('Fixture')).click()`)
    await until(() => js(`Array.from(document.querySelectorAll('.media-card')).some(node => node.textContent.includes('Fixture.Movie.2024.mkv'))`), 'fixture card', 20000)
    await until(() => js(`Boolean(Array.from(document.querySelectorAll('.media-card')).find(node => node.textContent.includes('.mkv'))?.querySelector('.media-card-art img'))`), 'card thumbnail', 20000)
    const video = await js(`new Promise(resolve => {
      const image = Array.from(document.querySelectorAll('.media-card')).find(node => node.textContent.includes('.mkv')).querySelector('.media-card-art img')
      const done = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
      if (image.complete) return done()
      image.addEventListener('load', done, { once: true })
      image.addEventListener('error', done, { once: true })
      setTimeout(done, 15000)
    })`)
    const stills = await js(`Array.from(document.querySelectorAll('.media-card')).filter(node => /\\.(jpg|png|webp)/i.test(node.textContent)).map(node => ({ name: node.textContent.trim().slice(0, 16), hasImage: Boolean(node.querySelector('.media-card-art img')) }))`)
    const dir = join(tmpdir(), 'watchparty-media-check')
    await mkdir(dir, { recursive: true })
    const shot = join(dir, 'media-card-cover.png')
    await wait(400)
    await writeFile(shot, (await window.webContents.capturePage()).toPNG())
    console.log('MEDIA_ARTWORK_CARD ' + JSON.stringify({ video, stills, shot }))
    assert.ok(video.width > 0 && video.height > 0, `视频卡片的封面没有解码出像素: ${JSON.stringify(video)}`)
    assert.equal(stills.some(still => still.hasImage), false, `图片文件不该有封面缩略图: ${JSON.stringify(stills)}`)
  })
}

/**
 * P1-5：坏源隔离。做法是把第二台源指向本进程的 TCP 转发口，存的时候是活的，
 * 之后掐掉转发 —— 这是「源在保存后掉线」唯一能在本地复现的路径（保存时探不通的源服务端整单拒绝）。
 */
async function runSourceIsolationCheck({ js, invoke, until, step, origin }) {
  const net = await import('node:net')
  const sockets = new Set()
  const forwarder = net.createServer(socket => {
    const upstream = net.connect(5349, '127.0.0.1')
    sockets.add(socket); sockets.add(upstream)
    socket.pipe(upstream); upstream.pipe(socket)
    const drop = () => { sockets.delete(socket); sockets.delete(upstream); socket.destroy(); upstream.destroy() }
    socket.on('close', drop); upstream.on('close', drop)
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy())
  })
  await new Promise(resolve => forwarder.listen(0, '127.0.0.1', resolve))
  const port = forwarder.address().port
  const login = await openlistLogin()
  const created = await invoke('mediaRequest', { method: 'POST', path: '/api/admin/media-sources', query: null, body: {
    name: 'Isolation check', internalBaseUrl: `http://127.0.0.1:${port}`, publicBaseUrl: `http://127.0.0.1:${port}`,
    username: login.username, password: login.password,
    libraries: [{ name: 'Isolation', kind: 'other', path: '/media/openlist-bdyun/Multimedia/Anime' }],
  } })
  const source = (() => { try { return JSON.parse(created.body) } catch { return {} } })()
  console.log('MEDIA_ISOLATION_CREATE ' + JSON.stringify({ status: created.status, id: source.id ?? null, libraries: source.libraries?.map(library => library.name) ?? null }))
  assert.equal(created.status, 201, `转发口上的源没建起来: ${JSON.stringify(created)}`)

  const healthOf = async () => {
    const listed = await invoke('mediaRequest', { method: 'GET', path: '/api/media/libraries', query: null, body: null })
    const rows = (() => { try { return JSON.parse(listed.body).libraries ?? [] } catch { return [] } })()
    return rows.map(row => [row.name, row.health])
  }
  await step('isolation-live', async () => {
    const rows = await healthOf()
    console.log('MEDIA_ISOLATION_LIVE ' + JSON.stringify(rows))
    assert.equal(rows.filter(([name]) => name === 'Isolation').length, 1, `这台源的行数不是 1（有上一次跑剩下的？）: ${JSON.stringify(rows)}`)
    assert.ok(rows.some(([name, health]) => name === 'Isolation' && health === 'ok'), `转发口上的库不是 ok: ${JSON.stringify(rows)}`)
  })

  // 掐掉转发口，等过健康缓存（5s）再读：这台源变坏，别的库不受影响。
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => forwarder.close(resolve))
  await wait(6000)
  await step('isolation-dead', async () => {
    const rows = await healthOf()
    console.log('MEDIA_ISOLATION_DEAD ' + JSON.stringify(rows))
    assert.ok(rows.some(([name, health]) => name === 'Isolation' && health !== 'ok'), `掉线的源没有变坏: ${JSON.stringify(rows)}`)
    assert.ok(rows.some(([name, health]) => name === 'Anime' && health === 'ok'), `好库被坏源带坏了: ${JSON.stringify(rows)}`)
  })

  // UI：切到坏的库要给出码映射后的提示，切回好库要照常出卡片。
  // 库列表和健康位是「打开选择器时读一次」（handoff F1，不挂定时器），
  // 所以建源之后要重进一次媒体视图才会看到新 chip。
  await step('isolation-ui', async () => {
    const clickButton = label => js(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find(node => node.textContent.trim() === ${JSON.stringify(label)})
      if (!button) throw new Error('missing button ' + ${JSON.stringify(label)})
      button.click()
      return true
    })()`)
    await clickButton('返回当前会话')
    await until(() => js(`Boolean(document.querySelector('button[aria-label="添加媒体"]'))`), 'room media button again', 20000)
    await js(`document.querySelector('button[aria-label="添加媒体"]').click()`)
    await until(() => js(`document.querySelectorAll('.media-lib-chip').length >= 4`), 'isolation chip', 20000)
    // 重新挂载后回到默认 Titles：这一步量的是文件视图，先切过去。
    await js(`Array.from(document.querySelectorAll('.seg-item')).find(node => node.textContent.trim() === '文件').click()`)
    await until(() => js(`document.querySelectorAll('.media-lib-chip').length >= 4 && Array.from(document.querySelectorAll('.seg-item')).some(node => node.textContent.trim() === '文件' && node.getAttribute('aria-pressed') === 'true')`), 'files mode again', 20000)
    await wait(600)
    const chips = await js(`Array.from(document.querySelectorAll('.media-lib-chip')).map(node => ({ text: node.textContent.trim(), health: node.querySelector('.media-lib-health')?.className.replace('media-lib-health', '').trim() || 'ok' }))`)
    const clickChip = name => js(`(() => {
      const chip = Array.from(document.querySelectorAll('.media-lib-chip')).find(node => node.textContent.includes(${JSON.stringify(name)}))
      if (!chip) throw new Error('missing chip ' + ${JSON.stringify(name)})
      chip.click()
      return true
    })()`)
    await clickChip('Isolation')
    await until(() => js(`Boolean(document.querySelector('.desktop-page [role="status"]'))`), 'dead library banner', 20000)
    await wait(1200)
    const dead = await js(`(() => ({
      message: document.querySelector('.desktop-page [role="status"]')?.textContent?.trim() ?? null,
      cards: document.querySelectorAll('.media-card').length,
      retry: Boolean(Array.from(document.querySelectorAll('.desktop-page button')).find(node => node.textContent.trim() === '重试')),
    }))()`)
    await clickChip('Anime')
    await until(() => js(`document.querySelectorAll('.media-card').length > 0 && !document.body.innerText.includes('这个库当前不可用')`), 'good library cards back', 20000)
    const alive = await js(`(() => ({ cards: document.querySelectorAll('.media-card').length, message: document.querySelector('.desktop-page [role="status"]')?.textContent?.trim() ?? null }))()`)
    console.log('MEDIA_ISOLATION_UI ' + JSON.stringify({ chips, dead, alive }))
    assert.ok(chips.some(chip => chip.text.includes('Isolation') && chip.health !== 'ok'), `坏源在切换器里没有标志成坏: ${JSON.stringify(chips)}`)
    assert.ok(chips.some(chip => chip.text.includes('Anime') && chip.health === 'ok'), `好源在切换器里不是 ok: ${JSON.stringify(chips)}`)
    assert.match(dead.message ?? '', /这个库当前不可用（连不上）/, `坏库的横幅没说是连不上: ${JSON.stringify(dead)}`)
    // 换库失败不能把上一个库的卡片留在屏幕上。
    assert.equal(dead.cards, 0, `坏库下面还挂着别的库的卡片: ${JSON.stringify(dead)}`)
    assert.equal(dead.retry, true, `坏库没有重试入口: ${JSON.stringify(dead)}`)
    assert.ok(alive.cards > 0, `切回好库没有卡片: ${JSON.stringify(alive)}`)
    assert.equal(alive.message, null, `切回好库横幅没消失: ${JSON.stringify(alive)}`)
  })

  const removed = await invoke('mediaRequest', { method: 'DELETE', path: `/api/admin/media-sources/${source.id}`, query: null, body: null })
  console.log('MEDIA_ISOLATION_CLEANUP ' + JSON.stringify({ id: source.id ?? null, status: removed.status, origin }))
  assert.equal(removed.status, 204, `清理没成功: ${JSON.stringify(removed)}`)
}

/**
 * P1-5 最后一段：真的从卡片点一次播放。走的是既有的房间 resolve（v2 mediaId），
 * 断言的是「标题进了房间状态」——播放器本身由 libmpv 承担，不在这个 harness 的职责里。
 */
async function runPlayCheck({ window, js, until, step }) {
  await step('play-resolve', async () => {
    const target = await js(`(() => {
      const card = Array.from(document.querySelectorAll('article.media-card')).find(node =>
        Array.from(node.querySelectorAll('button')).some(button => button.textContent.trim() === '播放' && !button.disabled))
      if (!card) return null
      const title = card.querySelector('.media-card-open span span')?.textContent?.trim() ?? ''
      Array.from(card.querySelectorAll('button')).find(button => button.textContent.trim() === '播放').click()
      return title
    })()`)
    assert.ok(target, '目录里没有可播的文件卡片')
    await until(() => js(`document.body.innerText.includes(${JSON.stringify(target)}) && !document.querySelector('.media-lib-chip')`), 'room shows the media', 30000)
    // 时长是播放器读了容器才有的：mpv 起得慢，得等它，不能点完就读。
    await until(() => js(`/[0-9]{2}:[0-9]{2}:[0-9]{2}/.test(document.body.innerText)`), 'player duration', 40000)
    const room = await js(`(() => ({
      text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300),
      playing: /[0-9]{1,2}:[0-9]{2}:[0-9]{2}/.test(document.body.innerText),
      mediaViewGone: !document.querySelector('.media-lib-chip'),
    }))()`)
    console.log('MEDIA_PLAY_RESOLVE ' + JSON.stringify({ target, ...room }))
    assert.equal(room.mediaViewGone, true, `点播放后没有离开媒体视图: ${JSON.stringify(room)}`)
    // 房间读到了时长，说明 v2 mediaId 在服务端 resolve 成功、播放器拿到了媒体信息。
    assert.equal(room.playing, true, `房间没有时长（resolve 没成功或播放器没起）: ${JSON.stringify(room)}`)

    // 播放页不该再占 48px 顶栏：页面顶到 0，顶层的悬浮控件自带窗口按钮（自绘，随控件收放）。
    const chrome = await js(`(() => {
      const caption = document.getElementById('watchparty-titlebar')
      const buttons = Array.from(document.querySelectorAll('.room-window-btn'))
      const header = document.querySelector('.media-top-scrim')
      const drag = header ? getComputedStyle(header).webkitAppRegion ?? getComputedStyle(header).getPropertyValue('-webkit-app-region') : null
      const queue = document.querySelector('button[aria-label^="播放队列"]')
      const close = document.querySelector('.room-window-close')
      return {
        titleHeight: getComputedStyle(document.documentElement).getPropertyValue('--desktop-title-height').trim(),
        bodyPaddingTop: getComputedStyle(document.body).paddingTop,
        rootTop: Math.round(document.getElementById('root').getBoundingClientRect().top),
        scrimTop: Math.round(document.querySelector('.media-scrim')?.getBoundingClientRect().top ?? -1),
        captionDisplay: caption ? getComputedStyle(caption).display : 'missing',
        labels: buttons.map(node => node.getAttribute('aria-label')),
        drag,
        controlsVisible: getComputedStyle(document.querySelector('.media-bottom-scrim')).opacity,
        closeCorner: close ? { top: Math.round(close.getBoundingClientRect().top), fromRight: Math.round(innerWidth - close.getBoundingClientRect().right), width: Math.round(close.getBoundingClientRect().width) } : null,
        queueBottom: queue ? { fromBottom: Math.round(innerHeight - queue.getBoundingClientRect().bottom), width: Math.round(queue.getBoundingClientRect().width) } : null,
      }
    })()`)
    const playbackShot = join(tmpdir(), 'watchparty-media-check', 'room-playback.png')
    await mkdir(join(tmpdir(), 'watchparty-media-check'), { recursive: true })
    await wait(300)
    await writeFile(playbackShot, (await window.webContents.capturePage()).toPNG())
    console.log('MEDIA_PLAY_CHROME ' + JSON.stringify({ ...chrome, shot: playbackShot }))
    assert.equal(chrome.captionDisplay, 'none', `播放页还画着系统顶栏: ${JSON.stringify(chrome)}`)
    assert.equal(chrome.titleHeight, '0px', `播放页仍预留顶栏高度: ${JSON.stringify(chrome)}`)
    assert.equal(chrome.bodyPaddingTop, '0px', `播放页 body 仍被顶栏顶下去: ${JSON.stringify(chrome)}`)
    assert.equal(chrome.rootTop, 0, `播放页内容没有顶到 y=0: ${JSON.stringify(chrome)}`)
    assert.equal(chrome.scrimTop, 0, `播放层没有铺满窗口顶部（上阴影被挤占）: ${JSON.stringify(chrome)}`)
    assert.deepEqual(chrome.labels, ['最小化', '最大化', '关闭'], `播放页缺自绘窗口按钮: ${JSON.stringify(chrome)}`)
    assert.equal(chrome.drag, 'drag', `播放页顶部悬浮层不是拖拽区: ${JSON.stringify(chrome)}`)
    // 位置：窗口三键贴右上角（用户明确要留在原地），队列/成员已挪到底部控件行。
    assert.ok(chrome.closeCorner && chrome.closeCorner.top <= 2 && chrome.closeCorner.fromRight <= 2, `窗口三键不在右上角: ${JSON.stringify(chrome.closeCorner)}`)
    assert.equal(chrome.closeCorner.width, 46, `窗口按钮尺码与顶栏不一致: ${JSON.stringify(chrome.closeCorner)}`)
    assert.ok(chrome.queueBottom && chrome.queueBottom.fromBottom < 64, `队列控件没在底部: ${JSON.stringify(chrome.queueBottom)}`)
    assert.equal(chrome.queueBottom.width, 32, `底部控件尺码不统一: ${JSON.stringify(chrome.queueBottom)}`)
    // 控件会空闲自动隐藏（设计如此）：动一下鼠标，窗口按钮要跟着一起回来、且可点。
    await js(`document.querySelector('.media-scrim').dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))`)
    await wait(500)
    const revealed = await js(`(() => {
      const strip = document.querySelector('.media-bottom-scrim')
      const queue = document.querySelector('button[aria-label^="播放队列"]')
      const close = document.querySelector('.room-window-close')
      const style = getComputedStyle(strip)
      const queueLeft = queue ? Math.round(queue.getBoundingClientRect().left) : -1
      const fullscreen = document.querySelector('button[aria-label="全屏"], button[aria-label="退出全屏"]')
      const fullscreenLeft = fullscreen ? Math.round(fullscreen.getBoundingClientRect().left) : -1
      return {
        opacity: style.opacity, pointerEvents: style.pointerEvents,
        closeWidth: close ? Math.round(close.getBoundingClientRect().width) : 0,
        closeHeight: close ? Math.round(close.getBoundingClientRect().height) : 0,
        closeVisible: close ? Math.round(close.getBoundingClientRect().top) : -1,
        queueBeforeFullscreen: queueLeft >= 0 && fullscreenLeft >= 0 && queueLeft < fullscreenLeft,
      }
    })()`)
    console.log('MEDIA_PLAY_CHROME_REVEAL ' + JSON.stringify(revealed))
    assert.equal(revealed.opacity, '1', `鼠标动了控件没回来: ${JSON.stringify(revealed)}`)
    assert.notEqual(revealed.pointerEvents, 'none', `控件不可点: ${JSON.stringify(revealed)}`)
    assert.equal(revealed.queueBeforeFullscreen, true, `队列/成员没排在全屏键左边: ${JSON.stringify(revealed)}`)
    assert.ok(revealed.closeVisible >= 0 && revealed.closeVisible < 48, `窗口三键不在顶部那条里: ${JSON.stringify(revealed)}`)
  })
}

/**
 * 草稿审阅（第 4 块，方案 B）——**只读**：只读草稿、只断言渲染，不点判定/应用（那两个会写库）。
 * 草稿来自上一个真实步骤的库（lib_anime 有 64 张），形状与 `GET .../classify` 对拍。
 */
async function runDraftCheck({ window, js, invoke, until, step }) {
  await step('draft-panel', async () => {
    await js(`Array.from(document.querySelectorAll('button[aria-label="设置"]'))[0]?.click()`)
    await until(() => js(`Boolean(document.querySelector('.fluent-settings-nav'))`), 'settings nav for draft', 15000)
    await js(`(() => { const tab = Array.from(document.querySelectorAll('.fluent-settings-nav [role="tab"]')).find(node => node.textContent.includes('媒体库')); tab?.click(); return Boolean(tab) })()`)
    await until(() => js(`Boolean(document.querySelector('.draft'))`), 'draft panel', 25000)
    await wait(400)

    const server = await invoke('mediaRequest', { method: 'GET', path: '/api/admin/media-libraries/lib_anime/classify', query: null, body: null })
    const payload = JSON.parse(server.body)
    const expected = {
      cards: payload.draft.length,
      pending: payload.pending,
      added: payload.diff.added.length,
      moved: payload.diff.moved.length,
      drift: payload.diff.confirmedDrift.length,
      unchanged: payload.diff.unchanged,
    }
    const ui = await js(`(() => {
      const chips = Array.from(document.querySelectorAll('.draft-chips .draft-chip')).map(node => ({ label: node.textContent.replace(/s+/g, '').trim(), on: node.getAttribute('aria-pressed') === 'true' }))
      return {
        stats: document.querySelector('.draft-stats')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
        chips: chips.map(chip => chip.label),
        chipsOn: chips.filter(chip => chip.on).length,
        rows: document.querySelectorAll('.draft-table tbody tr.draft-row').length,
        detailRows: document.querySelectorAll('.draft-detail-row').length,
        progress: document.querySelector('.draft-progress-meta')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
        applyLabel: Array.from(document.querySelectorAll('.draft-bar button')).map(node => node.textContent.trim()).find(text => text.includes('应用')) ?? null,
      }
    })()`)
    const shot = join(tmpdir(), 'watchparty-media-check', 'catalog-draft.png')
    await mkdir(join(tmpdir(), 'watchparty-media-check'), { recursive: true })
    await writeFile(shot, (await window.webContents.capturePage()).toPNG())
    console.log('MEDIA_DRAFT_PANEL ' + JSON.stringify({ expected, ...ui, shot }))
    assert.equal(ui.rows, expected.cards, `表格行数与草稿卡数不一致: ${JSON.stringify({ expected, ui })}`)
    assert.ok(ui.chips.includes(`${expected.added}新建`), `新建 chip 计数不对: ${JSON.stringify(ui.chips)}`)
    assert.ok(ui.chips.includes(`${expected.drift}已确认漂移`), `漂移 chip 计数不对: ${JSON.stringify(ui.chips)}`)
    assert.ok(ui.chips.includes(`${expected.pending}未判定`), `未判定 chip 计数不对: ${JSON.stringify(ui.chips)}`)
    assert.equal(ui.chipsOn, 1, `默认应当只有一个筛选中: ${JSON.stringify(ui.chips)}`)
    assert.match(ui.progress ?? '', new RegExp(`还剩 ${expected.pending} 张未判定`), `进度行没有未判定数: ${JSON.stringify(ui)}`)
    if (expected.pending > 0) assert.match(ui.applyLabel ?? '', /张未判定/, `应用按钮没提示未判定: ${JSON.stringify(ui)}`)

    // 展开一条移动过的卡：详情里要能看到「键位更新」与来源目录。
    // 库状态会变：没有移动卡时退回「全部」，别让整步卡在一个空的筛选上。
    await js(`(() => {
      const chip = Array.from(document.querySelectorAll('.draft-chips .draft-chip')).find(node => node.textContent.includes('移动') && !node.textContent.startsWith('0'))
        ?? Array.from(document.querySelectorAll('.draft-chips .draft-chip')).find(node => node.textContent.includes('全部'));
      chip?.click(); return Boolean(chip)
    })()`)
    await wait(300)
    await js(`document.querySelector('.draft-table tbody tr.draft-row .draft-open')?.click()`)
    await until(() => js(`Boolean(document.querySelector('.draft-detail'))`), 'draft row expanded', 15000)
    // children 走 ?item= 子请求：等文件清单真的渲染出来（这一条同时验证新端点通）。
    await until(() => js(`document.querySelectorAll('.draft-files .draft-file-list li').length > 0`), 'draft children via ?item=', 25000)
    const detail = await js(`(() => ({
      files: document.querySelectorAll('.draft-files .draft-file-list li').length,
      groups: Array.from(document.querySelectorAll('.draft-files h5')).map(node => node.textContent.replace(/s+/g, ' ').trim()),
      text: document.querySelector('.draft-detail')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 200) ?? null,
      hasRel: Boolean(document.querySelector('.draft-detail .draft-rel')),
    }))()`)
    console.log('MEDIA_DRAFT_DETAIL ' + JSON.stringify(detail))
    assert.equal(detail.hasRel, true, `展开里没有库内相对路径: ${JSON.stringify(detail)}`)
    if (expected.moved > 0) assert.match(detail.text ?? '', /键位更新/, `移动卡展开后没有键位更新说明: ${JSON.stringify(detail)}`)

    // 展开一张「判过的」卡：候选与分数来自真判定（这批用后端判好的 20 张），顺手留一张图。
    await js(`(() => { const chip = Array.from(document.querySelectorAll('.draft-chips .draft-chip')).find(node => node.textContent.includes('待人工')); chip?.click(); return Boolean(chip) })()`)
    await wait(300)
    const judgedRow = await js(`(() => {
      const open = document.querySelector('.draft-table tbody tr.draft-row .draft-open')
      if (!open) return null
      open.click()
      return open.textContent.trim().slice(0, 60)
    })()`)
    if (judgedRow) {
      await until(() => js(`document.querySelectorAll('.draft-cands .draft-cand').length > 0`), 'candidates of a judged card', 20000)
      await wait(300)
      const candShot = join(tmpdir(), 'watchparty-media-check', 'catalog-draft-candidates.png')
      await mkdir(join(tmpdir(), 'watchparty-media-check'), { recursive: true })
      await writeFile(candShot, (await window.webContents.capturePage()).toPNG())
      const cands = await js(`(() => ({
        rows: document.querySelectorAll('.draft-cands .draft-cand').length,
        scores: Array.from(document.querySelectorAll('.draft-cands .draft-cand-score')).map(node => node.textContent.trim()),
        hint: document.querySelector('.draft-cands-head')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
      }))()`)
      console.log('MEDIA_DRAFT_CANDIDATES ' + JSON.stringify({ card: judgedRow, ...cands, shot: candShot }))
      assert.ok(cands.rows > 0, `判过的卡展开没有候选: ${JSON.stringify(cands)}`)
      assert.match(cands.hint ?? '', /≥ \d\.\d\d/, `候选提示没写阈值: ${JSON.stringify(cands)}`)
      await js(`document.querySelector('.draft-table tbody tr.draft-row .draft-open')?.click()`)
    } else {
      console.log('MEDIA_DRAFT_CANDIDATES_SKIPPED ' + JSON.stringify({ reason: '这一轮没有「待人工」的卡（判定进度靠后端，可能全自动确认了）' }))
    }

    // 应用确认弹层（只看不点）：必须列出新建/删除/改写，且漂移单独一段。
    await js(`(() => { const chip = Array.from(document.querySelectorAll('.draft-chips .draft-chip')).find(node => node.textContent.includes('全部')); chip?.click(); return true })()`)
    await js(`Array.from(document.querySelectorAll('.draft-bar button')).find(node => node.textContent.includes('应用草稿'))?.click()`)
    await until(() => js(`Boolean(document.querySelector('.draft-dialog'))`), 'apply dialog', 15000)
    const applyShot = join(tmpdir(), 'watchparty-media-check', 'catalog-draft-apply.png')
    await mkdir(join(tmpdir(), 'watchparty-media-check'), { recursive: true })
    await wait(300)
    await writeFile(applyShot, (await window.webContents.capturePage()).toPNG())
    const dialog = await js(`(() => ({
      text: document.querySelector('.draft-dialog')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 260) ?? null,
      drift: Boolean(document.querySelector('.draft-drift-box')),
      danger: Boolean(document.querySelector('.draft-dialog.danger')),
      pairs: Array.from(document.querySelectorAll('.draft-pair')).map(node => node.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120)),
      equations: Array.from(document.querySelectorAll('.draft-pair-list li > span:first-child')).map(node => node.textContent.replace(/\\s+/g, ' ').trim()),
      binds: Array.from(document.querySelectorAll('.draft-bind:not(.warn)')).map(node => node.textContent.replace(/\\s+/g, ' ').trim()),
      moves: Array.from(document.querySelectorAll('.draft-bind.warn')).map(node => node.textContent.replace(/\\s+/g, ' ').trim()),
      sideEffects: Array.from(document.querySelectorAll('.draft-side-effects li')).map(node => node.textContent.trim()),
    }))()`)
    console.log('MEDIA_DRAFT_APPLY_DIALOG ' + JSON.stringify({ ...dialog, shot: applyShot }))
    assert.match(dialog.text ?? '', /新建 \d+ 张/, `确认弹层没列新建: ${JSON.stringify(dialog)}`)
    assert.match(dialog.text ?? '', /删除 \d+ 张/, `确认弹层没列删除: ${JSON.stringify(dialog)}`)
    assert.equal(dialog.drift, expected.drift > 0, `confirmedDrift 提示与数据不一致: ${JSON.stringify({ dialog, expected })}`)
    assert.equal(dialog.danger, false, `默认不该是危险态: ${JSON.stringify(dialog)}`)
    // 绑定承接下拉（§9 keep-binding 的入口）：漂移行里要有 select，选项含自己与 splitIntoKeys。
    const keepSelect = await js(`(() => {
      const node = document.querySelector('.draft-bind select')
      return node ? { options: Array.from(node.options).map(option => option.textContent.trim()), value: node.value } : null
    })()`)
    console.log('MEDIA_DRAFT_KEEP_BINDING_UI ' + JSON.stringify(keepSelect))
    if ((dialog.binds ?? []).length) {
      assert.ok(keepSelect, `漂移行没有绑定承接下拉: ${JSON.stringify(dialog.binds)}`)
      assert.ok((keepSelect?.options ?? []).length >= 2, `绑定下拉没有可选对象: ${JSON.stringify(keepSelect)}`)
    }

    assert.ok(
      (dialog.equations ?? []).every(text => /→ \d+ \+ \d+|从 \d+ → \d+/.test(text)),
      `漂移行的文件数变化没写清: ${JSON.stringify(dialog.equations)}`,
    )
    if ((dialog.pairs ?? []).length) assert.ok((dialog.pairs ?? []).some(text => /新卡：/.test(text)), `劈卡提示没点名新卡: ${JSON.stringify(dialog.pairs)}`)
    // 绑定跟哪一半（§8.4）：劈了几行就该有几行「绑定留在…」；「绑定将从 A 移到 B」只在真的换过承接方时出现
    assert.equal((dialog.binds ?? []).length, (dialog.pairs ?? []).length, `绑定归属行数与劈卡行数不一致: ${JSON.stringify(dialog.binds)}`)
    if ((dialog.moves ?? []).length) assert.ok((dialog.moves ?? []).every(text => /绑定将从.+移到.+应用后原卡变未确认/.test(text)), `绑定搬家文案不对: ${JSON.stringify(dialog.moves)}`)
    if ((dialog.binds ?? []).length) assert.ok((dialog.binds ?? []).every(text => /绑定留在/.test(text)), `绑定归属没写清: ${JSON.stringify(dialog.binds)}`)
    await js(`Array.from(document.querySelectorAll('.draft-dialog-actions button')).find(node => node.textContent.trim() === '取消')?.click()`)

    // force 弹层：只有"未判完"时才该出现；这里直接读一遍它的入口是否存在（不触发写）。
    const forceEntry = await js(`Boolean(Array.from(document.querySelectorAll('.draft-bar button')).find(node => node.textContent.includes('强行')))`)
    console.log('MEDIA_DRAFT_FORCE ' + JSON.stringify({ forceEntryVisible: forceEntry, note: 'force 走 409 之后的弹层，不在工具栏' }))
  })
}

/**
 * 草稿编辑六接口（§9）——在**一次性临时库**上跑，跑完删源：
 * 这个库没有正式卡、没有人的决定，所以编辑/合并/拆分随便跑；keep-binding 需要"劈卡"场景，
 * 单独在 lib_anime 上一翻一还原（见步骤里的大字日志）。
 */
async function runDraftEditCheck({ js, invoke, until, step, origin }) {
  await step('draft-edit-api', async () => {
    const login = await openlistLogin()
    const created = await invoke('mediaRequest', {
      method: 'POST', path: '/api/admin/media-sources', query: null,
      body: { name: 'Edit check', internalBaseUrl: 'http://127.0.0.1:5349', publicBaseUrl: 'http://127.0.0.1:5349', username: login.username, password: login.password, libraries: [{ name: 'Edit lib', kind: 'anime', path: '/media/openlist-bdyun/Multimedia/Anime' }] },
    })
    const source = JSON.parse(created.body)
    const libraryId = source.libraries?.[0]?.id
    assert.ok(libraryId, `临时库没建起来: ${created.body?.slice(0, 200)}`)
    const draft = (method, path, body) => invoke('mediaRequest', { method, path, query: null, body: body ?? null })
    const edit = async (path, body) => {
      const reply = await draft('POST', `/api/admin/media-libraries/${encodeURIComponent(libraryId)}/draft/${path}`, body)
      return { status: reply.status, body: (() => { try { return JSON.parse(reply.body) } catch { return reply.body } })() }
    }
    let keepKey = null
    let droppedIds = []
    // scan/classify 是**管理动作**，不该和界面读共用 15s 预算：真库 1112 个文件分布在 80+ 个目录
    // ⇒ 服务端要列 80+ 次目录（每次上限 10s，`OPENLIST_REQUEST_TIMEOUT_MS`，config.ts:126）。
    // 2026-09-30 取证（同一轮：客户端两条 15003/15005ms 超时，`data/backend-rescan.log` 里
    // `SLOW_REQUEST POST …/scan 200 46530ms` 与 `… 200 31059ms`）：**服务端不会因客户端放弃而停手**，
    // 而且重发同一个 POST 会让两次扫描重叠、把两条一起拖慢 ⇒ 改成「POST 一次 + 轮询读接口直到落地」。
    const admin = async (path, label, landed) => {
      let failure = null
      try {
        const reply = await draft('POST', path)
        // 只在编辑步这一处注入：`WATCHPARTY_MEDIA_CHECK_FORCE_POLL=1` 时**假装**客户端超预算放弃
        // （POST 其实已在服务端跑完）⇒ 用来真走一遍轮询分支，而不是让它只在运气好时被动验证。
        if (process.env.WATCHPARTY_MEDIA_CHECK_FORCE_POLL === '1') throw Object.assign(new Error('注入：假装客户端超 15s 预算放弃'), { code: 'NETWORK_ERROR' })
        // 202 = 超出服务端 8s 同步宽限期（`be6528e3`）：动作还在跑，响应体里没有结果，改轮询等落地。
        if (reply?.status !== 202) return reply
        console.log('MEDIA_ADMIN_ACCEPTED ' + JSON.stringify({ label, path, note: '服务端回 202（超出 8s 同步宽限期）：改轮询等落地' }))
      } catch (error) {
        failure = error
        console.log('MEDIA_ADMIN_POLL ' + JSON.stringify({ label, path, code: error?.code ?? null, note: '管理动作没有同步落地（超预算或 202），轮询读接口直到落地；不重发 POST' }))
      }
      const startedAt = Date.now()
      const deadline = startedAt + 120_000
      let landedOk = false
      while (!landedOk && Date.now() < deadline) {
        await wait(2000)
        landedOk = await landed().catch(() => false)
      }
      if (!landedOk) throw failure ?? Object.assign(new Error(`202 之后 ${label} 一直没落地`), { code: 'MEDIA_ADMIN_NOT_LANDED' })
      console.log('MEDIA_ADMIN_POLL_OK ' + JSON.stringify({ label, waitedMs: Date.now() - startedAt }))
    }
    const readDraft = async () => JSON.parse((await draft('GET', `/api/admin/media-libraries/${encodeURIComponent(libraryId)}/classify`)).body)
    // 落地判据要比"变了多少"，不能比"有没有"（后端 09-30 提醒，我核过代码）：
    // `scan.rev` 每次成功枚举才 +1（`catalog-store.ts:1370`），重扫已有库时它本来就 >0；
    // `writeDraft` 每次都把 `classified_at` 盖成新时间戳（`:1401/:1424`），所以相等=还没落地。
    // 一次性临时库里两条恰好等价，但这条模式别在已有库上抄。
    try {
      const preScanRev = (await readDraft().catch(() => ({}))).scan?.rev ?? 0
      await admin(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/scan`, 'scan', async () => (await readDraft()).scan?.rev > preScanRev)
      const preClassifiedAt = (await readDraft().catch(() => ({}))).classifiedAt ?? null
      await admin(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/classify`, 'classify', async () => ((await readDraft()).classifiedAt ?? null) !== preClassifiedAt)
      const list = await readDraft()
      const before = list.draft.length
      assert.ok(before >= 3, `临时库的草稿太少（${before} 张），编辑用例跑不出合并/拆分`)

      // 1) 改名 → 拿回来的 card.title 要变
      const renamed = await edit('edit', { itemKey: list.draft[0].itemKey, title: 'Edit check 改名验证' })
      assert.equal(renamed.status, 200, `edit 失败: ${JSON.stringify(renamed.body).slice(0, 200)}`)
      assert.equal(renamed.body.card.title, 'Edit check 改名验证', `edit 返回的 card 没改名: ${JSON.stringify(renamed.body.card?.title)}`)
      assert.equal(renamed.body.card.confirmedBy, 'manual', `edit 之后没有置人工: ${JSON.stringify(renamed.body.card?.confirmedBy)}`)
      const reverted = await edit('unconfirm', { itemKey: list.draft[0].itemKey })
      assert.equal(reverted.status, 200, `unconfirm 失败: ${JSON.stringify(reverted.body).slice(0, 200)}`)
      assert.equal(reverted.body.card.confirmedBy, null, `unconfirm 没撤掉人工决定: ${JSON.stringify(reverted.body.card?.confirmedBy)}`)
      // 名字留着（不是打回解析名）
      assert.equal(reverted.body.card.title, 'Edit check 改名验证', `unconfirm 把名字也清了: ${JSON.stringify(reverted.body.card?.title)}`)

      // 2) 无候选时 confirm 要 400 + reason=no-candidate（临时库没判定）
      const noCand = await edit('confirm', { itemKey: list.draft[0].itemKey })
      assert.equal(noCand.status, 400, `无候选 confirm 应该 400: ${JSON.stringify(noCand).slice(0, 200)}`)
      assert.equal(noCand.body.code, 'DRAFT_EDIT_INVALID', `错误码不是 DRAFT_EDIT_INVALID: ${JSON.stringify(noCand.body?.code)}`)
      assert.equal(noCand.body.reason, 'no-candidate', `reason 不是 no-candidate: ${JSON.stringify(noCand.body?.reason)}`)

      // 3) 合并两张 → 文件并集；再把被吞那份拆回来
      keepKey = list.draft[0].itemKey
      const dropKey = list.draft[1].itemKey
      // query 必须单独传：Rust 白名单禁 `?` 出现在路径段里（塞进 path 会被 MEDIA_ROUTE_DENIED）。
      const detail = (key) => invoke('mediaRequest', { method: 'GET', path: `/api/admin/media-libraries/${encodeURIComponent(libraryId)}/classify`, query: `item=${encodeURIComponent(key)}`, body: null }).then(reply => JSON.parse(reply.body))
      const keepDetail = await detail(keepKey)
      const dropDetail = await detail(dropKey)
      droppedIds = dropDetail.children.map(child => child.mediaId)
      const merged = await edit('merge', { keepKey, dropKeys: [dropKey] })
      assert.equal(merged.status, 200, `merge 失败: ${JSON.stringify(merged.body).slice(0, 200)}`)
      assert.equal(merged.body.cards, before - 1, `merge 后卡数不对: ${merged.body.cards} vs ${before - 1}`)
      assert.equal(merged.body.card.files, keepDetail.children.length + dropDetail.children.length, `merge 后文件数不是并集: ${merged.body.card.files}`)

      // 4) **劈卡**：keep 全给 = 没有要分出去的，服务端只做规整、不报错（实测 200，
      //    守卫的 invalid 分支走不到，所以别断言 400）。真正有意义的两条是「留一个」真拆、
      //    以及形状不对时的 bad-keep-list。
      const keepOne = keepDetail.children.map(child => child.mediaId)[0]
      const realSplit = await edit('split', { itemKey: keepKey, keep: [keepOne] })
      assert.equal(realSplit.status, 200, `真的拆分失败: ${JSON.stringify(realSplit.body).slice(0, 220)}`)
      assert.ok((realSplit.body.createdKeys ?? []).length >= 1, `split 没有新卡: ${JSON.stringify(realSplit.body.createdKeys)}`)
      assert.equal(realSplit.body.card.files, 1, `拆分后原卡该只剩留下的那个文件: ${realSplit.body.card.files}`)

      // 不在这一张卡里的 id → unknown-media（带 keys）
      const bogus = await edit('split', { itemKey: keepKey, keep: ['not-a-real-media-id'] })
      assert.equal(bogus.status, 400, `不存在的 id 应该 400: ${bogus.status}`)
      assert.equal(bogus.body.reason, 'unknown-media', `错误 reason 不是 unknown-media: ${JSON.stringify(bogus.body?.reason)}`)
      assert.ok((bogus.body.keys ?? []).length >= 1, `unknown-media 没带 keys: ${JSON.stringify(bogus.body?.keys)}`)

      // 形状不对（空数组）→ bad-keep-list（这道守卫在 service 层，先于归属校验）
      const badList = await edit('split', { itemKey: keepKey, keep: [] })
      assert.equal(badList.status, 400, `空 keep 应该 400: ${badList.status}`)
      assert.equal(badList.body.reason, 'bad-keep-list', `错误 reason 不是 bad-keep-list: ${JSON.stringify(badList.body?.reason)}`)

      // 4) merge 冲突：给另一张挂上人工决定再合 → DRAFT_EDIT_CONFLICT + keys
      // （不依赖上面 split 的结果：split 被后端守卫挡着时 dropKey 已经并进 keepKey 了）
      const conflictKey = list.draft[2].itemKey
      await edit('edit', { itemKey: conflictKey, title: '冲突验证' })
      const conflict = await edit('merge', { keepKey, dropKeys: [conflictKey] })
      assert.equal(conflict.status, 400, `带人工决定的合并应该 400: ${JSON.stringify(conflict).slice(0, 200)}`)
      assert.equal(conflict.body.code, 'DRAFT_EDIT_CONFLICT', `错误码不是 DRAFT_EDIT_CONFLICT: ${JSON.stringify(conflict.body?.code)}`)
      assert.ok((conflict.body.keys ?? []).length >= 1, `冲突没带 keys: ${JSON.stringify(conflict.body?.keys)}`)
      await edit('unconfirm', { itemKey: keepKey })

      // 5) 不存在的卡 → 404
      const missing = await edit('edit', { itemKey: '/definitely-not-a-card', title: 'x' })
      assert.equal(missing.status, 404, `不存在的卡应该 404: ${missing.status}`)
      assert.equal(missing.body.code, 'DRAFT_CARD_NOT_FOUND', `错误码不是 DRAFT_CARD_NOT_FOUND: ${JSON.stringify(missing.body?.code)}`)

      console.log('MEDIA_DRAFT_EDIT_API ' + JSON.stringify({ library: libraryId, cards: before, mergedFiles: merged.body.card.files, createdKeys: realSplit.body.createdKeys?.length, noCandidate: noCand.body.reason, conflictKeys: conflict.body.keys?.length, splitReasons: [bogus.body.reason, badList.body.reason] }))
    } finally {
      await invoke('mediaRequest', { method: 'DELETE', path: `/api/admin/media-sources/${encodeURIComponent(source.id)}`, query: null, body: null })
      console.log('MEDIA_DRAFT_EDIT_CLEANUP ' + JSON.stringify({ source: source.id, note: '临时源已删；后端说删库会级联清草稿/快照' }))
    }

    // 6) keep-binding：需要"劈卡"场景，只在 lib_anime 上翻一下再翻回来（一翻一还原，日志留痕）
    // 已知客户端传输偶发（2026-09-29 取证：8 次跑里 4 次落在"临时源 DELETE 之后的第一条请求"，
    // 15s 超时档；用 curl 量同一序列是 0.1s ⇒ 不是服务端慢，疑似连接池复用竞态，在 `src-tauri/http.rs`）。
    // 只对这一条重试一次，并大声打日志——别让它看起来像"绿了"。
    let anime = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        anime = JSON.parse((await invoke('mediaRequest', { method: 'GET', path: '/api/admin/media-libraries/lib_anime/classify', query: null, body: null })).body)
        if (attempt > 0) console.log('MEDIA_DRAFT_EDIT_RETRY_OK ' + JSON.stringify({ attempt, note: '删除临时源后的第一条 GET 偶发 15s 超时（客户端传输层），重试一次即过' }))
        break
      } catch (error) {
        if (attempt === 1) throw error
        console.log('MEDIA_DRAFT_EDIT_RETRY ' + JSON.stringify({ code: error?.code ?? null, note: '第一次失败，重试；真因见脚本头与该行日志' }))
        await wait(500)
      }
    }
    const driftRow = (anime.diff?.confirmedDrift ?? []).find(row => (row.splitIntoKeys ?? []).length > 0)
    // 2026-09-28 后端修过复位语义（`keepsBindingOnKey === itemKey` = 不搬/复位，200），
    // 所以这里可以真翻一次再翻回来；两边都断言，跑完库里 carries_key 必须回到原样。
    if (driftRow && (driftRow.splitIntoKeys ?? []).length > 0) {
      const carrierKey = driftRow.splitIntoKeys[0]
      // 这一段的 edit 是 lib_anime 的，不能借上面临时库那个闭包（它把 libraryId 焊死了）。
      const animeEdit = async (path, body) => {
        const reply = await invoke('mediaRequest', { method: 'POST', path: `/api/admin/media-libraries/lib_anime/draft/${path}`, query: null, body })
        return { status: reply.status, body: (() => { try { return JSON.parse(reply.body) } catch { return reply.body } })() }
      }
      const animeCard = async (key) => JSON.parse((await invoke('mediaRequest', { method: 'GET', path: '/api/admin/media-libraries/lib_anime/classify', query: `item=${encodeURIComponent(key)}`, body: null })).body)
      const carryBefore = (await animeCard(driftRow.itemKey)).card?.carriesKey ?? null

      const moved = await animeEdit('keep-binding', { itemKey: driftRow.itemKey, keepsBindingOnKey: carrierKey })
      assert.equal(moved.status, 200, `承接方切换失败: ${JSON.stringify(moved.body).slice(0, 220)}`)
      const afterMove = await animeCard(driftRow.itemKey)
      assert.equal(afterMove.card?.carriesKey ?? null, carrierKey, `切换后 carriesKey 没落到承接方: ${JSON.stringify(afterMove.card?.carriesKey)}`)

      // 复位：指回自己 = 不搬（这才是 UI 下拉切回默认项要走的路）。
      const reset = await animeEdit('keep-binding', { itemKey: driftRow.itemKey, keepsBindingOnKey: driftRow.itemKey })
      assert.equal(reset.status, 200, `复位（指回自己）被拒: ${reset.status} ${JSON.stringify(reset.body).slice(0, 220)}`)
      const afterReset = await animeCard(driftRow.itemKey)
      assert.equal(afterReset.card?.carriesKey ?? null, carryBefore, `复位后 carriesKey 没还原（跑前 ${JSON.stringify(carryBefore)}）: ${JSON.stringify(afterReset.card?.carriesKey)}`)

      console.log('MEDIA_DRAFT_KEEP_BINDING_API ' + JSON.stringify({
        library: 'lib_anime', row: driftRow.itemKey.slice(0, 60), carrier: carrierKey.slice(0, 60),
        carryBefore, carryAfterMove: afterMove.card?.carriesKey ?? null, carryAfterReset: afterReset.card?.carriesKey ?? null,
        splitInto: (driftRow.splitIntoKeys ?? []).length,
      }))
    } else {
      console.log('MEDIA_DRAFT_KEEP_BINDING_API ' + JSON.stringify({ skipped: true, reason: 'lib_anime 没有带 splitIntoKeys 的漂移行（库状态变了）', driftWithSplit: (anime.diff?.confirmedDrift ?? []).filter(row => (row.splitIntoKeys ?? []).length > 0).length }))
    }

    // 7) 正式卡详情的 itemKey（§9 新字段）：拿一张已确认的卡核对
    const detailReply = await invoke('mediaRequest', { method: 'GET', path: '/api/media/catalog/cat_61nxTrnRDIMS', query: null, body: null })
    const detailCard = JSON.parse(detailReply.body)
    console.log('MEDIA_CATALOG_ITEMKEY ' + JSON.stringify({ title: detailCard.title, itemKey: detailCard.itemKey?.slice(0, 60) ?? null }))
    assert.ok(detailCard.itemKey, `正式卡详情没有 itemKey: ${JSON.stringify(Object.keys(detailCard).slice(0, 12))}`)
  })
}

/**
 * 批准门（§10.1/§11.1）真走查——在**一次性临时库**上造结构差，跑完整的
 * `409 → /approval → /apply-approved → 200 → 重放被拒 → 台账 → 批准撤回 → /rollback`。
 * 真库现在结构差恒为 0（裸 /apply 直接 200），所以这里不碰任何真库。
 *
 * **默认不跑**：这条会写 `catalog_approvals`（每跑一次 2 行台账 + 一份 undo，临时库整本草稿
 * 60 张 ⇒ ≈667KB；台账行永久留着、undo 靠全局 pruneExpiredUndo 回收），和 titles-edit 的写半步
 * 同一把闸——要验就开 `WATCHPARTY_MEDIA_CHECK_REVIEW=1`。
 */
async function runDraftApprovalCheck({ invoke, step }) {
  await step('draft-approval-api', async () => {
    if (process.env.WATCHPARTY_MEDIA_CHECK_REVIEW !== '1') {
      console.log('MEDIA_DRAFT_APPROVAL_API_SKIPPED ' + JSON.stringify({ reason: '这条会往活库的 catalog_approvals 写台账行与 undo，开 WATCHPARTY_MEDIA_CHECK_REVIEW=1 才跑', wouldRun: '409→/approval→/apply-approved→重放被拒→台账→批准撤回→/rollback' }))
      return
    }
    const login = await openlistLogin()
    const created = await invoke('mediaRequest', {
      method: 'POST', path: '/api/admin/media-sources', query: null,
      body: { name: 'Approval check', internalBaseUrl: 'http://127.0.0.1:5349', publicBaseUrl: 'http://127.0.0.1:5349', username: login.username, password: login.password, libraries: [{ name: 'Approval lib', kind: 'anime', path: '/media/openlist-bdyun/Multimedia/Anime' }] },
    })
    const source = JSON.parse(created.body)
    const libraryId = source.libraries?.[0]?.id
    assert.ok(libraryId, `审批临时库没建起来: ${created.body?.slice(0, 200)}`)
    // `?force=1` 必须走 query：Rust 白名单禁 `?` 出现在路径段里（塞进 path 会被 MEDIA_ROUTE_DENIED）。
    const call = async (method, path, body, query = null) => {
      const reply = await invoke('mediaRequest', { method, path, query, body: body ?? null })
      return { status: reply.status, body: (() => { try { return JSON.parse(reply.body) } catch { return reply.body } })() }
    }
    const base = `/api/admin/media-libraries/${encodeURIComponent(libraryId)}`
    // 同上：临时库的 scan 也是 80+ 次列目录，管理动作超预算（或服务端回 202）就轮询落地（不重发 POST）。
    const admin = async (path, label, landed) => {
      let failure = null
      try {
        const reply = await call('POST', path)
        if (reply?.status !== 202) return reply
        console.log('MEDIA_ADMIN_ACCEPTED ' + JSON.stringify({ label, path, note: '服务端回 202（超出 8s 同步宽限期）：改轮询等落地' }))
      } catch (error) {
        failure = error
        console.log('MEDIA_ADMIN_POLL ' + JSON.stringify({ label, path, code: error?.code ?? null, note: '管理动作没有同步落地（超预算或 202），轮询读接口直到落地；不重发 POST' }))
      }
      const startedAt = Date.now()
      const deadline = startedAt + 120_000
      let landedOk = false
      while (!landedOk && Date.now() < deadline) {
        await wait(2000)
        landedOk = await landed().catch(() => false)
      }
      if (!landedOk) throw failure ?? Object.assign(new Error(`202 之后 ${label} 一直没落地`), { code: 'MEDIA_ADMIN_NOT_LANDED' })
      console.log('MEDIA_ADMIN_POLL_OK ' + JSON.stringify({ label, waitedMs: Date.now() - startedAt }))
    }
    const readDraft = async () => (await call('GET', `${base}/classify`)).body
    try {
      // 落地判据同编辑步：比"变了"而不是比"有没有"（重扫已有库时 rev 本来就 >0）。
      const preScanRev = (await readDraft().catch(() => ({}))).scan?.rev ?? 0
      await admin(`${base}/scan`, 'scan', async () => (await readDraft()).scan?.rev > preScanRev)
      const preClassifiedAt = (await readDraft().catch(() => ({}))).classifiedAt ?? null
      await admin(`${base}/classify`, 'classify', async () => ((await readDraft()).classifiedAt ?? null) !== preClassifiedAt)
      const caps = await call('GET', '/api/media/capabilities')
      assert.ok(['secret', 'loopback-admin'].includes(caps.body?.catalogApproval), `能力位没报批准边界: ${JSON.stringify(caps.body)}`)

      // ① 裸 /apply：这个库还没判定 ⇒ 闸的顺序里 DRAFT_INCOMPLETE 先说话（不是批准门）。
      const incomplete = await call('POST', `${base}/apply`)
      assert.equal(incomplete.status, 409, `没判完的库应该 409: ${JSON.stringify(incomplete).slice(0, 200)}`)
      assert.equal(incomplete.body.code, 'CATALOG_DRAFT_INCOMPLETE', `闸的顺序变了（先撞的不是 INCOMPLETE）: ${JSON.stringify(incomplete.body?.code)}`)

      // ② force 之后撞批准门：409 必须带**当前** structural（没有任何 diff 字段）。
      const required = await call('POST', `${base}/apply`, undefined, 'force=1')
      assert.equal(required.status, 409, `结构差没触发批准门: ${JSON.stringify(required).slice(0, 240)}`)
      assert.equal(required.body.code, 'CATALOG_APPROVAL_REQUIRED', `错误码不是 APPROVAL_REQUIRED: ${JSON.stringify(required.body?.code)}`)
      const structural = required.body.structural
      assert.ok(structural && Array.isArray(structural.added) && Array.isArray(structural.dropped) && Array.isArray(structural.moved) && Array.isArray(structural.drift), `409 的 structural 形状不对: ${JSON.stringify(structural)}`)
      assert.ok(structural.added.length > 0, `新建库应该有 added: ${JSON.stringify(structural)}`)
      assert.equal(required.body.diff, undefined, `409 里不该有 diff（界面要另读一次 classify）: ${JSON.stringify(Object.keys(required.body))}`)

      // ③ 签发 → 立刻应用（force 跟着走）→ 200。
      const issued = await call('POST', `${base}/approval`, { approvedBy: '桌面端' })
      assert.equal(issued.status, 200, `签发失败: ${JSON.stringify(issued.body).slice(0, 240)}`)
      assert.ok(issued.body.approvalToken, '签发没回 token')
      assert.ok(issued.body.approvalId, '签发没回台账 id')
      const applied = await call('POST', `${base}/apply-approved`, { approvalToken: issued.body.approvalToken, force: true })
      assert.equal(applied.status, 200, `带凭证应用失败: ${JSON.stringify(applied.body).slice(0, 240)}`)
      assert.equal(applied.body.rollbackAvailable, true, `结构应用后应当可撤回: ${JSON.stringify(applied.body?.rollbackAvailable)}`)

      // ④ 重放同一张凭证：先消费后执行 ⇒ 409 used（不是 unknown/expired）。
      const replay = await call('POST', `${base}/apply-approved`, { approvalToken: issued.body.approvalToken, force: true })
      assert.equal(replay.status, 409, `重放没有被拒: ${JSON.stringify(replay).slice(0, 200)}`)
      assert.equal(replay.body.code, 'CATALOG_APPROVAL_INVALID', `重放错误码不对: ${JSON.stringify(replay.body?.code)}`)
      assert.equal(replay.body.reason, 'used', `重放的 reason 不是 used: ${JSON.stringify(replay.body?.reason)}`)

      // ⑤ 台账：能撤的那行必须 rollbackAvailable=true，且带 keys/counts（不含 token/哈希）。
      const ledger = await call('GET', `${base}/approvals`)
      assert.equal(ledger.status, 200, `台账读不到: ${JSON.stringify(ledger).slice(0, 160)}`)
      assert.ok(Array.isArray(ledger.body.items), `items 必须是数组: ${JSON.stringify(ledger.body?.items)}`)
      const row = ledger.body.items.find(item => item.approvalId === issued.body.approvalId)
      assert.ok(row, '台账里找不到刚签发的那行')
      assert.equal(row.rollbackAvailable, true, `台账说这次不能撤: ${JSON.stringify(row)}`)
      assert.ok((row.keys ?? []).length > 0, `可撤的行没带 keys: ${JSON.stringify(row)}`)
      assert.equal('approvalToken' in row || 'tokenHash' in row, false, `台账泄漏了凭证字段: ${JSON.stringify(Object.keys(row))}`)

      // ⑥ 撤回也要再批一次：/approval{rollbackOf} 回 rollback（不是 structural）→ /rollback。
      const approveRollback = await call('POST', `${base}/approval`, { approvedBy: '桌面端', rollbackOf: issued.body.approvalId })
      assert.equal(approveRollback.status, 200, `撤回批准失败: ${JSON.stringify(approveRollback.body).slice(0, 240)}`)
      assert.ok(approveRollback.body.rollback, `撤回批准没回 rollback: ${JSON.stringify(Object.keys(approveRollback.body ?? {}))}`)
      assert.equal(approveRollback.body.structural, undefined, `撤回批准不该回 structural（两者互斥）: ${JSON.stringify(Object.keys(approveRollback.body ?? {}))}`)
      const rolled = await call('POST', `${base}/rollback`, { rollbackOf: issued.body.approvalId, approvalToken: approveRollback.body.approvalToken })
      assert.equal(rolled.status, 200, `撤回失败: ${JSON.stringify(rolled.body).slice(0, 240)}`)
      assert.ok(rolled.body.keys.length > 0, `撤回没报涉及哪些卡: ${JSON.stringify(rolled.body)}`)

      // ⑦ 撤完：台账那行变成"撤过"，再批准同一次 → ALREADY_DONE（不是 INVALID）。
      const after = await call('GET', `${base}/approvals`)
      const rowAfter = (after.body.items ?? []).find(item => item.approvalId === issued.body.approvalId)
      assert.equal(rowAfter?.rollbackAvailable, false, `撤过之后还能撤: ${JSON.stringify(rowAfter)}`)
      assert.ok(rowAfter?.rolledBackAt, `撤过之后没有 rolledBackAt: ${JSON.stringify(rowAfter)}`)
      const again = await call('POST', `${base}/approval`, { approvedBy: '桌面端', rollbackOf: issued.body.approvalId })
      assert.equal(again.status, 409, `第二次撤回批准没被拒: ${JSON.stringify(again).slice(0, 200)}`)
      assert.equal(again.body.code, 'CATALOG_ROLLBACK_ALREADY_DONE', `第二次撤回的错误码不对: ${JSON.stringify(again.body?.code)}`)

      // ⑧ 撤完之后结构差异回到原样（卡都撤掉了 ⇒ added 又等于整份草稿）。
      const diffAfter = await call('GET', `${base}/classify`)
      assert.ok((diffAfter.body.diff?.added ?? []).length >= structural.added.length, `撤回后结构没回到原样: ${JSON.stringify(diffAfter.body.diff?.added?.length)}`)

      console.log('MEDIA_DRAFT_APPROVAL_API ' + JSON.stringify({
        library: libraryId, approvalMode: caps.body.catalogApproval,
        structural: { added: structural.added.length, dropped: structural.dropped.length, moved: structural.moved.length, drift: structural.drift.length },
        applied: { created: applied.body.created, rollbackAvailable: applied.body.rollbackAvailable },
        replay: replay.body.reason, ledgerKeys: row.keys.length, rollback: { restored: rolled.body.restored, removed: rolled.body.removed, keys: rolled.body.keys.length },
        afterRollbackAdded: diffAfter.body.diff?.added?.length ?? null,
      }))
    } finally {
      await invoke('mediaRequest', { method: 'DELETE', path: `/api/admin/media-sources/${encodeURIComponent(source.id)}`, query: null, body: null })
      console.log('MEDIA_DRAFT_APPROVAL_CLEANUP ' + JSON.stringify({ source: source.id, note: '临时源已删（连同这次应用出来的正式卡）' }))
    }
  })
}

/** 只删本 harness 用例会建的源名，绝不碰用户自己的源。 */
async function purgeTestSources(invoke) {
  const list = await invoke('mediaRequest', { method: 'GET', path: '/api/admin/media-sources', query: null, body: null })
  const sources = (() => { try { return JSON.parse(list.body).sources ?? [] } catch { return [] } })()
  const junk = sources.filter(source => ['Isolation check', 'Second check', 'Dead check', 'Approval check', 'Edit check'].includes(source.name))
  for (const source of junk) {
    await invoke('mediaRequest', { method: 'DELETE', path: `/api/admin/media-sources/${source.id}`, query: null, body: null })
  }
  if (junk.length) console.log('MEDIA_TEST_SOURCE_PURGE ' + JSON.stringify(junk.map(source => source.name)))
}

/** P1-3：加源表单。admin 门 → 一次提交 → 码到中文的映射 → 成功后库切换器刷新。 */
async function runSourceFormCheck({ window, js, invoke, until, step }) {
  const fill = (label, value) => js(`(() => {
    const el = document.querySelector('input[aria-label=${JSON.stringify(label)}]')
    if (!el) throw new Error('missing field ' + ${JSON.stringify(label)})
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  const chips = () => js(`document.querySelectorAll('.media-lib-chip').length`)
  const formText = () => js(`document.querySelector('.fluent-settings-content form [role="status"], .fluent-settings-content [role="status"]')?.textContent?.trim() ?? null`)
  // 2026-09-28 起加源表单在「设置 · 媒体库」：先从媒体页走到设置里，再回到媒体页。
  const openSettingsMedia = async () => {
    await js(`Array.from(document.querySelectorAll('button[aria-label="设置"]'))[0]?.click()`)
    await until(() => js(`Boolean(document.querySelector('.fluent-settings-nav'))`), 'settings nav', 15000)
    const tabs = await js(`Array.from(document.querySelectorAll('.fluent-settings-nav [role="tab"]')).map(node => node.textContent.trim())`)
    console.log('MEDIA_SETTINGS_TABS ' + JSON.stringify(tabs))
    await js(`(() => { const tab = Array.from(document.querySelectorAll('.fluent-settings-nav [role="tab"]')).find(node => node.textContent.includes('媒体库')); if (tab) tab.click(); return Boolean(tab) })()`)
    await wait(600)
    const panel = await js(`(() => ({
      rows: document.querySelectorAll('.media-source-list li').length,
      form: Boolean(document.querySelector('input[aria-label="源名称"]')),
      text: (document.querySelector('.fluent-settings-content')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 160),
    }))()`)
    console.log('MEDIA_SETTINGS_PANEL ' + JSON.stringify(panel))
    await until(() => js(`Boolean(document.querySelector('.fluent-settings-content .media-source-list, .fluent-settings-content input[aria-label="源名称"]'))`), 'media settings panel', 15000)
  }
  const backToMedia = async () => {
    // 底部的会话条在所有壳页面都在：点「返回当前会话」直接回播放页，再进媒体库。
    await until(() => js(`Array.from(document.querySelectorAll('.desktop-session-bar button')).some(node => node.textContent.trim() === '返回当前会话')`), 'session bar return', 20000)
    await js(`Array.from(document.querySelectorAll('.desktop-session-bar button')).find(node => node.textContent.trim() === '返回当前会话')?.click()`)
    await until(() => js(`Boolean(document.querySelector('button[aria-label="添加媒体"]'))`), 'room media button again', 20000)
    await js(`document.querySelector('button[aria-label="添加媒体"]').click()`)
    await until(() => js(`Boolean(document.querySelector('.media-lib-chip'))`), 'media page again', 20000)
  }
  const sourceRows = () => js(`Array.from(document.querySelectorAll('.media-source-list li')).map(node => node.textContent.replace(/\\s+/g, ' ').trim())`)
  // 进设置之前先把媒体页的库 chip 数记下来（设置里没有 .media-lib-chip）。
  const chipsBefore = await chips()

  await step('form-open', async () => {
    await openSettingsMedia()
    if (process.env.WATCHPARTY_MEDIA_CHECK_APPROVAL_FILE) {
      await until(() => js(`document.querySelector('.fluent-settings-content')?.textContent.includes('已配置 · ••••••••')`), 'approval mask in settings', 15000)
      const inputType = await js(`(() => {
        Array.from(document.querySelectorAll('.fluent-settings-content button')).find(node => node.textContent.includes('替换密钥'))?.click()
        return true
      })()`)
      assert.ok(inputType)
      await until(() => js(`Boolean(document.querySelector('input[autocomplete="new-password"]'))`), 'approval secret input')
      assert.equal(await js(`document.querySelector('input[autocomplete="new-password"]').type`), 'password')
      const config = JSON.parse(await readFile(process.env.WATCHPARTY_MEDIA_CHECK_APPROVAL_FILE, 'utf8'))
      await js(`(() => {
        const input = document.querySelector('input[autocomplete="new-password"]')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(config.secret)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await until(() => js(`Array.from(document.querySelectorAll('.fluent-settings-content button')).some(node => node.textContent.trim() === '保存' && !node.disabled)`), 'approval save enabled')
      await js(`(() => { Array.from(document.querySelectorAll('.fluent-settings-content button')).find(node => node.textContent.trim() === '保存')?.click(); return true })()`)
      await until(() => js(`!document.querySelector('input[autocomplete="new-password"]')`), 'approval input cleared after save')
      const shot = join(tmpdir(), 'watchparty-media-check', 'approval-secret-settings.png')
      await wait(300)
      await writeFile(shot, (await window.webContents.capturePage()).toPNG())
      console.log('MEDIA_APPROVAL_SECRET_SETTINGS ' + JSON.stringify({ masked: true, passwordInput: true, clearedAfterSave: true, shot }))
    }
    const before = await sourceRows()
    const visible = await js(`(() => {
      const button = Array.from(document.querySelectorAll('.fluent-settings-content button')).find(node => node.textContent.trim() === '添加媒体源')
      if (!button) return 0
      button.click()
      return 1
    })()`)
    assert.equal(visible, 1, '设置里没有 添加媒体源 按钮（capabilities.mediaAdmin 是 false？）')
    await until(() => js(`Boolean(document.querySelector('input[aria-label="源密码"]'))`), 'source password field')
    const shape = await js(`(() => ({
      passwordType: document.querySelector('input[aria-label="源密码"]').type,
      autocomplete: document.querySelector('input[aria-label="源密码"]').getAttribute('autocomplete'),
      rowFields: ['库名称', '库路径'].every(label => Boolean(document.querySelector('input[aria-label="' + label + '"]'))),
    }))()`)
    assert.equal(shape.passwordType, 'password', `源密码输入框不是 password 型: ${JSON.stringify(shape)}`)
    assert.equal(shape.rowFields, true, `库行字段缺失: ${JSON.stringify(shape)}`)
    const shot = join(tmpdir(), 'watchparty-media-check', 'media-source-form.png')
    await mkdir(join(tmpdir(), 'watchparty-media-check'), { recursive: true })
    // capturePage 取的是已合成的帧：表单刚挂上就截会拿到上一帧。
    await wait(400)
    await writeFile(shot, (await window.webContents.capturePage()).toPNG())
    return { before, shape, shot }
  })

  await step('form-reject', async () => {
    const before = await sourceRows()
    await fill('源名称', 'Dead check')
    await fill('内网地址', 'http://127.0.0.1:1')
    await fill('库名称', 'Dead')
    await fill('库路径', '/')
    await until(() => js(`(() => { const b = Array.from(document.querySelectorAll('.fluent-settings-content button')).find(n => n.textContent.trim() === '保存源'); return Boolean(b && !b.disabled) })()`), 'save enabled')
    await js(`Array.from(document.querySelectorAll('.fluent-settings-content button')).find(node => node.textContent.trim() === '保存源').click()`)
    await until(async () => (await formText()) !== null, 'source save error text', 20000)
    const text = await formText()
    const after = await sourceRows()
    // 密码在请求落定后必须离开组件状态。
    const cleared = await js(`document.querySelector('input[aria-label="源密码"]').value === ''`)
    const evidence = { text, before, after, passwordCleared: cleared }
    console.log('MEDIA_SOURCE_FORM_REJECT ' + JSON.stringify(evidence))
    assert.match(text, /连不上这个源/, `拒绝文案不是源健康码的映射: ${JSON.stringify(evidence)}`)
    assert.deepEqual(after, before, `被拒的源却改了库列表: ${JSON.stringify(evidence)}`)
    assert.equal(cleared, true, `请求落定后密码还留在表单里: ${JSON.stringify(evidence)}`)
  })

  await step('form-create', async () => {
    const before = chipsBefore
    const login = await openlistLogin()
    assert.ok(login.username, '仓库根 .env 里没有 OPENLIST_USERNAME，加源用例拿不到凭据')
    await fill('源名称', 'Second check')
    await fill('内网地址', 'http://127.0.0.1:5349')
    await fill('外网地址', 'http://127.0.0.1:5349')
    await fill('源用户名', login.username)
    await fill('源密码', login.password)
    await fill('库名称', 'Film copy')
    await fill('库路径', '/media/openlist-bdyun/Multimedia/Film')
    await js(`Array.from(document.querySelectorAll('.fluent-settings-content button')).find(node => node.textContent.trim() === '保存源').click()`)
    await until(() => js(`document.body.innerText.includes('已添加')`), 'create confirmation', 25000)
    await until(() => js(`Array.from(document.querySelectorAll('.media-source-list li')).some(node => node.textContent.includes('Second check'))`), 'new source in the settings list', 15000)
    const added = await js(`document.body.innerText.split(String.fromCharCode(10)).find(line => line.includes('已添加')) ?? null`)
    // 设置里加完源要回媒体页验证：切换器多一个 chip，新库（没刮过标题）切到「文件」能看到卡片。
    await backToMedia()
    await until(async () => (await chips()) > before, 'new library chip', 25000)
    // 设置里加源不再替房间切库（两处状态各自独立），所以要自己点一下新库的 chip。
    await js(`Array.from(document.querySelectorAll('.media-lib-chip')).find(node => node.textContent.includes('Film copy'))?.click()`)
    await until(() => js(`Array.from(document.querySelectorAll('.media-lib-chip')).some(node => node.textContent.includes('Film copy') && node.getAttribute('aria-pressed') === 'true')`), 'new library selected', 20000)
    // 新库的标题库是空的（没刮过），默认「点播」会显示空态 —— 这是设计的样子；要验可浏览就切到「文件」。
    const switched = await js(`(() => {
      const seg = Array.from(document.querySelectorAll('.seg-item')).find(node => node.textContent.trim() === '文件')
      if (!seg) return { clicked: false, segs: Array.from(document.querySelectorAll('.seg-item')).map(node => node.textContent.trim()), chips: document.querySelectorAll('.media-lib-chip').length }
      seg.click()
      return { clicked: true }
    })()`)
    console.log('MEDIA_CREATE_SWITCH ' + JSON.stringify(switched))
    await until(() => js(`document.querySelectorAll('.media-card').length > 0`), 'cards of the new library', 25000)
    const state = await js(`(() => ({
      chips: Array.from(document.querySelectorAll('.media-lib-chip')).map(node => node.textContent.trim()),
      selected: Array.from(document.querySelectorAll('.media-lib-chip')).filter(node => node.getAttribute('aria-pressed') === 'true').map(node => node.textContent.trim()),
      message: ${JSON.stringify(added)},
      cards: document.querySelectorAll('.media-card').length,
      formGone: !document.querySelector('input[aria-label="源密码"]'),
    }))()`)
    console.log('MEDIA_SOURCE_FORM_CREATE ' + JSON.stringify({ before, ...state }))
    assert.match(state.message ?? '', /已添加/, `加源没成功：${JSON.stringify(state)}`)
    assert.ok(state.selected.some(text => text.includes('Film copy')), `新库没有被切到前面: ${JSON.stringify(state)}`)
    assert.equal(state.chips.length, before + 1, `新源没有进切换器: ${JSON.stringify(state)}`)
    assert.equal(state.selected.length, 1, `新源保存后没有唯一选中项: ${JSON.stringify(state)}`)
    assert.equal(state.formGone, true, `保存成功后表单没有收起: ${JSON.stringify(state)}`)
    assert.ok(state.cards > 0, `新库没有渲染卡片: ${JSON.stringify(state)}`)
  })

  await step('draft-states', async () => {
    await openSettingsMedia()
      // ==== ⑤ 空态 + ④ force 危险态：拿上面刚建的临时库（Film copy，从没扫过）走一遍真路径 ====
      const dir = join(tmpdir(), 'watchparty-media-check')
      await mkdir(dir, { recursive: true })
      // 面板是 form-open 时挂的，那会儿临时源还没建 ⇒ 切走再切回来让它重新拉一次库列表。
      await js(`(() => { const tab = Array.from(document.querySelectorAll('.fluent-settings-nav [role="tab"]')).find(node => node.textContent.includes('基础')); tab?.click(); return Boolean(tab) })()`)
      await wait(300)
      await js(`(() => { const tab = Array.from(document.querySelectorAll('.fluent-settings-nav [role="tab"]')).find(node => node.textContent.includes('媒体库')); tab?.click(); return Boolean(tab) })()`)
      await until(() => js(`Array.from(document.querySelectorAll('.draft-lib-chip')).some(node => node.textContent.includes('Film copy'))`), 'temp library in the picker', 20000)
      const picked = await js(`(() => {
        const chip = Array.from(document.querySelectorAll('.draft-lib-chip')).find(node => node.textContent.includes('Film copy'))
        if (!chip) return null
        chip.click()
        return chip.textContent.trim()
      })()`)
      if (!picked) {
        console.log('MEDIA_DRAFT_STATES_SKIPPED ' + JSON.stringify({ reason: '这一轮没有临时库（加源用例没跑或已清理）' }))
      } else {
        await until(() => js(`Boolean(document.querySelector('.draft-empty'))`), 'draft empty state', 25000)
        const emptyShot = join(dir, 'catalog-draft-empty.png')
        await wait(300)
        await writeFile(emptyShot, (await window.webContents.capturePage()).toPNG())
        const empty = await js(`(() => ({
          text: document.querySelector('.draft-empty')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 160) ?? null,
          steps: document.querySelectorAll('.draft-empty-steps li').length,
          action: Array.from(document.querySelectorAll('.draft-empty button')).map(node => node.textContent.trim()),
        }))()`)
        console.log('MEDIA_DRAFT_EMPTY_STATE ' + JSON.stringify({ library: picked, ...empty, shot: emptyShot }))
        assert.equal(empty.steps, 4, `空态没写清四步链路: ${JSON.stringify(empty)}`)
        assert.ok((empty.action ?? []).some(text => text.includes('开始扫描')), `空态没有起步按钮: ${JSON.stringify(empty)}`)

        // 扫描 + 分类（只写草稿）：这一张新库会停在"全部未判定"，正好是部分判定的中间态。
        await js(`Array.from(document.querySelectorAll('.draft-empty button')).find(node => node.textContent.includes('开始扫描'))?.click()`)
        await until(() => js(`document.querySelectorAll('.draft-table tbody tr.draft-row').length > 0`), 'fresh draft rows', 150000)
        await wait(400)
        const partial = await js(`(() => ({
          rows: document.querySelectorAll('.draft-table tbody tr.draft-row').length,
          progress: document.querySelector('.draft-progress-meta')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
          apply: Array.from(document.querySelectorAll('.draft-bar button')).map(node => node.textContent.trim()).find(text => text.includes('应用')) ?? null,
        }))()`)
        const partialShot = join(dir, 'catalog-draft-partial.png')
        await writeFile(partialShot, (await window.webContents.capturePage()).toPNG())
        console.log('MEDIA_DRAFT_PARTIAL ' + JSON.stringify({ library: picked, ...partial, shot: partialShot }))
        assert.match(partial.progress ?? '', /还剩 \d+ 张未判定/, `新库没有未判定进度: ${JSON.stringify(partial)}`)

        // 应用 → 服务端 409 CATALOG_DRAFT_INCOMPLETE → 弹层自动切到危险态，pending 取自响应体。
        await js(`Array.from(document.querySelectorAll('.draft-bar button')).find(node => node.textContent.includes('应用草稿'))?.click()`)
        await until(() => js(`Boolean(document.querySelector('.draft-dialog:not(.danger)'))`), 'plain apply dialog', 15000)
        await js(`Array.from(document.querySelectorAll('.draft-dialog-actions button')).find(node => node.textContent.includes('应用'))?.click()`)
        await until(() => js(`Boolean(document.querySelector('.draft-dialog.danger'))`), 'force dialog after 409', 30000)
        await wait(300)
        const forceShot = join(dir, 'catalog-draft-force.png')
        await writeFile(forceShot, (await window.webContents.capturePage()).toPNG())
        const force = await js(`(() => ({
          text: document.querySelector('.draft-dialog.danger')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 260) ?? null,
          buttons: Array.from(document.querySelectorAll('.draft-dialog.danger .draft-dialog-actions button')).map(node => node.textContent.trim()),
        }))()`)
        console.log('MEDIA_DRAFT_FORCE_409 ' + JSON.stringify({ ...force, shot: forceShot }))
        assert.match(force.text ?? '', /还有 \d+ 张没判定/, `409 弹层没写清未判定数: ${JSON.stringify(force)}`)
        assert.match(force.text ?? '', /候选列表会被清空/, `force 弹层没写代价: ${JSON.stringify(force)}`)
        assert.match(force.text ?? '', /已经确认的绑定不会丢/, `force 弹层没写保护: ${JSON.stringify(force)}`)
        assert.ok(force.buttons.some(text => text.includes('仍然应用')), `force 弹层缺危险按钮: ${JSON.stringify(force)}`)

        // ==== ⑥ 批准单：点「仍然应用（危险）」→ 服务端 409 APPROVAL_REQUIRED → 原地换成批准单 ====
        // 默认不跑：这一步会真应用（写正式卡 + 台账 + undo），和 titles-edit 的写半步同一把闸。
        if (process.env.WATCHPARTY_MEDIA_CHECK_REVIEW !== '1') {
          console.log('MEDIA_DRAFT_APPROVAL_UI_SKIPPED ' + JSON.stringify({ reason: '批准并应用会写正式卡与 catalog_approvals，开 WATCHPARTY_MEDIA_CHECK_REVIEW=1 才跑', wouldRun: '批准单截图/断言→批准并应用→撤回行→撤回单→撤回完成' }))
          await js(`Array.from(document.querySelectorAll('.draft-dialog-actions button')).find(node => node.textContent.trim() === '取消')?.click()`)
          await js(`Array.from(document.querySelectorAll('.draft-lib-chip')).find(node => node.textContent.includes('Anime'))?.click()`)
          await until(() => js(`Boolean(document.querySelector('.draft-table tbody tr.draft-row'))`), 'back on lib_anime', 25000)
          return
        }
        await js(`Array.from(document.querySelectorAll('.draft-dialog-actions button')).find(node => node.textContent.includes('仍然应用'))?.click()`)
        await until(() => js(`Boolean(document.querySelector('.draft-dialog.approval'))`), 'approval sheet', 30000)
        await wait(300)
        const approvalShot = join(dir, 'catalog-draft-approval.png')
        await writeFile(approvalShot, (await window.webContents.capturePage()).toPNG())
        const caps = JSON.parse((await invoke('mediaRequest', { method: 'GET', path: '/api/media/capabilities', query: null, body: null })).body)
        const sheet = await js(`(() => ({
          title: document.querySelector('.draft-dialog.approval h4')?.textContent?.trim() ?? null,
          groups: Array.from(document.querySelectorAll('.draft-dialog.approval h5')).map(node => node.textContent.trim()),
          rows: document.querySelectorAll('.draft-dialog.approval .draft-approval-group li').length,
          persist: document.querySelector('.draft-dialog.approval')?.textContent?.includes('成功即消耗') ?? null,
          soft: document.querySelector('.draft-dialog.approval')?.textContent?.includes('当前是软边界') ?? null,
          buttons: Array.from(document.querySelectorAll('.draft-dialog.approval .draft-dialog-actions button')).map(node => node.textContent.trim()),
          tableInert: document.querySelector('section.draft')?.hasAttribute('inert') ?? null,
        }))()`)
        console.log('MEDIA_DRAFT_APPROVAL_SHEET ' + JSON.stringify({ library: picked, ...sheet, shot: approvalShot }))
        assert.match(sheet.title ?? '', /需要批准/, `批准单标题不对: ${JSON.stringify(sheet.title)}`)
        assert.ok((sheet.groups ?? []).some(text => /新建 \d+ 张/.test(text)), `批准单没列新建清单: ${JSON.stringify(sheet.groups)}`)
        assert.ok(sheet.rows >= 1, `批准单清单是空的: ${JSON.stringify(sheet)}`)
        assert.equal(sheet.persist, true, `批准单没写一次性: ${JSON.stringify(sheet)}`)
        assert.equal(sheet.soft, caps.catalogApproval === 'loopback-admin', `软边界提示与能力位不一致（${caps.catalogApproval}）: ${JSON.stringify(sheet)}`)
        assert.ok(sheet.buttons.some(text => text.includes('批准并应用')), `批准单主按钮不对: ${JSON.stringify(sheet.buttons)}`)
        // 弹层期间面板必须 inert（键盘也进不去，§a 的前提）。
        assert.equal(sheet.tableInert, true, `弹层开着时面板没有 inert: ${JSON.stringify(sheet)}`)

        // 批准 → 立刻应用 → 200；抬头出现「可撤回」一行。
        await js(`Array.from(document.querySelectorAll('.draft-dialog.approval .draft-dialog-actions button')).find(node => node.textContent.includes('批准并应用'))?.click()`)
        await until(() => js(`document.body.innerText.includes('已批准并应用')`), 'approved notice', 40000)
        await until(() => js(`Boolean(document.querySelector('.draft-banner.rollback'))`), 'rollback row', 30000)
        // 面板是滚动的：截图前把这一行滚到视口里，否则图上看不到（DOM 断言不受影响）。
        await js(`document.querySelector('.draft-banner.rollback')?.scrollIntoView({ block: 'center' })`)
        await wait(300)
        const rowShot = join(dir, 'catalog-draft-rollback-row.png')
        await writeFile(rowShot, (await window.webContents.capturePage()).toPNG())
        const rowUi = await js(`(() => ({
          text: document.querySelector('.draft-banner.rollback')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 160) ?? null,
          buttons: Array.from(document.querySelectorAll('.draft-banner.rollback button')).map(node => node.textContent.trim()),
        }))()`)
        console.log('MEDIA_DRAFT_ROLLBACK_ROW ' + JSON.stringify({ ...rowUi, shot: rowShot }))
        assert.match(rowUi.text ?? '', /上次应用：＋\d+ −\d+/, `撤回行没写清这次应用改了什么: ${JSON.stringify(rowUi)}`)
        assert.ok(rowUi.buttons.some(text => text.includes('撤回这次')), `撤回行缺按钮: ${JSON.stringify(rowUi)}`)

        // 撤回也要再批一次：撤回批准单 → 批准并撤回 → 撤回行消失。
        await js(`Array.from(document.querySelectorAll('.draft-banner.rollback button')).find(node => node.textContent.includes('撤回这次'))?.click()`)
        await until(() => js(`document.querySelector('.draft-dialog.approval')?.textContent?.includes('撤回上次应用') ?? false`), 'rollback approval sheet', 20000)
        await wait(200)
        const rollbackShot = join(dir, 'catalog-draft-rollback-sheet.png')
        await writeFile(rollbackShot, (await window.webContents.capturePage()).toPNG())
        const rollbackSheet = await js(`(() => ({
          text: document.querySelector('.draft-dialog.approval')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 260) ?? null,
          buttons: Array.from(document.querySelectorAll('.draft-dialog.approval .draft-dialog-actions button')).map(node => node.textContent.trim()),
        }))()`)
        console.log('MEDIA_DRAFT_ROLLBACK_SHEET ' + JSON.stringify({ ...rollbackSheet, shot: rollbackShot }))
        assert.match(rollbackSheet.text ?? '', /海报会一起接回来/, `撤回单没说清海报不丢: ${JSON.stringify(rollbackSheet)}`)
        assert.match(rollbackSheet.text ?? '', /一次性/, `撤回单没写一次性: ${JSON.stringify(rollbackSheet)}`)
        assert.doesNotMatch(rollbackSheet.text ?? '', /可重抓/, `撤回单又写了"可重抓"（后端已修）: ${JSON.stringify(rollbackSheet)}`)
        await js(`Array.from(document.querySelectorAll('.draft-dialog.approval .draft-dialog-actions button')).find(node => node.textContent.includes('批准并撤回'))?.click()`)
        await until(() => js(`document.body.innerText.includes('已撤回')`), 'rolled back notice', 40000)
        await until(() => js(`!document.querySelector('.draft-banner.rollback')`), 'rollback row gone', 20000)
        const afterRollback = await js(`(() => ({
          notice: document.body.innerText.split(String.fromCharCode(10)).find(line => line.includes('已撤回')) ?? null,
          rows: document.querySelectorAll('.draft-table tbody tr.draft-row').length,
        }))()`)
        console.log('MEDIA_DRAFT_ROLLBACK_DONE ' + JSON.stringify({ library: picked, ...afterRollback }))
        assert.ok(afterRollback.rows > 0, `撤回后草稿表空了: ${JSON.stringify(afterRollback)}`)
        await js(`Array.from(document.querySelectorAll('.draft-dialog-actions button')).find(node => node.textContent.trim() === '取消')?.click()`)
        // 回到正式库，别把后面的步骤留在临时库上。
        await js(`Array.from(document.querySelectorAll('.draft-lib-chip')).find(node => node.textContent.includes('Anime'))?.click()`)
        await until(() => js(`Boolean(document.querySelector('.draft-table tbody tr.draft-row'))`), 'back on lib_anime', 25000)
      }
  })

  // 收尾：把这次测试建的源删掉，别留在用户的开发库里（下一轮 harness 的 chips 数也算得出是 4）。
  const rows = await invoke('mediaRequest', { method: 'GET', path: '/api/admin/media-sources', query: null, body: null })
  const saved = (() => { try { return (JSON.parse(rows.body).sources ?? []).find(row => row.name === 'Second check') } catch { return null } })()
  console.log('MEDIA_SOURCE_CLEANUP ' + JSON.stringify({ id: saved?.id ?? null, passwordSet: saved?.passwordSet ?? null, storedPassword: 'password' in (saved ?? {}) }))
  assert.equal(saved?.passwordSet, true, '新源没有记下密码位')
  assert.equal('password' in (saved ?? {}), false, '管理端回显了密码字段')
  const removed = await invoke('mediaRequest', { method: 'DELETE', path: `/api/admin/media-sources/${saved?.id ?? 'missing'}`, query: null, body: null })
  assert.equal(removed.status, 204, `清理没成功，开发库里留了一个测试源: ${JSON.stringify(removed)}`)
}
