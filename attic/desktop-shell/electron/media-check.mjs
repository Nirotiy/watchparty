import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as wait } from 'node:timers/promises'

/**
 * Media library acceptance (multi-source phase 1) against a **real local stack**, not a
 * fixture: real libraries, real files, real screenshot. The folder browser only exists
 * inside a room, so this enters one first.
 *
 *   node electron/launch.mjs --media-check
 *
 * Env: WATCHPARTY_MEDIA_CHECK_ORIGIN (default http://127.0.0.1:8080).
 *
 * 2026-10-03 发布口径：桌面端只做房间浏览——sidecar 白名单只放行
 * `GET /api/media/{capabilities,libraries,list,search,catalog,catalog/{id}}` 六条只读路由。
 * 管理面（源管理/刮削/草稿/审批/加源/坏源隔离）已从桌面端与本 harness 一并移除，
 * 由服务端管理工具承担。
 */
export async function runMediaCheck(window, native) {
  const invoke = (command, args = {}) => window.webContents.executeJavaScript(`window.watchpartyDesktop.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`)
  const js = source => window.webContents.executeJavaScript(source)
  async function until(check, label, timeout = 20000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) { if (await check()) return; await wait(100) }
    throw new Error(label)
  }
  const origin = process.env.WATCHPARTY_MEDIA_CHECK_ORIGIN?.trim() || 'http://127.0.0.1:8080'
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

  // 走大厅 UI 建房（2026-10-02 拆开：段选「创建」→「创建房间」→ 结果块 →「进入房间」，
  // 三处都是 UI 那条路；创建本身不再自动进房）。
  await step('lobby-create-room', () => js(`(() => {
    const lobby = document.querySelector('.banguru-lobby')
    if (!lobby) throw new Error('banguru lobby missing')
    const input = Array.from(lobby.querySelectorAll('input')).find(node => node.placeholder === '显示给房间成员')
    if (!input) throw new Error('nickname field missing')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'MediaCheck')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`))
  await js(`Array.from(document.querySelectorAll('.banguru-lobby .bh-seg button')).find(node => node.textContent.trim() === '创建').click()`)
  await until(() => js(`(() => { const button = Array.from(document.querySelectorAll('.banguru-lobby button')).find(node => node.textContent.trim() === '创建房间'); return Boolean(button && !button.disabled) })()`), 'lobby create enabled')
  await js(`Array.from(document.querySelectorAll('.banguru-lobby button')).find(node => node.textContent.trim() === '创建房间').click()`)
  await until(() => js(`Boolean(document.querySelector('.banguru-lobby .bh-created'))`), 'created room block', 25000)
  const createdRoomId = await js(`document.querySelector('.banguru-lobby .bh-created-id')?.textContent ?? null`)
  console.log('MEDIA_LOBBY_CREATED ' + JSON.stringify({ roomId: createdRoomId }))
  assert.ok(typeof createdRoomId === 'string' && createdRoomId.startsWith('room-'), `结果块没有回显后端房号: ${createdRoomId}`)
  await until(() => js(`(() => { const button = Array.from(document.querySelectorAll('.banguru-lobby .bh-created button')).find(node => node.textContent.trim() === '进入房间'); return Boolean(button && !button.disabled) })()`), 'enter room enabled', 25000)
  await js(`Array.from(document.querySelectorAll('.banguru-lobby .bh-created button')).find(node => node.textContent.trim() === '进入房间').click()`)
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

  // 发布口径（2026-10-03）：媒体管理面已撤出桌面端，sidecar 只剩房间浏览的六条只读路由。
  // 白名单外的请求（管理源读写、白名单外媒体路径）在 sidecar 就被拒，码要能到渲染层（P1-1 的保真映射）。
  for (const probe of [
    { method: 'GET', path: '/api/admin/media-sources' },
    { method: 'POST', path: '/api/admin/media-sources' },
    { method: 'GET', path: '/api/media/roots' },
  ]) {
    const denied = await invoke('mediaRequest', { ...probe, query: null, body: null }).then(() => null, error => error)
    console.log('MEDIA_ROUTE_DENIED_CHECK ' + JSON.stringify({ ...probe, code: denied?.code ?? null }))
    assert.equal(denied?.code, 'MEDIA_ROUTE_DENIED', `${probe.method} ${probe.path} 没有被拒: ${JSON.stringify(denied)}`)
  }
  console.log('MEDIA_LIBRARY_CHECK_OK')
  await runArtworkCheck({ window, js, until, step })
  await runTitlesCheck({ window, js, until, step })
  await runPlayCheck({ window, js, until, step })
}

/**
 * 相位 3：标题墙。真实库已经刮过，所以这一条直接量真数据：墙上有卡、未匹配不在墙上、
 * 文案容忍度与右栏（徽标不压标题、长简介三行折叠）几何对。策展动作已随管理面撤出桌面端。
 */
async function runTitlesCheck({ window, js, until, step }) {
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
 * P1-5 最后一段：真的从卡片点一次播放。走的是既有的房间 resolve（v2 mediaId），
 * 断言的是「标题进了房间状态」——播放器本身由 libmpv 承担，不在这个 harness 的职责里。
 */
async function runPlayCheck({ window, js, until, step }) {
  await step('play-resolve', async () => {
    // 上一步的文件视图还停在封面用例钻进去的子目录（偶像大师：只有图和 nfo，没有可播文件）。
    // 旧版本靠隔离用例重挂视图顺带回到库根；那一步撤掉后这里显式点面包屑第一格回根。
    const hasCrumbs = await js(`(() => {
      const button = document.querySelector('.desktop-page nav[aria-label="目录路径"] button')
      if (!button) return false
      button.click()
      return true
    })()`)
    if (hasCrumbs) {
      await until(() => js(`document.querySelectorAll('.desktop-page nav[aria-label="目录路径"] button').length <= 1 && document.querySelectorAll('.media-card').length > 0`), 'library root grid', 20000)
      await wait(500)
    }
    const target = await js(`(() => {
      const card = Array.from(document.querySelectorAll('article.media-card')).find(node =>
        Array.from(node.querySelectorAll('button')).some(button => button.textContent.trim() === '播放' && !button.disabled))
      if (!card) return null
      const title = card.querySelector('.media-card-open span span')?.textContent?.trim() ?? ''
      Array.from(card.querySelectorAll('button')).find(button => button.textContent.trim() === '播放').click()
      return title
    })()`)
    if (!target) console.log('MEDIA_PLAY_CARDS ' + JSON.stringify(await js(`Array.from(document.querySelectorAll('article.media-card')).slice(0, 10).map(card => ({ text: card.textContent.replace(/\\s+/g, ' ').trim().slice(0, 50), buttons: Array.from(card.querySelectorAll('button')).map(button => button.textContent.trim() + (button.disabled ? '(禁)' : '')) }))`)))
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

  /**
   * P2·24 取证（2026-10-03 用户点单）：带片播放 × 三档窗宽 × 全屏往返。
   * 三个窗宽下控制栏与文档不得横向溢出；全屏进出后回窗口态、几何还原、媒体不停。
   */
  await step('player-scaling', async () => {
    const dir = join(tmpdir(), 'watchparty-media-check')
    await mkdir(dir, { recursive: true })
    const geometry = () => js(`(() => {
      const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), sw: el.scrollWidth, cw: el.clientWidth, overflow: el.scrollWidth - el.clientWidth } }
      return {
        innerWidth: window.innerWidth,
        row: box(document.querySelector('.media-control-row')),
        seek: box(document.querySelector('.media-bottom-scrim > div:first-child')),
        scrim: box(document.querySelector('.media-scrim')),
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        playing: /[0-9]{1,2}:[0-9]{2}:[0-9]{2}/.test(document.body.innerText),
      }
    })()`)
    const wake = async () => {
      await js(`document.querySelector('.media-scrim').dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))`)
      await wait(250)
    }
    const shots = []
    for (const [label, width] of [['wide', 1300], ['mid', 1100], ['narrow', 960]]) {
      window.setContentSize(width, 800)
      await wake()
      const shot = join(dir, `room-playing-${label}-${width}.png`)
      await writeFile(shot, (await window.webContents.capturePage()).toPNG())
      const geo = await geometry()
      shots.push({ label, width, shot, geo })
    }
    console.log('PLAYER_PLAYING_WINDOWS ' + JSON.stringify(shots))
    for (const row of shots) {
      assert.equal(row.geo.playing, true, `带片几何采样时媒体已不在播放: ${JSON.stringify(row)}`)
      assert.equal(row.geo.row?.overflow, 0, `带片控制栏在 ${row.width} 溢出: ${JSON.stringify(row.geo)}`)
      assert.equal(row.geo.seek?.overflow, 0, `带片进条行在 ${row.width} 溢出: ${JSON.stringify(row.geo)}`)
      assert.equal(row.geo.scrim?.overflow, 0, `带片主叠层在 ${row.width} 溢出: ${JSON.stringify(row.geo)}`)
      assert.equal(row.geo.docOverflow, 0, `带片文档在 ${row.width} 溢出: ${JSON.stringify(row.geo)}`)
    }
    // 定位潜在布局溢出（clipped、不可见也要点名）：仅在真有溢出时打印，免得绿跑成噪音。
    if (shots.some(row => (row.geo.seek?.overflow ?? 0) > 0 || (row.geo.scrim?.overflow ?? 0) > 0)) {
      const culprits = await js(`(() => {
      const scan = (sel, label) => {
        const root = document.querySelector(sel)
        if (!root) return { label, missing: true }
        const cr = root.getBoundingClientRect()
        const out = []
        for (const node of root.querySelectorAll('*')) {
          const r = node.getBoundingClientRect()
          if (r.width === 0 && r.height === 0) continue
          if (r.right > cr.right + 1 || r.left < cr.left - 1) out.push({ cls: (String(node.className) || node.tagName).slice(0, 60), left: Math.round(r.left), right: Math.round(r.right) })
          if (out.length >= 6) break
        }
        return { label, offenders: out }
      }
      return { scrim: scan('.media-scrim', 'scrim'), seek: scan('.media-bottom-scrim > div:first-child', 'seek') }
    })()`)
      console.log('PLAYER_OVERFLOW_CULPRITS ' + JSON.stringify(culprits))
    }

    window.setContentSize(1300, 800)
    await wake()
    await js(`document.querySelector('button[aria-label="全屏"]')?.click()`)
    await until(async () => window.isFullScreen(), 'fullscreen on', 8000)
    await wait(500)
    const fullShot = join(dir, 'room-playing-fullscreen.png')
    await writeFile(fullShot, (await window.webContents.capturePage()).toPNG())
    const fullGeo = await geometry()
    console.log('PLAYER_PLAYING_FULLSCREEN ' + JSON.stringify({ shot: fullShot, geo: fullGeo }))
    assert.equal(fullGeo.playing, true, `进全屏后媒体停了: ${JSON.stringify(fullGeo)}`)
    assert.equal(fullGeo.seek?.overflow, 0, `全屏进条行溢出: ${JSON.stringify(fullGeo)}`)
    assert.equal(fullGeo.scrim?.overflow, 0, `全屏主叠层溢出: ${JSON.stringify(fullGeo)}`)
    assert.equal(fullGeo.docOverflow, 0, `全屏下文档溢出: ${JSON.stringify(fullGeo)}`)

    await js(`document.querySelector('button[aria-label="退出全屏"]')?.click()`)
    await until(async () => !window.isFullScreen(), 'fullscreen off', 8000)
    await wait(600)
    window.setContentSize(1300, 800)
    await wake()
    const backGeo = await geometry()
    console.log('PLAYER_PLAYING_BACK ' + JSON.stringify(backGeo))
    assert.equal(backGeo.playing, true, `退出全屏后媒体停了: ${JSON.stringify(backGeo)}`)
    assert.equal(backGeo.row?.overflow, 0, `退回窗口态后控制栏溢出: ${JSON.stringify(backGeo)}`)
    assert.equal(backGeo.seek?.overflow, 0, `退回窗口态后进条行溢出: ${JSON.stringify(backGeo)}`)
    assert.equal(backGeo.scrim?.overflow, 0, `退回窗口态后主叠层溢出: ${JSON.stringify(backGeo)}`)
    assert.equal(backGeo.docOverflow, 0, `退回窗口态后文档溢出: ${JSON.stringify(backGeo)}`)
  })
}
