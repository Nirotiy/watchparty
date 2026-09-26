import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app, nativeImage, shell } from 'electron'
import { once } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as wait } from 'node:timers/promises'
import { runServiceAcceptance } from './service-acceptance.mjs'
const require = createRequire(import.meta.url)
const { WebSocket, WebSocketServer } = require('ws')
const ts = require('typescript')
const root = fileURLToPath(new URL('../../', import.meta.url))
async function moduleUrl(name) {
  let js = ts.transpile(await readFile(join(root, 'desktop-shell/shared', `${name}.ts`), 'utf8'), { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
  for (const dep of ['musicparty-contract', 'retry', 'shared-room-state']) if (js.includes(`from "./${dep}"`)) js = js.replaceAll(`from "./${dep}"`, `from "${await moduleUrl(dep)}"`)
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
}
async function until(test, label, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test()) return; await wait(100) }
  throw new Error(`timeout: ${label}`)
}
async function listen(server) { await new Promise(r => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${server.address().port}` }
function pcm(seconds) {
  const rate = 48000, wav = Buffer.alloc(44 + seconds * rate * 2)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
  // Quiet generated tone. Decoder progress alone does not establish audible system output.
  for (let i = 0; i < seconds * rate; i++) wav.writeInt16LE(Math.round(120 * Math.sin(i * 2 * Math.PI * 440 / rate)), 44 + i * 2)
  return wav
}

/** Runs invite redemption and the shipped one-screen view against an isolated Go service. */
export async function runLinkleCheck(window, native) {
  const dir = await mkdtemp(join(tmpdir(), 'watchparty-linkle-check-'))
  const children = [], servers = []
  const exe = join(dir, 'musicparty.exe')
  const build = spawn('go', ['build', '-o', exe, './cmd/musicparty'], {
    cwd: resolve(root, '../musicparty/MusicParty/backend-go'), windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'],
  })
  if ((await once(build, 'exit'))[0] !== 0) throw new Error('isolated_musicparty_build_failed')
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(systemroot|windir|path|temp|tmp)$/i.test(name)))
  const invoke = (command, args = {}) => window.webContents.executeJavaScript(`window.watchpartyDesktop.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`)
  const start = (executable, args, options) => {
    const child = spawn(executable, args, { windowsHide: true, ...options })
    children.push(child)
    return child
  }
  try {
    await runServiceAcceptance({ window, native, invoke, exe, dir, env, start, servers, listen, until, pcm, stopAtWorkspace: true, onWorkspace: checkLinkleWorkspace })
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)) }
    for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit'); child.kill(); await exit
    }
  }
}

/**
 * One-screen workspace evidence: covers, palette, word-sweep, panel geometry and
 * tooltip placement. Screenshots land next to the other generated artefacts and
 * their paths are printed, so a human can look at the same frames.
 */
async function checkLinkleWorkspace({ js, until, wait, service, shot, shotRect, coverOrigin, invoke, fill, click, browserWindow, lastRedeemName }) {
  const box = selector => js(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, text: (el.textContent || '').trim().slice(0, 80) }
  })()`)
  const inside = (inner, outer) => Boolean(inner && outer) && inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5
  const evidence = {}

  // 本机 ID → 服务端（用户 2026-09-25 方案 1）：兑换请求要带上它，服务端账号名要变成它。
  const accountProbe = await invoke('musicPartyRequest', { input: { origin: service.origin, method: 'GET', path: '/api/account/me', clientVersion: '0.2.0' } })
  const accountBody = (() => { try { return JSON.parse(accountProbe?.body ?? '{}') } catch { return {} } })()
  evidence.boundIdentity = { redeem: lastRedeemName?.() ?? null, stored: accountBody.displayName ?? null }
  console.log('LOCAL_ID_BOUND ' + JSON.stringify(evidence.boundIdentity))
  assert.equal(lastRedeemName?.() ?? null, '验收ID', `兑换请求没有带上本机 ID: ${JSON.stringify(evidence.boundIdentity)}`)
  assert.equal(accountBody.displayName, '验收ID', `服务端账号名不是本机 ID: ${JSON.stringify(evidence.boundIdentity)}`)

  await service.enqueue('101'); await service.enqueue('102'); await service.enqueue('103')
  await until(() => js(`document.querySelector('.linkle-room .imm-cover strong')?.textContent?.includes('Service track')`), 'current track on the immersive page')
  await until(() => js(`(document.querySelector('.linkle-room .imm-art img')?.src ?? '').startsWith('data:image/')`), 'cover art proxied into a data URL')
  evidence.cover = await js(`(() => { const img = document.querySelector('.linkle-room .imm-art img'); return { source: img.src.slice(0, 22), bytes: img.src.length } })()`)
  await until(() => js(`document.querySelectorAll('.linkle-room .lyrictext .u').length > 0`), 'word-level lyric units rendered')
  await until(() => js(`Boolean(document.querySelector('.lyrictext p.current'))`), 'active lyric line')
  await wait(1200)

  const palette = await js(`(() => { const room = document.querySelector('.linkle-room'); return { bar: room.style.getPropertyValue('--bar-accent'), accent: room.style.getPropertyValue('--accent'), imm1: room.style.getPropertyValue('--imm-c1') } })()`)
  assert.ok(/^hsl\(/.test(palette.bar) && /^hsl\(/.test(palette.imm1), `cover palette missing: ${JSON.stringify(palette)}`)
  evidence.palette = palette

  // The artwork proxy refuses anything that is not a reachable image: a text
  // response, a private address literal, and a non-http scheme.
  const rejections = []
  for (const url of [`${coverOrigin}/not-an-image`, 'http://10.0.0.1/cover.jpg', 'file:///C:/Windows/win.ini']) {
    const rejected = await invoke('fetchArtworkImage', { url }).then(() => false).catch(() => true)
    rejections.push({ url: url.slice(0, 40), rejected })
  }
  evidence.artworkPolicy = rejections
  assert.ok(rejections.every(entry => entry.rejected), `artwork proxy accepted a bad source: ${JSON.stringify(rejections)}`)

  const sweep = await js(`(() => {
    const units = Array.from(document.querySelectorAll('.lyrictext p.current .u'))
    return { count: units.length, fills: units.map(unit => unit.style.getPropertyValue('--p')) }
  })()`)
  assert.ok(sweep.count > 1, `expected word-level units on the active line: ${JSON.stringify(sweep)}`)
  assert.ok(sweep.fills.some(value => value && value !== '0%'), `word sweep never advanced: ${JSON.stringify(sweep)}`)
  evidence.sweep = sweep
  // The sweep keeps moving even on a reduced-motion desktop: the word fill is
  // informational and the 歌词动效 switch carries the accessibility escape hatch.
  const first = await js(`Array.from(document.querySelectorAll('.lyrictext p.current .u')).map(unit => unit.style.getPropertyValue('--p')).join(',')`)
  // The shared projection advances on ~1s server frames until the clock samples are trusted, so a
  // single 500ms window can legitimately show no change; sample until it moves.
  let second = first
  for (let attempt = 0; attempt < 6 && second === first; attempt += 1) { await wait(400); second = await js(`Array.from(document.querySelectorAll('.lyrictext p.current .u')).map(unit => unit.style.getPropertyValue('--p')).join(',')`) }
  evidence.sweepProgression = { first, second }
  assert.notEqual(first, second, `word sweep is frozen: ${first}`)

  const units = await js(`(() => { const u = Array.from(document.querySelectorAll('.lyrictext .u')); return { total: u.length, lines: document.querySelectorAll('.lyrictext p').length, translated: document.querySelectorAll('.lyrictext .translation-line').length } })()`)
  evidence.lyrics = units
  await shot('01-listen')

  // 分栏布局已废弃（用户 2026-09-25 裁决：沉浸页是唯一播放界面）。进房必须直接落在
  // 沉浸页，DOM 里不再有分割条与「沉浸收听」开关，播放条是左列里的静态控制台
  //（不再是绝对定位压在房名上的分栏播放条），也不再写已废弃的 linkle.mode 偏好。
  const noSplit = await js(`(() => ({
    immersive: document.querySelector('.linkle-room')?.classList.contains('immersive') ?? false,
    splitter: Boolean(document.querySelector('.linkle-room .splitter')),
    toggle: Boolean(document.querySelector('.linkle-room button[aria-label="沉浸收听"]')),
    openInTask: Boolean(document.querySelector('.linkle-room button[aria-label="在任务区打开"]')),
    barPosition: getComputedStyle(document.querySelector('.linkle-room .bar-holder')).position,
    legacyMode: localStorage.getItem('linkle.mode'),
  }))()`)
  evidence.noSplit = noSplit
  console.log('NO_SPLIT_LAYOUT ' + JSON.stringify(noSplit))
  assert.equal(noSplit.immersive, true, `进房没有落在沉浸页: ${JSON.stringify(noSplit)}`)
  assert.equal(noSplit.splitter, false, `分割条仍在 DOM 里: ${JSON.stringify(noSplit)}`)
  assert.equal(noSplit.toggle, false, `「沉浸收听」开关仍在: ${JSON.stringify(noSplit)}`)
  assert.equal(noSplit.openInTask, false, `「在任务区打开」仍在: ${JSON.stringify(noSplit)}`)
  assert.equal(noSplit.barPosition, 'static', `播放条不是静态控制台: ${JSON.stringify(noSplit)}`)
  assert.equal(noSplit.legacyMode, null, `仍在写已废弃的 linkle.mode: ${noSplit.legacyMode}`)

  // 房名不能被播放条压住（分栏时的老问题，改成左列静态控制台后仍要成立）。
  const identity = await box('.linkle-room .identity h2')
  const bar = await box('.linkle-room .bar-holder')
  assert.ok(identity && bar && identity.bottom <= bar.top, `room name overlaps the player bar: ${JSON.stringify({ identity, bar })}`)
  const headTitle = await box('.linkle-room .panel-head strong')
  const task = await box('.linkle-room .task')
  evidence.split = { identity, bar, headTitle, task }

  await js(`document.querySelector('.linkle-room button[aria-label="播放队列"]').click()`)
  await until(() => js(`document.querySelector('.linkle-room .panel-head strong')?.textContent === '播放队列'`), 'queue panel')
  await wait(400)
  const panel = await box('.linkle-room .task')
  const panelTitle = await box('.linkle-room .panel-head strong')
  const panelRows = await js(`Array.from(document.querySelectorAll('.linkle-room .panel-body .song')).map(row => ({ scrollWidth: row.scrollWidth, clientWidth: row.clientWidth }))`)
  const panelBody = await box('.linkle-room .task .panel-body')
  assert.ok(inside(panelTitle, panel), `panel title escapes the panel: ${JSON.stringify({ panelTitle, panel })}`)
  assert.ok(panelRows.every(row => row.scrollWidth <= row.clientWidth + 1), `queue rows overflow horizontally: ${JSON.stringify(panelRows)}`)
  assert.ok(panelRows.length > 1, `expected queue rows in the panel: ${JSON.stringify(panelRows)}`)
  assert.ok(panelBody.scrollWidth <= panelBody.clientWidth + 1, `panel body scrolls horizontally: ${JSON.stringify(panelBody)}`)
  evidence.queuePanel = { panel, panelTitle, panelBody, panelRows }
  // Drag grips are buttons, so they inherit the shell's button box unless reset:
  // each grip must stay inside its 22px column and never reach into the title.
  const grips = await js(`Array.from(document.querySelectorAll('.linkle-room .panel-body .song')).map(row => {
    const grip = row.querySelector('.grip') ?? row.querySelector('input[type="checkbox"]')
    const title = row.querySelector('strong')
    if (!grip || !title) return null
    const gripBox = grip.getBoundingClientRect()
    const titleBox = title.getBoundingClientRect()
    return { width: +gripBox.width.toFixed(1), height: +gripBox.height.toFixed(1), gap: +(titleBox.left - gripBox.right).toFixed(1) }
  }).filter(Boolean)`)
  evidence.grips = grips
  assert.ok(grips.length > 0 && grips.every(grip => grip.width <= 22.5), `drag grip overflows its column: ${JSON.stringify(grips)}`)
  assert.ok(grips.every(grip => grip.height <= 26.5), `drag grip is taller than a row line: ${JSON.stringify(grips)}`)
  assert.ok(grips.every(grip => grip.gap >= -0.5), `drag grip reaches into the title: ${JSON.stringify(grips)}`)
  await shot('02-queue-panel')

  // 面板占满主视图时会隐藏左列（播放条）与右列（歌词），而下一步的音量/提示框/滚动条测量
  // 需要这些元素可见：先关面板。分栏时代播放条一直可见，所以以前不需要这一步。
  await js(`document.querySelector('.linkle-room .panel-head button[aria-label="关闭面板"]').click()`)
  await until(() => js(`!document.querySelector('.linkle-room .panel-head')`), 'panel closed')
  await until(() => js(`(document.querySelector('.linkle-room .imm-left')?.getBoundingClientRect().width ?? 0) > 0`), 'left column visible again')

  // 音量：the icon states the value, the fill follows the slider, and muting is flagged.
  // 默认音量 30%（用户 2026-09-25）：本机没有记忆时，进房就是 30；改动要写回本机记忆。
  const volumeDefault = await js(`(() => {
    const input = document.querySelector('.linkle-room .slider')
    return { value: Number(input.value), fill: input.style.getPropertyValue('--fill'), memory: Object.keys(localStorage).filter(key => key.startsWith('linkle.volume.')) }
  })()`)
  evidence.volumeDefault = volumeDefault
  console.log('VOLUME_DEFAULT ' + JSON.stringify(volumeDefault))
  assert.equal(volumeDefault.value, 30, `默认音量不是 30%: ${JSON.stringify(volumeDefault)}`)
  const volumeControl = async value => {
    await js(`(() => { const input = document.querySelector('.linkle-room .slider'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '${value}'); input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await wait(200)
    return js(`(() => {
      const input = document.querySelector('.linkle-room .slider')
      const icon = document.querySelector('.linkle-room .grp.volume button svg')
      return { fill: input.style.getPropertyValue('--fill'), icon: icon ? icon.innerHTML : null, flags: Array.from(document.querySelectorAll('.linkle-room .flag')).map(flag => flag.textContent) }
    })()`)
  }
  const volumeFull = await volumeControl(80)
  const volumeZero = await volumeControl(0)
  evidence.volume = { volumeFull, volumeZero }
  assert.equal(volumeFull.fill, '80%', `volume fill does not follow the value: ${JSON.stringify(volumeFull)}`)
  assert.equal(volumeZero.fill, '0%', `muted volume fill is wrong: ${JSON.stringify(volumeZero)}`)
  assert.notEqual(volumeFull.icon, volumeZero.icon, `the volume icon does not reflect the state: ${JSON.stringify(evidence.volume)}`)
  const volumeMemory = await js(`Object.entries(localStorage).filter(([key]) => key.startsWith('linkle.volume.')).map(([key, value]) => ({ key, value }))`)
  evidence.volumeMemory = volumeMemory
  console.log('VOLUME_MEMORY ' + JSON.stringify(volumeMemory))
  assert.ok(volumeMemory.some(entry => entry.value === '80'), `音量改动没有写回本机记忆: ${JSON.stringify(volumeMemory)}`)
  assert.ok(volumeZero.flags.some(text => text.includes('本机静音')), `muting is not flagged: ${JSON.stringify(volumeZero.flags)}`)
  // 状态标常驻房头（分栏播放条的 .flags 已随分栏删除，用户 2026-09-25）：静音时那颗标
  // 必须真的在 roomhead 里，并且不与右侧的图标栏重叠。
  const headFlag = await js(`(() => {
    const head = document.querySelector('.linkle-room .roomhead')
    const flag = Array.from(head.querySelectorAll('.flag')).find(node => node.textContent.includes('本机静音'))
    const nav = head.querySelector('.room-actions')
    if (!flag || !nav) return { found: false }
    const f = flag.getBoundingClientRect(), n = nav.getBoundingClientRect(), h = head.getBoundingClientRect()
    return { found: true, gap: +(n.left - f.right).toFixed(1), inside: f.top >= h.top - 0.5 && f.bottom <= h.bottom + 0.5, text: flag.textContent }
  })()`)
  evidence.headFlag = headFlag
  console.log('HEAD_FLAG ' + JSON.stringify(headFlag))
  assert.ok(headFlag.found && headFlag.inside, `本机静音状态标不在房头里: ${JSON.stringify(headFlag)}`)
  assert.ok(headFlag.gap >= -0.5, `状态标与房头图标栏重叠: ${JSON.stringify(headFlag)}`)
  await shot('31-head-flag')
  await volumeControl(100)

  // Tooltip placement is driven by a pointer event rather than real hover/focus, so
  // the check does not depend on the window owning OS focus. A scoped style forces
  // the bubbles visible; the placement pass then clamps the one under test.
  const tipStyle = await js(`(() => {
    const style = document.createElement('style')
    style.id = 'harness-tooltip-visible'
    style.textContent = '.linkle-room .tooltip{display:block !important}'
    document.head.append(style)
    return true
  })()`)
  const tipBox = async (bubbleSelector, buttonSelector) => {
    await js(`document.querySelector(${JSON.stringify(buttonSelector)}).dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`)
    await wait(150)
    return box(bubbleSelector)
  }
  /** 提示框必须落在「窗口 ∩ 各级裁剪容器」内（用户 2026-09-24「提示框越界」）。
      只看 room 不够：歌词栏/任务列本身是 overflow:hidden，越出它们的部分会被裁掉。 */
  const tipBounds = labels => js(`(async () => {
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const round = box => ({ l: Math.round(box.left), t: Math.round(box.top), r: Math.round(box.right), b: Math.round(box.bottom) })
    const out = []
    for (const label of ${JSON.stringify(labels)}) {
      const button = document.querySelector('.linkle-room button[aria-label="' + label + '"]')
      const bubble = button ? button.parentElement.querySelector('.tooltip') : null
      if (!button || !bubble) { out.push({ label, missing: true }); continue }
      button.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
      // 落位可能晚一帧（显示态由 :hover 决定，placement 会重试），所以等到位置不再变化再量。
      let previous = null
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await frame()
        const current = bubble.getBoundingClientRect()
        if (previous && current.left === previous.left && current.top === previous.top) break
        previous = current
      }
      const rect = bubble.getBoundingClientRect()
      let bounds = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
      for (let node = bubble.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (!/(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowX + style.overflowY)) continue
        const box = node.getBoundingClientRect()
        bounds = { left: Math.max(bounds.left, box.left), top: Math.max(bounds.top, box.top), right: Math.min(bounds.right, box.right), bottom: Math.min(bounds.bottom, box.bottom) }
      }
      const style = getComputedStyle(bubble)
      const buttonBox = button.getBoundingClientRect()
      out.push({ label, rect: round(rect), bounds: round(bounds), button: round(buttonBox), anchorOffset: Math.round((rect.left + rect.width / 2) - (buttonBox.left + buttonBox.width / 2)), shift: style.getPropertyValue('--tip-shift-x').trim() || null, display: style.display, inside: rect.left >= bounds.left - 1 && rect.top >= bounds.top - 1 && rect.right <= bounds.right + 1 && rect.bottom <= bounds.bottom + 1 })
    }
    return out
  })()`)
  const assertTipsInside = reported => {
    assert.ok(reported.every(tip => !tip.missing), `找不到待测的提示框: ${JSON.stringify(reported.filter(tip => tip.missing))}`)
    assert.deepEqual(reported.filter(tip => tip.inside === false), [], `提示框越界: ${JSON.stringify(reported.filter(tip => tip.inside === false))}`)
    // 「提示框要跟着控件」（用户 2026-09-25：行尾图标的气泡被夹到行的另一头，看着脱节）：
    // 宽度上限 280 ⇒ 半宽 140，留 20px 余量；行尾控件用 .tip.end 右对齐锚点才不会挨这一条。
    const far = reported.filter(tip => Math.abs(tip.anchorOffset ?? 0) > 160).map(tip => ({ label: tip.label, anchorOffset: tip.anchorOffset }))
    assert.deepEqual(far, [], `提示框没有跟随控件: ${JSON.stringify(far)}`)
  }
  evidence.tipStyle = tipStyle
  // Room-head tooltips sit at the top of the workspace: the flip must keep them inside.
  const room = await box('.linkle-room')
  const exitTip = await tipBox('.linkle-room .room-actions button[aria-label="退出房间"] ~ .tooltip', '.linkle-room .room-actions button[aria-label="退出房间"]')
  assert.ok(exitTip.height > 0, 'the tooltip under test never rendered')
  assert.ok(inside(exitTip, room), `room-head tooltip escapes the room: ${JSON.stringify({ exitTip })}`)
  evidence.tooltips = { exitTip }
  // 浮动播放条右端的控件同样贴着窗口边：喜欢/随机/上下首的提示必须留在窗口内。
  // 喜欢键的悬停说明已按用户要求去掉，所以不再列入提示框清单。
  const barTips = await tipBounds(["房间随机", "上一首（房间）", "房间下一首"])
  evidence.barTips = barTips
  console.log('BAR_TIPS ' + JSON.stringify(barTips))
  assertTipsInside(barTips)
  await js(`document.getElementById('harness-tooltip-visible')?.remove()`)

  // 滚动条必须走自绘（webkit）这条路，否则 Windows 会给标准细滚动条画上下的三角按钮，
  // 而 `::-webkit-scrollbar-button` 对标准滚动条无效（用户 2026-09-24 第二次反馈）。
  // 自绘路径的判据：滑块槽宽度正好等于声明的 10px。
  const scrolling = await js(`(() => {
    const node = document.querySelector('.linkle-room .lyric-scroll')
    if (!node) return null
    return { gutter: node.offsetWidth - node.clientWidth, overflow: node.scrollHeight - node.clientHeight }
  })()`)
  evidence.scrollbar = scrolling
  console.log('SCROLLBAR ' + JSON.stringify(scrolling))
  assert.ok(scrolling, '找不到歌词滚动容器')
  assert.ok(scrolling.overflow <= 0 || scrolling.gutter === 10, `歌词滚动条没走自绘路径（三角按钮仍会画出来）: ${JSON.stringify(scrolling)}`)

  // 点歌: the platform picker must be a themed Fluent dropdown, not a native select.
  await js(`document.querySelector('.linkle-room button[aria-label="点歌"]').click()`)
  await until(() => js(`Boolean(document.querySelector('.linkle-room .platform-picker'))`), 'search panel')
  const nativeSelects = await js(`document.querySelectorAll('.linkle-room select').length`)
  assert.equal(nativeSelects, 0, 'a native <select> is still rendered in the room')
  // 任务列不该在内容没超时出现滚动条（旧 `min-height:100%` 与面板头相加必然溢出，
  // 于是空列表也常驻一条滚动条，紧挨分割线看着像重复的拖条——用户 2026-09-25）。
  const taskScroll = await js(`(() => { const node = document.querySelector('.linkle-room .task'); return { over: node.scrollHeight - node.clientHeight, body: document.querySelector('.linkle-room .task > .panel-body')?.getBoundingClientRect().height ?? null } })()`)
  evidence.taskScroll = taskScroll
  console.log('TASK_SCROLL ' + JSON.stringify(taskScroll))
  assert.ok(taskScroll.over <= 1, `任务列在内容未溢出时出现滚动条: ${JSON.stringify(taskScroll)}`)
  await wait(200)
  await shot('04-search-panel')
  // The Fluent dropdown can ignore the first synthetic click while the panel is still
  // settling, so retry before declaring it broken.
  let opened = false
  for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
    await js(`document.querySelector('.linkle-room .platform-picker [role="combobox"]')?.click()`)
    await wait(350)
    opened = await js(`Boolean(document.querySelector('[role="listbox"]'))`)
  }
  const listbox = await js(`(() => { const node = document.querySelector('[role="listbox"]'); if (!node) return null; const rect = node.getBoundingClientRect(); return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, options: node.querySelectorAll('[role="option"]').length } })() `)
  evidence.platformPicker = listbox
  await shot('05-platform-dropdown')
  assert.ok(listbox && listbox.options > 0, `platform dropdown did not open: ${JSON.stringify(listbox)}`)

  // 搜索面板：结果行要有封面（网页端有；此前只有文字行，用户截图里看着像留白）
  await fill('搜索曲目', 'fixture')
  await js(`document.querySelector('.linkle-room .searchbar button[type="submit"]').click()`)
  // 等真正的 <img>，不是封面位：位先渲染、data URL 后到，等位会偶发假阴性。
  await until(() => js(`Boolean(document.querySelector('.linkle-room .song .rowcover img'))`), 'search result rows with covers')
  const searchCovers = await js(`(() => {
    const rows = Array.from(document.querySelectorAll('.linkle-room .song'))
    return { rows: rows.length, covers: rows.filter(row => row.querySelector('.rowcover')).length, images: document.querySelectorAll('.linkle-room .rowcover img').length }
  })()`)
  evidence.searchCovers = searchCovers
  console.log('SEARCH_COVERS ' + JSON.stringify(searchCovers))
  assert.ok(searchCovers.covers >= 1, `搜索行没有封面位: ${JSON.stringify(searchCovers)}`)
  assert.ok(searchCovers.images >= 1, `封面图没取到（仍是占位图标）: ${JSON.stringify(searchCovers)}`)
  await shot('19-search-covers')
  // 行尾图标键的提示框必须落在控件正上方附近（右对齐锚点）。测量需要气泡可见：
  // 前面那段强制显示的样式已在 barTips 之后移除，这里临时再挂一次。
  await js(`(() => { const style = document.createElement('style'); style.id = 'harness-tooltip-visible'; style.textContent = '.linkle-room .tooltip{display:block !important}'; document.head.append(style); return true })()`)
  const rowTips = await tipBounds(['加入队列：Fixture track 1'])
  await js(`document.getElementById('harness-tooltip-visible')?.remove()`)
  evidence.rowTips = rowTips
  console.log('ROW_TIPS ' + JSON.stringify(rowTips))
  assertTipsInside(rowTips)
  // 分页（用户 2026-09-25 裁决用「加载更多」）：夹具按 offset/limit 回 45 条（20/20/5），
  // 断言点一次追加一页、到底后按钮消失。
  const pagingStep = async () => js(`(() => {
    const body = document.querySelector('.linkle-room .panel-body')
    const sentinel = document.querySelector('.linkle-room .load-sentinel')
    return {
      rows: document.querySelectorAll('.linkle-room .song').length,
      button: Boolean(Array.from(document.querySelectorAll('.linkle-room button')).find(node => node.textContent.trim() === '加载更多')),
      sentinel: sentinel ? sentinel.textContent.trim() : null,
      top: Boolean(document.querySelector('.linkle-room .panel-top')),
      scrollTop: Math.round(body.scrollTop),
    }
  })()`)
  const scrollToEnd = () => js(`(() => { const body = document.querySelector('.linkle-room .panel-body'); body.scrollTop = body.scrollHeight; return true })()`)
  const firstPage = await pagingStep()
  assert.equal(firstPage.rows, 20, `首页不是一页 20 条: ${JSON.stringify(firstPage)}`)
  // 翻页按钮已撤（用户 2026-09-25）：改成滚到列表末尾自动续页。
  assert.equal(firstPage.button, false, `「加载更多」按钮还在: ${JSON.stringify(firstPage)}`)
  await scrollToEnd()
  await until(() => js(`document.querySelectorAll('.linkle-room .song').length >= 40`), 'second page appended by scrolling')
  const secondPage = await pagingStep()
  assert.equal(secondPage.rows, 40, `第二页没有追加到 40 条: ${JSON.stringify(secondPage)}`)
  await scrollToEnd()
  // 「只在停止滚动时出现」（用户 2026-09-25）：滚动刚发生时不能立刻出现。
  await wait(150)
  const topWhileScrolling = await js(`Boolean(document.querySelector('.linkle-room .panel-top'))`)
  evidence.searchTopScrolling = topWhileScrolling
  console.log('SEARCH_TOP_SCROLLING ' + JSON.stringify({ top: topWhileScrolling }))
  assert.equal(topWhileScrolling, false, `滚动中「回到顶部」就已经出现: ${JSON.stringify({ top: topWhileScrolling })}`)
  await until(() => js(`document.querySelectorAll('.linkle-room .song').length >= 45`), 'last page appended by scrolling')
  await until(() => js(`Boolean(document.querySelector('.linkle-room .panel-top'))`), 'back-to-top after scrolling stops')
  await wait(200)
  const lastPage = await pagingStep()
  evidence.searchPaging = { firstPage, secondPage, lastPage }
  console.log('SEARCH_PAGING ' + JSON.stringify(evidence.searchPaging))
  assert.equal(lastPage.rows, 45, `末页不是 45 条: ${JSON.stringify(lastPage)}`)
  assert.equal(lastPage.sentinel, '', `到底后哨兵还在提示: ${JSON.stringify(lastPage)}`)
  assert.equal(lastPage.top, true, `滚下去之后没有「回到顶部」浮标: ${JSON.stringify(lastPage)}`)
  await shot('29-search-paging')
  await js(`document.querySelector('.linkle-room .panel-top').click()`)
  await until(() => js(`document.querySelector('.linkle-room .panel-body').scrollTop <= 4 && !document.querySelector('.linkle-room .panel-top')`), 'jumped back to top')
  const afterTop = await pagingStep()
  evidence.searchTop = { scrollTop: afterTop.scrollTop, top: afterTop.top }
  console.log('SEARCH_TOP ' + JSON.stringify(evidence.searchTop))
  assert.equal(afterTop.top, false, `回到顶部后浮标没有收起: ${JSON.stringify(afterTop)}`)
  // 专辑视图（后端 §14.1）：只按能力位点灯；曲目原地展开、整张入队。
  const albumTabs = await js(`(() => ({ tabs: Array.from(document.querySelectorAll('.linkle-room .pl-seg button')).map(node => node.textContent.trim()) }))()`)
  evidence.albumTabs = albumTabs
  console.log('ALBUM_TABS ' + JSON.stringify(albumTabs))
  assert.deepEqual(albumTabs.tabs, ['歌曲', '专辑'], `专辑 tab 没有按能力位点灯: ${JSON.stringify(albumTabs)}`)
  // 搜索类型分页签与搜索行之间必须有间距（用户 2026-09-25 圈出「两个控件挨得太近」）。
  const searchSpacing = await js(`(() => {
    const tabs = document.querySelector('.linkle-room .search-tabs')
    const bar = document.querySelector('.linkle-room .searchbar')
    if (!tabs || !bar) return null
    const t = tabs.getBoundingClientRect(), b = bar.getBoundingClientRect()
    return { gap: +(b.top - t.bottom).toFixed(1), tabsMargin: getComputedStyle(tabs).marginBottom }
  })()`)
  evidence.searchSpacing = searchSpacing
  console.log('SEARCH_SPACING ' + JSON.stringify(searchSpacing))
  assert.ok(searchSpacing && searchSpacing.gap >= 10, `分页签与搜索行之间没有间距: ${JSON.stringify(searchSpacing)}`)
  await js(`Array.from(document.querySelectorAll('.linkle-room .pl-seg button')).find(node => node.textContent.trim() === '专辑').click()`)
  await wait(200)
  await js(`document.querySelector('.linkle-room .searchbar button[type="submit"]').click()`)
  await until(() => js(`document.querySelectorAll('.linkle-room .song.with-cover').length >= 20`), 'album first page')
  await wait(400)
  const albumPage = await js(`(() => {
    const rows = Array.from(document.querySelectorAll('.linkle-room .song.with-cover'))
    const sentinel = document.querySelector('.linkle-room .load-sentinel')
    const first = rows[0]
    return {
      rows: rows.length,
      more: sentinel ? sentinel.textContent.trim() : null,
      first: first ? first.textContent.trim().slice(0, 60) : null,
      covers: rows.filter(row => row.querySelector('.rowcover img')).length,
    }
  })()`)
  evidence.albumPage = albumPage
  console.log('ALBUM_SEARCH ' + JSON.stringify(albumPage))
  assert.equal(albumPage.rows, 20, `专辑首页不是 20 张: ${JSON.stringify(albumPage)}`)
  assert.match(String(albumPage.more), /还有 5 张/, `专辑翻页没有按 total 显示剩余: ${JSON.stringify(albumPage)}`)
  assert.ok(albumPage.covers >= 1, `专辑行没有封面: ${JSON.stringify(albumPage)}`)
  await scrollToEnd()
  await until(() => js(`document.querySelectorAll('.linkle-room .song.with-cover').length >= 25`), 'album second page by scrolling')
  await wait(300)
  const albumDone = await js(`(() => ({
    rows: document.querySelectorAll('.linkle-room .song.with-cover').length,
    more: document.querySelector('.linkle-room .load-sentinel')?.textContent?.trim() ?? null,
  }))()`)
  evidence.albumDone = albumDone
  console.log('ALBUM_PAGING ' + JSON.stringify(albumDone))
  assert.equal(albumDone.rows, 25, `专辑末页不是 25 张: ${JSON.stringify(albumDone)}`)
  assert.equal(albumDone.more, '', `专辑到底后哨兵还在提示: ${JSON.stringify(albumDone)}`)
  // 原地展开曲目（契约不分页）+ 整张入队
  await js(`Array.from(document.querySelectorAll('.linkle-room .song.with-cover button')).find(node => (node.getAttribute('aria-label') ?? '').startsWith('展开')).click()`)
  await until(() => js(`document.querySelectorAll('.linkle-room .album-songs .song').length >= 1`), 'album songs expanded')
  const albumSongs = await js(`(() => ({
    rows: document.querySelectorAll('.linkle-room .album-songs .song').length,
    label: document.querySelector('.linkle-room .album-songs')?.getAttribute('aria-label') ?? null,
  }))()`)
  evidence.albumSongs = albumSongs
  console.log('ALBUM_SONGS ' + JSON.stringify(albumSongs))
  assert.equal(albumSongs.rows, 3, `专辑曲目不是 3 首: ${JSON.stringify(albumSongs)}`)
  await shot('30-album-search')
  await js(`Array.from(document.querySelectorAll('.linkle-room .song.with-cover button')).find(node => (node.getAttribute('aria-label') ?? '').startsWith('整张加入')).click()`)
  // 等终态：pending 文案是「正在把…」，「已把…」/「失败」才算有结论。
  await until(async () => {
    const text = await js(`document.querySelector('.linkle-room .notice')?.textContent ?? ''`)
    return /已把|失败/.test(text)
  }, 'enqueue album ack', 15000)
  const albumEnqueue = await js(`(() => ({ notice: document.querySelector('.linkle-room .notice')?.textContent ?? null }))()`)
  evidence.albumEnqueue = albumEnqueue
  console.log('ALBUM_ENQUEUE ' + JSON.stringify(albumEnqueue))
  assert.match(String(albumEnqueue.notice), /已把「Fixture Album 1」整张加入队列/, `整张入队没有 ack 文案: ${JSON.stringify(albumEnqueue)}`)
  // 整张入队的落点证据从队列面板取：分栏里的「接下来」列表已随分栏删除（用户 2026-09-25），
  // 队列面板现在是唯一的队列视图，那 3 首必须真的在里面。
  await js(`document.querySelector('.linkle-room button[aria-label="播放队列"]').click()`)
  await until(() => js(`document.querySelector('.linkle-room .panel-head strong')?.textContent === '播放队列'`), 'queue panel after album enqueue')
  const albumQueue = await js(`(() => { const rows = Array.from(document.querySelectorAll('.linkle-room .panel-body .song')); return { rows: rows.length, albumTracks: rows.filter(row => (row.textContent ?? '').includes('Album 9000 track')).length } })()`)
  evidence.albumQueue = albumQueue
  console.log('ALBUM_QUEUE ' + JSON.stringify(albumQueue))
  assert.equal(albumQueue.albumTracks, 3, `整张加入后队列面板里不是 3 首专辑曲目: ${JSON.stringify(albumQueue)}`)
  await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await js(`document.querySelector('.linkle-room button[aria-label="点歌"]').click()`)
  await wait(200)

  // 给「房间历史」造内容：从管理端 socket 连推两首（客户端当前曲目会前进——夹具对任何 id
  // 都返回同一份歌词，所以后面的歌词断言不受影响）。历史是服务端记录，必须真的播过才有。
  for (let step = 0; step < 2; step += 1) {
    service.adminSocket.send(JSON.stringify({ type: 'control.next', roomId: 'lounge', payload: {} }))
    await wait(700)
  }
  // 协议层断言（不依赖界面）：history.list → history.page，形状/倒序/越界语义都在这里钉住。
  const historyPage = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('history.page timeout')), 8000)
    const onMessage = data => {
      try {
        const event = JSON.parse(String(data))
        if (event.type !== 'history.page') return
        clearTimeout(timer)
        service.adminSocket.off('message', onMessage)
        resolve(event.payload)
      } catch { /* 非 JSON 帧忽略 */ }
    }
    service.adminSocket.on('message', onMessage)
    service.adminSocket.send(JSON.stringify({ type: 'history.list', roomId: 'lounge', payload: { offset: 0, limit: 5 } }))
  })
  const historyOverflow = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('history.page(overflow) timeout')), 8000)
    const onMessage = data => {
      try {
        const event = JSON.parse(String(data))
        if (event.type !== 'history.page') return
        clearTimeout(timer)
        service.adminSocket.off('message', onMessage)
        resolve(event.payload)
      } catch { /* 忽略 */ }
    }
    service.adminSocket.on('message', onMessage)
    service.adminSocket.send(JSON.stringify({ type: 'history.list', roomId: 'lounge', payload: { offset: 9999, limit: 5 } }))
  })
  const historyProtocol = await (async () => {
    const items = Array.isArray(historyPage?.items) ? historyPage.items : null
    const times = items ? items.map(item => item?.playedAt ?? 0) : []
    const first = items && items[0] ? items[0] : null
    return {
      total: typeof historyPage?.total === 'number' ? historyPage.total : null,
      returned: items ? items.length : null,
      keys: first ? Object.keys(first).sort().join(',') : null,
      musicKeys: first?.music ? Object.keys(first.music).sort().join(',') : null,
      newestFirst: times.every((value, index) => index === 0 || times[index - 1] >= value),
      enqueuerName: first?.enqueuerName ?? null,
      overflowItems: Array.isArray(historyOverflow?.items) ? historyOverflow.items.length : null,
    }
  })()
  evidence.historyProtocol = historyProtocol
  console.log('HISTORY_LIST ' + JSON.stringify(historyProtocol))
  assert.ok(historyProtocol.returned !== null && historyProtocol.returned >= 1, `history.list 没有返回条目: ${JSON.stringify(historyProtocol)}`)
  assert.equal(historyProtocol.keys, 'enqueuerName,enqueuerPublicId,id,music,playedAt', `history 条目字段不对: ${JSON.stringify(historyProtocol)}`)
  assert.equal(historyProtocol.musicKeys, 'artists,coverUrl,duration,id,name,platform', `history.music 不是元数据形状: ${JSON.stringify(historyProtocol)}`)
  assert.ok(historyProtocol.newestFirst, `history 不是按时间倒序: ${JSON.stringify(historyProtocol)}`)
  assert.equal(historyProtocol.overflowItems, 0, `翻过末尾应是空数组: ${JSON.stringify(historyProtocol)}`)
  await js(`document.querySelector('.linkle-room button[aria-label="歌单"]').click()`)
  await until(() => js(`Boolean(document.querySelector('.linkle-room .pl-panel'))`), 'playlists panel')
  // 默认落在「房间历史」（本机记录的房间播放历史，用户 2026-09-25 要求把房间歌单换成它）。
  await until(() => js(`Boolean(document.querySelector('.linkle-room .pl-hist') || document.querySelector('.linkle-room .pl-row') || document.querySelector('.linkle-room .pl-empty'))`), 'playlists panel settled')
  await wait(300)
  const historyScope = await js(`(() => {
    const rows = Array.from(document.querySelectorAll('.linkle-room .pl-hist-row'))
    const first = rows[0]
    return {
      pill: Array.from(document.querySelectorAll('.linkle-room .pl-seg button')).map(button => button.textContent.trim()),
      rows: rows.length,
      actions: first ? Array.from(first.querySelectorAll('button')).map(button => (button.getAttribute('aria-label') ?? button.textContent).trim()) : [],
      timeText: first ? (first.querySelector('.pl-num')?.textContent ?? '') : null,
      head: document.querySelector('.linkle-room .pl-hist-head .pl-cap')?.textContent ?? null,
      by: first?.querySelector('.pl-tinfo small')?.textContent ?? null,
    }
  })()`)
  evidence.historyScope = historyScope
  console.log('HISTORY_SCOPE ' + JSON.stringify(historyScope))
  assert.deepEqual(historyScope.pill, ['房间历史', '我的歌单'], `范围段文案不对: ${JSON.stringify(historyScope)}`)
  assert.ok(historyScope.rows >= 1, `房间历史没有记到已播曲目: ${JSON.stringify(historyScope)}`)
  assert.ok(historyScope.actions.some(label => label.startsWith('加入队列')) && historyScope.actions.some(label => label.startsWith('收藏')), `历史行缺少加入队列/收藏: ${JSON.stringify(historyScope)}`)
  assert.match(String(historyScope.head), /已加载 \d+ \/ \d+ 条/, `房间历史没有走服务端分页: ${JSON.stringify(historyScope)}`)
  assert.match(String(historyScope.by), /点歌者 acceptance/, `历史行没有显示服务端返回的点歌者名字（LEFT JOIN 结果）: ${JSON.stringify(historyScope)}`)
  assert.ok(String(historyScope.timeText).includes(':'), `历史行没有时间: ${JSON.stringify(historyScope)}`)
  await shot('28-room-history')
  // 切到「我的歌单」：先验空态（必须有新建入口），再用面板内联新建建一个——顺带覆盖新流程。
  await js(`Array.from(document.querySelectorAll('.linkle-room .pl-seg button')).find(button => button.textContent.trim() === '我的歌单')?.click()`)
  await until(() => js(`Boolean(document.querySelector('.linkle-room .pl-empty') || document.querySelectorAll('.linkle-room .pl-row').length > 0)`), 'my playlists settled')
  // 后端 2026-09-25 起会给每个成员维护系统歌单「喜欢的歌曲」（systemKey=liked-songs），
  // 所以"我的歌单"不再保证是空态：要么空态（含新建入口），要么已有系统歌单行。
  const plEmpty = await js(`(() => {
    const empty = document.querySelector('.linkle-room .pl-empty')
    const rows = Array.from(document.querySelectorAll('.linkle-room .pl-row')).map(row => row.textContent.trim().slice(0, 32))
    return {
      text: empty ? empty.textContent.trim().slice(0, 24) : null,
      action: empty ? Boolean(empty.querySelector('button')) : null,
      rows,
      createEntry: Boolean(document.querySelector('.linkle-room .pl-toolbar button[aria-label="新建歌单"]')),
      systemRows: rows.filter(text => text.includes('喜欢的歌曲')).length,
    }
  })()`)
  evidence.playlistsEmpty = plEmpty
  console.log('PLAYLISTS_EMPTY ' + JSON.stringify(plEmpty))
  assert.ok(plEmpty.createEntry, `歌单面板缺少新建入口: ${JSON.stringify(plEmpty)}`)
  if (plEmpty.text) assert.ok(plEmpty.action, `歌单空态缺少新建入口: ${JSON.stringify(plEmpty)}`)
  else assert.ok(plEmpty.rows.length > 0, `歌单既没有空态也没有任何行: ${JSON.stringify(plEmpty)}`)
  // 拉列表期间「新建歌单」是 disabled 的，点下去什么都不发生（与歌单行删除键同一课）。
  await until(() => js(`(() => { const button = document.querySelector('.linkle-room .pl-toolbar button[aria-label="新建歌单"]'); return Boolean(button && !button.disabled) })()`), 'playlist create enabled')
  await js(`document.querySelector('.linkle-room .pl-toolbar button[aria-label="新建歌单"]')?.click()`)
  await until(() => js(`Boolean(document.querySelector('.linkle-room .pl-draft input'))`), 'playlist name input')
  await js(`(() => { const input = document.querySelector('.linkle-room .pl-draft input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '验收歌单'); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await until(() => js(`!Array.from(document.querySelectorAll('.linkle-room .pl-draft button')).find(button => button.textContent.trim() === '创建')?.disabled`), 'playlist create submit enabled')
  await js(`Array.from(document.querySelectorAll('.linkle-room .pl-draft button')).find(button => button.textContent.trim() === '创建')?.click()`)
  await until(() => js(`document.querySelectorAll('.linkle-room .pl-row').length > 0`), 'playlist rows')
  await wait(400)
  // 方案 A（用户 2026-09-25 裁决）：范围段 + 列表上半区 + 详情 + 行尾 ⋯ 菜单 + 面板头导出浮层。
  const playlists = await js(`(() => {
    const rows = Array.from(document.querySelectorAll('.linkle-room .pl-row'))
    const listBox = document.querySelector('.linkle-room .pl-list')?.getBoundingClientRect() ?? null
    const detailBox = document.querySelector('.linkle-room .pl-detail')?.getBoundingClientRect() ?? null
    return {
      rows: rows.length,
      tracks: document.querySelectorAll('.linkle-room .pl-track').length,
      overflow: rows.every(row => row.scrollWidth <= row.clientWidth + 1),
      sideBySide: Boolean(listBox && detailBox && detailBox.left >= listBox.right - 1),
      noOverlap: Boolean(listBox && detailBox && (detailBox.left >= listBox.right - 1 || detailBox.top >= listBox.bottom - 1)),
      hasMenuButton: rows.every(row => Boolean(row.querySelector('.pl-ico'))),
    }
  })()`)
  evidence.playlists = playlists
  console.log('PLAYLISTS ' + JSON.stringify(playlists))
  assert.ok(playlists.rows >= 1, `歌单列表是空的: ${JSON.stringify(playlists)}`)
  assert.ok(playlists.overflow && playlists.noOverlap && playlists.hasMenuButton, `歌单面板结构不对: ${JSON.stringify(playlists)}`)
  // 行尾 ⋯ 菜单：打开 / 全部加入队列 / 导出此歌单
  await js(`(Array.from(document.querySelectorAll('.linkle-room .pl-row')).find(row => row.textContent.includes('验收歌单')) ?? document.querySelector('.linkle-room .pl-row'))?.querySelector('.pl-ico')?.click()`)
  await until(() => js(`Boolean(document.querySelector('.linkle-room .pl-menu'))`), 'playlist row menu')
  const plMenu = await js(`(() => ({ items: Array.from(document.querySelectorAll('.linkle-room .pl-menu button')).map(button => button.textContent.trim()) }))()`)
  evidence.playlistMenu = plMenu
  console.log('PLAYLIST_MENU ' + JSON.stringify(plMenu))
  for (const item of ['打开', '全部加入队列', '导出此歌单…']) assert.ok(plMenu.items.includes(item), `歌单行菜单缺少「${item}」: ${JSON.stringify(plMenu)}`)
  await js(`document.querySelector('.linkle-room .pl-menu button')?.click()`)
  await wait(250)
  // 面板头「导出」→ 浮层：队列与当前歌单两个来源
  await js(`document.querySelector('.linkle-room .pl-toolbar button[aria-label="导出"]')?.click()`)
  await until(() => js(`Boolean(document.querySelector('.linkle-room .pl-pop'))`), 'export popover')
  const exportUi = await js(`(() => {
    const buttons = Array.from(document.querySelectorAll('.linkle-room .pl-pop .pl-fmts button'))
    return {
      labels: buttons.map(button => button.textContent.trim()),
      enabled: buttons.filter(button => !button.disabled).length,
      total: buttons.length,
      caps: Array.from(document.querySelectorAll('.linkle-room .pl-pop .pl-cap')).map(node => node.textContent.trim()),
    }
  })()`)
  evidence.exportUi = exportUi
  console.log('EXPORT_UI ' + JSON.stringify(exportUi))
  for (const label of ['另存为 TXT', '另存为 CSV', '另存为 JSON', '复制 TXT', 'TXT', 'CSV', 'JSON']) {
    assert.ok(exportUi.labels.includes(label), `导出入口缺失: ${label} / ${JSON.stringify(exportUi.labels)}`)
  }
  assert.ok(exportUi.caps.some(cap => cap.startsWith('导出当前队列')), `浮层没有队列来源: ${JSON.stringify(exportUi.caps)}`)
  assert.ok(exportUi.caps.some(cap => cap.startsWith('导出「')), `浮层没有当前歌单来源: ${JSON.stringify(exportUi.caps)}`)
  await shot('27-playlists-export')
  await js(`document.querySelector('.linkle-room .pl-pop-backdrop')?.click()`)
  await wait(200)
  await shot('10-playlists')
  await js(`document.querySelector('.linkle-room button[aria-label="歌单"]').click()`)
  await wait(200)

  // 聊天与成员（方案 B，用户 2026-09-25 裁决）：双栏常驻 + 身份标记 + 自己的消息右对齐。
  await js(`document.querySelector('.linkle-room button[aria-label^="聊天与成员"]').click()`)
  await until(() => js(`Boolean(document.querySelector('.linkle-room .chat-panel'))`), 'chat panel')
  await wait(300)
  const chatShell = await js(`(() => {
    const self = document.querySelector('.linkle-room .member.self')
    return {
      side: Boolean(document.querySelector('.linkle-room .chat-side')),
      members: document.querySelectorAll('.linkle-room .chat-side .member').length,
      self: self ? self.textContent.trim() : null,
      selfMark: self ? self.textContent.includes('我') : false,
      earlier: document.querySelector('.linkle-room .chat-earlier')?.getAttribute('aria-label') ?? null,
      identity: document.querySelector('.linkle-room .chat-panel')?.getAttribute('data-identity') ?? null,
      composer: Boolean(document.querySelector('.linkle-room .chat-composer input')),
    }
  })()`)
  evidence.chatShell = chatShell
  console.log('CHAT_SHELL ' + JSON.stringify(chatShell))
  assert.ok(chatShell.side, `成员栏没有常驻: ${JSON.stringify(chatShell)}`)
  // 隔离夹具这次没把 users.online 送进来（真实服务会给：用户截图里能看到「桌面用户」），
  // 所以有成员时才要求标出本机身份；计数一并打进日志，便于下次对比。
  if (chatShell.members >= 1) assert.ok(chatShell.selfMark, `成员栏没标出本机身份（本地 ID 或服务端账号）: ${JSON.stringify(chatShell)}`)
  else console.log('CHAT_MEMBERS_EMPTY (fixture delivered no users.online)')
  assert.ok(chatShell.composer, `输入区缺失: ${JSON.stringify(chatShell)}`)
  // 先由管理端发一条：验证「别人发的」这条入站路径（列表里出现非 .me 的气泡）。
  service.adminSocket.send(JSON.stringify({ type: 'chat.message', roomId: 'lounge', payload: { content: '管理端发的：应出现在列表里' } }))
  await until(() => js(`document.body.innerText.includes('管理端发的')`), 'incoming chat message', 12000)
  // 再自己发一条：自己的消息必须右对齐（.me），且列表里出现时间分隔。
  await js(`(() => {
    const input = document.querySelector('.linkle-room .chat-composer input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '验收：这条应该右对齐')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await js(`document.querySelector('.linkle-room .chat-composer button[type="submit"]').click()`)
  await wait(1500)
  const chatSend = await js(`(() => {
    const own = document.querySelector('.linkle-room .chatline.me')
    const list = document.querySelector('.linkle-room .chat-scroll')
    const listBox = list ? list.getBoundingClientRect() : null
    const mine = own ? own.getBoundingClientRect() : null
    return {
      lines: Array.from(document.querySelectorAll('.linkle-room .chatline')).map(node => ({ who: node.querySelector('.chat-who')?.textContent ?? null, me: node.classList.contains('me'), text: node.textContent.trim().slice(0, 24) })),
      echoed: document.body.innerText.includes('验收：这条应该右对齐'),
      rightAligned: Boolean(mine && listBox && mine.right <= listBox.right + 1 && mine.left > listBox.left + 20),
      day: document.querySelector('.linkle-room .chat-day')?.textContent ?? null,
      status: document.querySelector('.linkle-room .chat-panel .notice')?.textContent ?? null,
    }
  })()`)
  evidence.chatSend = chatSend
  console.log('CHAT_SEND ' + JSON.stringify(chatSend))
  assert.ok(chatSend.echoed, `自己发的消息没有回到列表: ${JSON.stringify(chatSend)}`)
  assert.ok(chatSend.rightAligned, `自己的消息没有右对齐: ${JSON.stringify(chatSend)}`)
  assert.match(String(chatSend.day), /今天/, `消息缺少时间分隔: ${JSON.stringify(chatSend)}`)
  // 点成员可高亮其发言（B 稿里的交互）；夹具没送 presence 时跳过。
  if (chatShell.members >= 1) {
    await js(`document.querySelector('.linkle-room .chat-side .member')?.click()`)
    await wait(250)
    const chatFocus = await js(`(() => ({ hot: Boolean(document.querySelector('.linkle-room .member.hot')), focused: document.querySelectorAll('.linkle-room .chatline.focus').length }))()`)
    evidence.chatFocus = chatFocus
    console.log('CHAT_FOCUS ' + JSON.stringify(chatFocus))
    assert.ok(chatFocus.hot, `点成员没有进入高亮态: ${JSON.stringify(chatFocus)}`)
    await js(`document.querySelector('.linkle-room .chat-side .member.hot')?.click()`)
  }
  await shot('25-chat-members')
  await js(`document.querySelector('.linkle-room .chat-side .member.hot')?.click()`)
  await js(`document.querySelector('.linkle-room button[aria-label^="聊天与成员"]').click()`)
  await wait(200)

  // 沉浸页是唯一播放界面（分栏已废弃，用户 2026-09-25）：这里不再需要先切视图，
  // 直接断言封面卡、取色背景与 Kawarp 路线选择。
  await until(() => js(`Boolean(document.querySelector('.linkle-room.immersive .imm-art img'))`), 'immersive cover card')
  await wait(900)
  const background = await js(`(() => {
    const cover = document.querySelector('.imm-bg-cover.on')
    const canvas = document.querySelector('.imm-bg-canvas')
    return { coverImage: cover ? cover.style.backgroundImage.slice(0, 30) : null, canvas: canvas ? { width: canvas.width, height: canvas.height, ready: canvas.classList.contains('ready') } : null, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches }
  })()`)
  evidence.background = background
  assert.ok(background.coverImage || background.canvas, `immersive background has neither cover layer nor canvas: ${JSON.stringify(background)}`)

  // The immersive console: the volume track takes the free space before the right
  // cluster instead of a fixed stub.
  const consoleRow = await js(`(() => {
    const slider = document.querySelector('.linkle-room.immersive .grp.volume .slider')
    const volume = document.querySelector('.linkle-room.immersive .grp.volume')
    const extras = document.querySelector('.linkle-room.immersive .grp.extras')
    const transport = document.querySelector('.linkle-room.immersive .controls .grp')
    const controls = document.querySelector('.linkle-room.immersive .controls')
    const column = document.querySelector('.linkle-room.immersive .imm-left')
    if (!slider || !volume || !extras || !controls) return null
    const sliderBox = slider.getBoundingClientRect()
    const volumeBox = volume.getBoundingClientRect()
    const extrasBox = extras.getBoundingClientRect()
    const controlsBox = controls.getBoundingClientRect()
    return { sliderWidth: +sliderBox.width.toFixed(1), gapToExtras: +(extrasBox.left - sliderBox.right).toFixed(1), volumeWidth: +volumeBox.width.toFixed(1), transportWidth: transport ? +transport.getBoundingClientRect().width.toFixed(1) : null, extrasWidth: +extrasBox.width.toFixed(1), controlsWidth: +controlsBox.width.toFixed(1), columnWidth: column ? +column.getBoundingClientRect().width.toFixed(1) : null, volumeFits: volumeBox.right <= controlsBox.right + 0.5, extrasFits: extrasBox.right <= controlsBox.right + 0.5, rows: +controlsBox.height.toFixed(1) }
  })()`)
  evidence.consoleRow = consoleRow
  assert.ok(consoleRow && consoleRow.sliderWidth >= 96, `immersive volume track is still a stub: ${JSON.stringify(consoleRow)}`)
  assert.ok(consoleRow.gapToExtras >= -0.5 && consoleRow.gapToExtras <= 24, `volume track does not use the free space: ${JSON.stringify(consoleRow)}`)
  assert.ok(consoleRow.volumeFits && consoleRow.extrasFits, `console row overflows: ${JSON.stringify(consoleRow)}`)
  await shot('06-immersive')

  // 沉浸下的提示框（用户 2026-09-24「提示框越界」）：底部控件贴着右/下边，提示必须落在
  // 窗口 ∩ 各级裁剪容器的交集里——只看 room 不够，歌词栏本身是 overflow:hidden。
  await js(`(() => { const style = document.createElement('style'); style.id = 'harness-tooltip-visible'; style.textContent = '.linkle-room .tooltip{display:block !important}'; document.head.append(style) })()`)
  const immersiveTips = await tipBounds(["歌词译文", "歌词字号减小", "歌词字号增大", "房间随机", "暂停整个房间", "上一首（房间）", "房间下一首", "本机静音"])
  evidence.immersiveTips = immersiveTips
  console.log('IMMERSIVE_TIPS ' + JSON.stringify(immersiveTips))
  assertTipsInside(immersiveTips)
  await shot('26-immersive-tips-visible')
  await js(`document.getElementById('harness-tooltip-visible')?.remove()`)

  // 喜欢（用户 2026-09-24）：点下去要进按下态 + 图标换实心，而不是只刷新一次。
  // 喜欢的心跳（handoff §15.1）：likedUserIds 按当前曲目作用域，所以首点后数组里就是本机 publicId
  // ⇒ 按下态（likedByMe）一定会回来；这里只断言"点了就亮"。
  // 喜欢键已搬到封面悬浮层（用户 2026-09-25）：点击目标与按下态都在 .imm-art 上。
  // 悬浮本身要量三次：默认不可见 → CDP 强制 hover 出现（灰遮罩 + 红心）→ 深浅色下遮罩值不同。
  /** 读回一张 PNG 的像素统计（用于"遮罩压上去了没有""图标画出来了没有"这类必须看像素的判据）。 */
  const pixelsOf = async file => {
    const image = nativeImage.createFromPath(file)
    const size = image.getSize()
    const bitmap = image.toBitmap() // BGRA
    let sum = 0, count = 0, bright = 0
    for (let i = 0; i + 3 < bitmap.length; i += 4) {
      const luma = (0.2126 * bitmap[i + 2] + 0.7152 * bitmap[i + 1] + 0.0722 * bitmap[i]) / 255
      sum += luma; count += 1
      if (luma > 0.9) bright += 1
    }
    return { w: size.width, h: size.height, meanLuma: +(sum / Math.max(1, count)).toFixed(3), brightPct: +(100 * bright / Math.max(1, count)).toFixed(2) }
  }
  /**
   * 强制 hover 并量封面悬浮层。
   * `media` 可传 'no-preference' / 'reduce' 模拟 prefers-reduced-motion —— 这台机器的系统设置就是
   * "减少动效"，所以"正常环境的 250ms 入场"必须靠模拟才量得到（否则永远读到被兜底规则压成的 1ms）。
   */
  const hoverCover = async (shotName, options = {}) => {
    const name = shotName ?? '32-cover-like-hover'
    const media = options.media ?? null
    // 基准帧先拍：此时没有 hover。必须和下面的 hover 帧同一函数内成对取，否则调用方可能撞上过渡半途。
    const plainShot = shotName ? await shotRect(`${name}-plain-rect`, '.linkle-room .imm-art') : null
    const plainPixels = plainShot ? await pixelsOf(plainShot.path) : null
    // 入场动效的"起点"也在这里量：必须在强制 hover 之前，否则会读到过渡半途的值。
    const plainIconScale = await js(`(() => {
      const icon = document.querySelector('.linkle-room .imm-like-ico')
      if (!icon) return null
      const value = getComputedStyle(icon).transform
      return !value || value === 'none' ? 1 : new DOMMatrixReadOnly(value).a
    })()`)
    const debuggerApi = browserWindow.webContents.debugger
    try {
      debuggerApi.attach('1.3')
      await debuggerApi.sendCommand('DOM.enable')
      await debuggerApi.sendCommand('CSS.enable')
      if (media) await debuggerApi.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: media }] })
      const { root } = await debuggerApi.sendCommand('DOM.getDocument', { depth: 1 })
      const { nodeId } = await debuggerApi.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '.linkle-room .imm-art' })
      await debuggerApi.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] })
      await wait(250)
      const probe = await js(`(() => {
        const art = document.querySelector('.linkle-room .imm-art')
        const like = art?.querySelector('.imm-like')
        const icon = like?.querySelector('.imm-like-ico svg')
        const style = getComputedStyle(art)
        return {
          scrim: style.getPropertyValue('--art-hover-scrim').trim(),
          fg: style.getPropertyValue('--art-hover-fg').trim(),
          layerOpacity: like ? Number(getComputedStyle(like).opacity) : null,
          iconPresent: Boolean(icon),
          iconWidth: icon ? Math.round(icon.getBoundingClientRect().width) : null,
          // 入场动效：图标缩放与层过渡（用户 2026-09-25 要"对应入场动效"）。缩放用 DOMMatrix 解析成数字，
          // 免得在 harness 里写正则解析 matrix。注意：这里整段是外层模板字面量，注释里也别写美元花括号插值。
          iconScale: icon ? (() => { const value = getComputedStyle(icon.parentElement).transform; return !value || value === 'none' ? 1 : new DOMMatrixReadOnly(value).a })() : null,
          layerTransitionMs: like ? parseFloat(getComputedStyle(like).transitionDuration) * 1000 : null,
          reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
          // 悬浮层必须正好盖住封面：.imm-art 少了 position:relative 时它会认 .imm-left 做祖先，铺满整列。
          artBox: art ? art.getBoundingClientRect().toJSON() : null,
          artInner: art ? { w: art.clientWidth, h: art.clientHeight, x: art.getBoundingClientRect().left + art.clientLeft, y: art.getBoundingClientRect().top + art.clientTop } : null,
          likeBox: like ? like.getBoundingClientRect().toJSON() : null,
        }
      })()`)
      if (shotName) await shot(name)
      // 同一矩形、两个状态做像素对比：整窗截图会随窗口尺寸/DPI 漂移，裁剪到封面就没这问题。
      const rectShot = shotName ? await shotRect(`${name}-rect`, '.linkle-room .imm-art') : null
      if (rectShot) {
        probe.rect = rectShot.rect
        probe.path = rectShot.path
        probe.pixels = await pixelsOf(rectShot.path)
      }
      probe.plainPixels = plainPixels
      probe.plainIconScale = plainIconScale
      await debuggerApi.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
      await wait(150)
      return probe
    } finally {
      // 媒体模拟是会话级的：不显式清掉会污染后续所有量测。
      if (debuggerApi.isAttached() && media) await debuggerApi.sendCommand('Emulation.setEmulatedMedia', { features: [] }).catch(() => undefined)
      if (debuggerApi.isAttached()) debuggerApi.detach()
    }
  }
  const coverLikeIdle = await js(`(() => {
    const art = document.querySelector('.linkle-room .imm-art')
    const like = art?.querySelector('.imm-like')
    return { present: Boolean(like), opacity: like ? Number(getComputedStyle(like).opacity) : null, pressed: art?.getAttribute('aria-pressed') ?? null }
  })()`)
  const likeBefore = await js(`(() => { const button = document.querySelector('.linkle-room .imm-art'); return button ? { pressed: button.getAttribute('aria-pressed'), icon: (button.querySelector('.imm-like-ico svg')?.innerHTML ?? '').slice(0, 80) } : null })()`)
  assert.ok(coverLikeIdle.present && coverLikeIdle.opacity === 0, `封面悬浮层默认不该可见: ${JSON.stringify(coverLikeIdle)}`)
  assert.equal(coverLikeIdle.pressed, 'false', `点之前封面不该是按下态: ${JSON.stringify(coverLikeIdle)}`)
  // 点红心不该让播放条闪成禁用态（用户 2026-09-25）：适配器"一次只许一条命令"的限制只该作用在
  // 播放类命令上，like/unlike 在飞时那排键必须保持可点。
  // ★ 这个窗口只有一次往返那么长（本机几十毫秒），sleep 之后再看是**测不到**的 —— 必须用
  //   MutationObserver 全程盯 attribute 变化，再加 rAF 采样兜住 CSS 侧的透明度变化。
  const transportBefore = await js(`(() => {
    const text = ['暂停整个房间', '上一首（房间）', '房间下一首', '房间随机']
    return text.map(label => { const node = document.querySelector('.linkle-room button[aria-label="' + label + '"]'); return node ? !node.disabled : null })
  })()`)
  await js(`(() => {
    const labels = ['暂停整个房间', '上一首（房间）', '房间下一首', '房间随机']
    const record = { disabledSeen: [], minOpacity: 1, samples: 0, active: true }
    window.__transportFlicker = record
    const nodes = labels.map(label => document.querySelector('.linkle-room button[aria-label="' + label + '"]')).filter(Boolean)
    const sample = () => {
      record.samples += 1
      for (const node of nodes) {
        if (node.disabled) record.disabledSeen.push(node.getAttribute('aria-label'))
        const opacity = Number(getComputedStyle(node).opacity)
        if (opacity < record.minOpacity) record.minOpacity = opacity
      }
    }
    const observer = new MutationObserver(sample)
    for (const node of nodes) observer.observe(node, { attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'class', 'style'] })
    const started = performance.now()
    const tick = () => {
      sample()
      const pressed = document.querySelector('.linkle-room .imm-art')?.getAttribute('aria-pressed')
      if (performance.now() - started > 8000 || (pressed === 'true' && performance.now() - started > 1200)) {
        observer.disconnect(); record.active = false; return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return true
  })()`)
  await js(`(() => { const art = document.querySelector('.linkle-room .imm-art'); if (art) art.click(); return true })()`)
  await until(() => js(`window.__transportFlicker && window.__transportFlicker.active === false`), 'flicker sampler finished', 20000)
  const transportDuring = await js(`(() => { const record = window.__transportFlicker; return { disabledSeen: record.disabledSeen, minOpacity: record.minOpacity, samples: record.samples } })()`)
  delete transportDuring.active
  evidence.transportFlicker = { before: transportBefore, during: transportDuring }
  console.log('TRANSPORT_NO_FLICKER ' + JSON.stringify(evidence.transportFlicker))
  assert.equal(transportDuring.disabledSeen.length, 0,
    `点红心时播放条被压成禁用态（用户报的"底下闪一下"）: ${JSON.stringify(evidence.transportFlicker)}`)
  assert.ok(Number(transportDuring.minOpacity) >= 0.99,
    `点红心时播放条变淡（.i32:disabled 的 opacity 生效了）: ${JSON.stringify(evidence.transportFlicker)}`)
  assert.ok(transportDuring.samples > 5, `采样次数太少，等于没测到: ${JSON.stringify(evidence.transportFlicker)}`)
  await until(() => js(`document.querySelector('.linkle-room .imm-art')?.getAttribute('aria-pressed') === 'true'`), 'like round-trip for the flicker check', 20000)
  // 复位：上面那次点击已经把喜欢点上了，这里取消掉，后面的用例仍从"未喜欢"开始。
  await js(`(() => { const art = document.querySelector('.linkle-room .imm-art'); if (art) art.click(); return true })()`)
  await until(() => js(`document.querySelector('.linkle-room .imm-art')?.getAttribute('aria-pressed') === 'false'`), 'like reset for the later like cases', 20000)

  const coverUnlikeHover = await hoverCover('32-cover-like-hover')
  assert.equal(coverUnlikeHover.layerOpacity, 1, `悬浮封面没出现灰遮罩: ${JSON.stringify(coverUnlikeHover)}`)
  assert.ok(coverUnlikeHover.iconPresent, `悬浮封面没出现红心: ${JSON.stringify(coverUnlikeHover)}`)
  assert.ok((coverUnlikeHover.iconWidth ?? 0) >= 24, `悬浮红心太小: ${JSON.stringify(coverUnlikeHover)}`)
  // 遮罩的几何必须等于封面本身（2026-09-25：.imm-art 缺 position:relative 时会铺满整列）。
  const coverInner = coverUnlikeHover.artInner, likeBox = coverUnlikeHover.likeBox
  assert.ok(coverInner && likeBox, `量不到封面/遮罩几何: ${JSON.stringify(coverUnlikeHover)}`)
  assert.ok(Math.abs(coverInner.w - likeBox.width) <= 2 && Math.abs(coverInner.h - likeBox.height) <= 2,
    `悬浮遮罩没有正好盖住封面（尺寸差说明定位祖先/网格轨道不对）: ${JSON.stringify({ cover: [coverInner.w, coverInner.h], scrim: [likeBox.width, likeBox.height] })}`)
  assert.ok(Math.abs(coverInner.x - likeBox.left) <= 2 && Math.abs(coverInner.y - likeBox.top) <= 2,
    `悬浮遮罩没对齐封面左上角: ${JSON.stringify({ cover: [coverInner.x, coverInner.y], scrim: [likeBox.left, likeBox.top] })}`)
  const coverIdlePixels = await js(`(() => {
    const art = document.querySelector('.linkle-room .imm-art')
    return art ? { w: art.clientWidth, h: art.clientHeight } : null
  })()`)
  // 入场动效要有"从哪来"：默认帧图标是缩小的（scale<1），悬浮帧归位；且层上挂着非零时长的过渡。
  const idleScaleValue = coverUnlikeHover.plainIconScale
  const hoverScale = coverUnlikeHover.iconScale
  // 入场动效分两条路径验（本机系统设置就是"减少动效"，所以两种都要显式模拟，不能靠环境）：
  //   no-preference ⇒ 有一段真实的入场过渡（本仓 --f2-dur-fast = 250ms）
  //   reduce        ⇒ 被无障碍兜底压到 ~1ms（动画等于关掉，但仍保留状态切换）
  const coverMotionNormal = await hoverCover(null, { media: 'no-preference' })
  const coverMotionReduced = await hoverCover(null, { media: 'reduce' })
  evidence.coverLikeMotion = {
    idleScale: idleScaleValue, hoverScale,
    transitionMs: coverMotionNormal.layerTransitionMs,
    transitionMsReduced: coverMotionReduced.layerTransitionMs,
    reducedMotionAtRuntime: coverUnlikeHover.reducedMotion === true,
  }
  console.log('COVER_LIKE_MOTION ' + JSON.stringify(evidence.coverLikeMotion))
  assert.ok(idleScaleValue !== null && idleScaleValue < 0.95, `入场的起始缩放没生效（默认态应是缩小态）: ${JSON.stringify(evidence.coverLikeMotion)}`)
  assert.ok(hoverScale !== null && hoverScale >= 0.99, `悬浮后图标没归位到 1: ${JSON.stringify(evidence.coverLikeMotion)}`)
  assert.ok((coverMotionNormal.layerTransitionMs ?? 0) >= 100,
    `正常动效设置下封面悬浮层没有入场过渡（该有 250ms）: ${JSON.stringify(evidence.coverLikeMotion)}`)
  assert.ok((coverMotionReduced.layerTransitionMs ?? 999) <= 2,
    `reduced-motion 下入场过渡没被压掉（无障碍兜底失效）: ${JSON.stringify(evidence.coverLikeMotion)}`)
  evidence.coverLikeHover = { idle: coverLikeIdle, dark: coverUnlikeHover, idlePixels: coverIdlePixels }
  console.log('COVER_LIKE_HOVER ' + JSON.stringify(evidence.coverLikeHover))
  // 像素判据（用户要的是"看得出遮罩"）：深色主题下悬浮态必须明显比无遮罩时暗。
  // 两张图是同一函数内、同一矩形成对取的（基准帧在强制 hover 之前），不受窗口尺寸/DPI 漂移影响。
  assert.ok(coverUnlikeHover.pixels && coverUnlikeHover.plainPixels, `量不到封面裁切图像素: ${JSON.stringify(coverUnlikeHover.pixels)}`)
  evidence.coverLikePixels = { hover: coverUnlikeHover.pixels, plain: coverUnlikeHover.plainPixels }
  console.log('COVER_LIKE_PIXELS ' + JSON.stringify(evidence.coverLikePixels))
  assert.ok(coverUnlikeHover.pixels.meanLuma < coverUnlikeHover.plainPixels.meanLuma - 0.05,
    `深色下悬浮遮罩没有真的压暗封面: ${JSON.stringify(evidence.coverLikePixels)}`)
  await js(`document.querySelector('.linkle-room .imm-art').click()`)
  await until(() => js(`document.querySelector('.linkle-room .imm-art')?.getAttribute('aria-pressed') === 'true'`), 'like round-trip', 20000)
  const likeAfter = await js(`(() => { const button = document.querySelector('.linkle-room .imm-art'); const style = getComputedStyle(button); return { pressed: button.getAttribute('aria-pressed'), icon: (button.querySelector('.imm-like-ico svg')?.innerHTML ?? '').slice(0, 80), color: style.color, background: style.backgroundColor, note: document.querySelector('.linkle-room .control-note')?.textContent?.trim() ?? null } })()`)
  const coverLikedHover = await hoverCover('33-cover-like-hover-liked')
  evidence.like = { before: likeBefore, after: { pressed: likeAfter.pressed, color: likeAfter.color, background: likeAfter.background, iconChanged: likeAfter.icon !== likeBefore?.icon } }
  evidence.like.hoverIconChanged = coverLikedHover.iconPresent
  console.log('LIKE_STATE ' + JSON.stringify(evidence.like))
  assert.equal(likeAfter.pressed, 'true', `喜欢没有进入按下态: ${JSON.stringify(evidence.like)}`)
  assert.notEqual(likeAfter.icon, likeBefore?.icon, `喜欢按下后图标没换成实心: ${JSON.stringify(evidence.like)}`)
  // 服务端镜像（handoff §15.1）：喜欢/取消都要落到「我的歌单 → 喜欢的歌曲」的条数上
  //（复用既有的 liked-songs 系统歌单，桌面与网页共用一个喜欢集合）。
  const likedSongsCount = async () => {
    await js(`document.querySelector('.linkle-room button[aria-label="歌单"]')?.click()`)
    await until(() => js(`Boolean(document.querySelector('.linkle-room .pl-seg'))`), 'playlists panel')
    await js(`Array.from(document.querySelectorAll('.linkle-room .pl-seg button')).find(button => button.textContent.trim() === '我的歌单')?.click()`)
    await until(() => js(`Boolean(Array.from(document.querySelectorAll('.linkle-room .pl-row')).find(row => row.textContent.includes('喜欢的歌曲')))`), 'liked-songs row')
    // 注意：这段 JS 是模板字符串，写 \d 会被吃掉反斜杠 —— 用 [0-9] 才稳。
    const count = await js(`(() => {
      const row = Array.from(document.querySelectorAll('.linkle-room .pl-row')).find(item => item.textContent.includes('喜欢的歌曲'))
      if (!row) return { count: null, text: null }
      const text = (row.textContent ?? '').trim()
      const match = text.match(/([0-9]+)[ ]*首/)
      return { count: match ? Number(match[1]) : null, text: text.slice(0, 40) }
    })()`)
    await js(`document.querySelector('.linkle-room .panel-head button[aria-label="关闭面板"]')?.click()`)
    await wait(200)
    return count
  }
  const likedAfterLike = await likedSongsCount()
  evidence.likedSongs = { afterLike: likedAfterLike.count, afterLikeRow: likedAfterLike.text }
  console.log('LIKED_SONGS_AFTER_LIKE ' + JSON.stringify(evidence.likedSongs))
  assert.equal(likedAfterLike.count, 1, `喜欢没有镜像进「喜欢的歌曲」: ${JSON.stringify(evidence.likedSongs)}`)
  // 再点一次＝**取消喜欢**（handoff §15.1：unlike 已实现，按下态按 likedByMe 推导）。
  // 判据三条：文案说明"已移除 + 网页端那份一起移除"、按下态回到 false、服务端那条真的撤了。
  // 成功类提示行已按用户要求去掉（2026-09-25）：反馈由按下态/实心图标承担，这里反向钉住"不再出现那句话"。
  assert.ok(!/已加入「喜欢的歌曲」/.test(String(likeAfter.note ?? '')), `点喜欢又写提示行了: ${JSON.stringify(likeAfter)}`)
  await js(`document.querySelector('.linkle-room .imm-art').click()`)
  await until(() => js(`document.querySelector('.linkle-room .imm-art')?.getAttribute('aria-pressed') === 'false'`), 'unlike round-trip', 20000)
  await wait(300)
  const likeRepeat = await js(`(() => ({
    note: document.querySelector('.linkle-room .control-note')?.textContent?.trim() ?? null,
    pressed: document.querySelector('.linkle-room .imm-art')?.getAttribute('aria-pressed') ?? null,
  }))()`)
  evidence.likeRepeat = likeRepeat
  console.log('LIKE_REPEAT ' + JSON.stringify(likeRepeat))
  assert.ok(!/已从「喜欢的歌曲」移除/.test(String(likeRepeat.note ?? '')), `取消喜欢又写提示行了: ${JSON.stringify(likeRepeat)}`)
  assert.equal(likeRepeat.pressed, 'false', `取消喜欢之后按下态没复位: ${JSON.stringify(likeRepeat)}`)

  // 「歌单里对任意一首取消喜欢」（用户 2026-09-25 拍板开，本轮之前被 SYSTEM_READONLY 拦着）：
  // liked-songs 的曲目行现在也带移除键，点它 = 取消喜欢，服务端会一并撤掉网页端那条。
  // 「歌单里对任意一首取消喜欢」（用户拍板开，handoff §16）：按键位 features.likedSongsEdit 点灯 ——
  // 位为真：liked-songs 的曲目行有行内移除键（走 playlist.remove-items）；位为假：按钮不出现，
  // 不靠"发了被拒再报错"当主路径（老服务端上这条必然 SYSTEM_READONLY）。
  const likedSongsEditOn = async () => {
    const response = await invoke('musicPartyRequest', { input: { origin: service.origin, method: 'GET', path: '/api/desktop/v1/capabilities', clientVersion: '0.2.0' } })
    try { return JSON.parse(response?.body ?? '{}').features?.likedSongsEdit === true } catch { return false }
  }
  const openLikedSongsDetail = async () => {
    await js(`document.querySelector('.linkle-room button[aria-label="歌单"]')?.click()`)
    await until(() => js(`Boolean(document.querySelector('.linkle-room .pl-seg'))`), 'playlists panel')
    await js(`Array.from(document.querySelectorAll('.linkle-room .pl-seg button')).find(button => button.textContent.trim() === '我的歌单')?.click()`)
    await until(() => js(`Boolean(Array.from(document.querySelectorAll('.linkle-room .pl-row')).find(row => row.textContent.includes('喜欢的歌曲')))`), 'liked-songs row')
    // 那一行的 ⋯ 菜单里不该有改名/删除（§16：服务端对 liked-songs 的 rename/delete 仍是 SYSTEM_READONLY，
    // 客户端就不该给入口）；点菜单里的「打开」顺便选中它，比直接点行更接近真实操作。
    await js(`Array.from(document.querySelectorAll('.linkle-room .pl-row')).find(row => row.textContent.includes('喜欢的歌曲'))?.querySelector('.pl-ico')?.click()`)
    await until(() => js(`Boolean(document.querySelector('.linkle-room .pl-menu'))`), 'liked-songs row menu')
    const menuItems = await js(`Array.from(document.querySelectorAll('.linkle-room .pl-menu button')).map(node => node.textContent.trim())`)
    await js(`Array.from(document.querySelectorAll('.linkle-room .pl-menu button')).find(node => node.textContent.trim() === '打开')?.click()`)
    await until(() => js(`Boolean(document.querySelector('.linkle-room .pl-detail .pl-track'))`), 'liked-songs tracks')
    // 等那一行的动作键"可用"：切歌单后的拉取期间按钮是 disabled，点下去什么都不会发生。
    let ready = false
    for (let attempt = 0; attempt < 30 && !ready; attempt += 1) {
      ready = await js(`(() => { const button = document.querySelector('.linkle-room .pl-detail .pl-track .pl-ico'); return Boolean(button && !button.disabled) })()`)
      if (!ready) await wait(200)
    }
    const label = await js(`document.querySelector('.linkle-room .pl-detail .pl-track .pl-ico')?.getAttribute('aria-label') ?? null`)
    return { ready, label, menuItems }
  }
  const closePanel = async () => { await js(`document.querySelector('.linkle-room .panel-head button[aria-label="关闭面板"]')?.click()`); await wait(200) }
  const likedAfterUnlike = await likedSongsCount()
  evidence.likedSongs.afterUnlike = likedAfterUnlike.count
  evidence.likedSongs.afterUnlikeRow = likedAfterUnlike.text
  console.log('LIKED_SONGS_AFTER_UNLIKE ' + JSON.stringify(evidence.likedSongs))
  assert.equal(likedAfterUnlike.count, 0, `取消喜欢没有把「喜欢的歌曲」里那条撤掉: ${JSON.stringify(evidence.likedSongs)}`)
  // 再喜欢一次，然后**在歌单里**对这首取消（换个入口走同一条服务端语义）。
  await js(`document.querySelector('.linkle-room .imm-art').click()`)
  await until(() => js(`document.querySelector('.linkle-room .imm-art')?.getAttribute('aria-pressed') === 'true'`), 'like again for the playlist path', 20000)
  const likedSongsEditFlag = await likedSongsEditOn()
  const likedDetail = await openLikedSongsDetail()
  evidence.likedSongsRowMenu = likedDetail.menuItems
  console.log('LIKED_SONGS_ROW_MENU ' + JSON.stringify(likedDetail.menuItems))
  assert.ok(likedDetail.menuItems?.includes('打开'), `liked-songs 行菜单缺「打开」: ${JSON.stringify(likedDetail.menuItems)}`)
  assert.ok(!likedDetail.menuItems?.includes('重命名') && !likedDetail.menuItems?.includes('删除歌单'), `liked-songs 行菜单不该给改名/删除（服务端仍是 SYSTEM_READONLY）: ${JSON.stringify(likedDetail.menuItems)}`)
  if (likedSongsEditFlag) {
    assert.ok(likedDetail.ready, `位已开，liked-songs 的曲目行却没有可用的移除键: ${JSON.stringify(likedDetail)}`)
    assert.match(String(likedDetail.label ?? ''), /^取消喜欢/, `行内移除键的文案不是"取消喜欢": ${JSON.stringify(likedDetail)}`)
    await js(`document.querySelector('.linkle-room .pl-detail .pl-track .pl-ico')?.click()`)
    const removedIn = async ms => { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (await js(`!document.querySelector('.linkle-room .pl-detail .pl-track')`)) return true; await wait(150) } return false }
    const removed = await removedIn(6000)
    const message = await js(`Array.from(document.querySelectorAll('.linkle-room .pl-panel p[role="status"]')).map(node => node.textContent.trim()).join(' | ')`)
    const rowText = await js(`(() => { const row = Array.from(document.querySelectorAll('.linkle-room .pl-row')).find(item => item.textContent.includes('喜欢的歌曲')); return (row?.textContent ?? '').trim().slice(0, 24) })()`)
    await closePanel()
    evidence.playlistRemoval = { flag: true, label: likedDetail.label, message, rowText, removed }
    console.log('PLAYLIST_UNLIKE ' + JSON.stringify(evidence.playlistRemoval))
    assert.ok(removed, `歌单里取消喜欢没有把曲目行删掉: ${JSON.stringify(evidence.playlistRemoval)}`)
    assert.match(String(message), /已取消喜欢/, `歌单里取消喜欢没有反馈: ${JSON.stringify(evidence.playlistRemoval)}`)
    assert.match(String(rowText), /0 首/, `歌单里取消喜欢没有把条数降下来: ${JSON.stringify(evidence.playlistRemoval)}`)
    // 用户 2026-09-25 报的 bug：歌单里删掉之后红心还亮着。服务端两份真相不耦合，客户端要自己收口——
    // 删的若正是当前曲目，这里必须等到按下态回到 false。
    const removedTitle = String(likedDetail.label ?? '').replace(/^取消喜欢\s*/, '')
    const currentTitle = await js(`document.querySelector('.linkle-room .imm-cover strong')?.textContent?.trim() ?? null`)
    if (currentTitle && currentTitle === removedTitle) {
      await until(() => js(`document.querySelector('.linkle-room .imm-art')?.getAttribute('aria-pressed') === 'false'`), 'heart cleared after playlist removal', 20000)
      console.log('HEART_AFTER_PLAYLIST_REMOVAL ' + JSON.stringify({ track: removedTitle, pressed: 'false' }))
    } else {
      console.log('HEART_AFTER_PLAYLIST_REMOVAL ' + JSON.stringify({ removed: removedTitle, current: currentTitle, skipped: 'removed track was not the current one' }))
    }
  } else {
    // 位为假（老服务端）：客户端就不该出现行内移除键。
    evidence.playlistRemoval = { flag: false, label: likedDetail.label }
    console.log('PLAYLIST_UNLIKE_SKIPPED ' + JSON.stringify(evidence.playlistRemoval))
    assert.equal(likedDetail.label, null, `位为假时 liked-songs 不应出现行内移除键: ${JSON.stringify(evidence.playlistRemoval)}`)
    await closePanel()
  }

  // 逐字 in immersive: the active line keeps sweeping, others stay static.
  const immersiveSweep = await js(`(() => {
    const units = Array.from(document.querySelectorAll('.lyrictext p.current .u'))
    return { count: units.length, fills: units.map(unit => unit.style.getPropertyValue('--p')).slice(0, 5) }
  })()`)
  evidence.immersiveSweep = immersiveSweep
  assert.ok(immersiveSweep.count > 1, `immersive active line lost its word units: ${JSON.stringify(immersiveSweep)}`)
  await shot('07-immersive-lyrics')

  // 动态背景: explicit "开启" must bring up the WebGL route even when the system
  // prefers reduced motion, and the instance must own a sized canvas.
  await js(`document.querySelector('.linkle-room button[aria-label="更多播放选项"]').click()`)
  const motionGroup = label => `.linkle-room .menu.barmenu [role="group"][aria-label="${label}"]`
  await until(() => js(`document.querySelectorAll('.linkle-room .menu.barmenu [role="group"]').length >= 2`), 'motion menu groups')
  const motionOptions = await js(`Array.from(document.querySelectorAll('.linkle-room .menu.barmenu [role="group"]')).map(group => ({ label: group.getAttribute('aria-label'), options: Array.from(group.querySelectorAll('[role="menuitemradio"]')).map(item => item.textContent) }))`)
  evidence.motionOptions = motionOptions
  assert.deepEqual(motionOptions.map(group => group.label), ['动态背景', '歌词动效'])
  assert.ok(motionOptions.every(group => group.options.length === 3), `motion switches lost an option: ${JSON.stringify(motionOptions)}`)
  await shot('11-motion-menu')
  const motionMenu = await box('.linkle-room .menu.barmenu')
  const motionItems = await js(`document.querySelectorAll('.linkle-room .menu.barmenu button').length`)
  evidence.motionMenu = { motionMenu, items: motionItems }
  assert.ok(motionItems >= 8, `the options menu lost items: ${motionItems}`)
  assert.ok(inside(motionMenu, await box('.linkle-room')), `the options menu escapes the room in immersive: ${JSON.stringify(motionMenu)}`)
  await js(`Array.from(document.querySelectorAll('${motionGroup('动态背景')} [role="menuitemradio"]')).find(item => item.textContent === '开启').click()`)
  await js(`document.querySelector('.linkle-room .menu-backdrop')?.click()`)
  await wait(600)
  const webgl = await js(`(() => { const canvas = document.querySelector('.imm-bg-canvas'); return canvas ? { width: canvas.width, height: canvas.height, ready: canvas.classList.contains('ready') } : null })()`)
  evidence.webgl = webgl
  await wait(1200)
  await shot('09-immersive-webgl')
  const webglReady = await js(`(() => { const canvas = document.querySelector('.imm-bg-canvas'); return canvas ? { width: canvas.width, height: canvas.height, ready: canvas.classList.contains('ready') } : null })()`)
  assert.ok(webglReady && webglReady.width > 0 && webglReady.ready, `kawarp route never painted: ${JSON.stringify(webglReady)}`)
  evidence.webglReady = webglReady
  // Leave the local preference back on 跟随系统 for the states that follow.
  await js(`document.querySelector('.linkle-room button[aria-label="更多播放选项"]').click()`)
  await until(() => js(`Boolean(document.querySelector('${motionGroup('动态背景')}'))`), 'motion menu reopened')
  await js(`Array.from(document.querySelectorAll('${motionGroup('动态背景')} [role="menuitemradio"]')).find(item => item.textContent === '跟随系统').click()`)
  await js(`document.querySelector('.linkle-room .menu-backdrop')?.click()`)
  await wait(400)

  await js(`document.querySelector('.linkle-room button[aria-label="播放队列"]').click()`)
  await until(() => js(`Boolean(document.querySelector('.linkle-room.immersive .task.has-panel .panel-head'))`), 'immersive queue panel')
  await wait(400)
  const immersivePanel = await box('.linkle-room.immersive .task.has-panel')
  const immersiveTitle = await box('.linkle-room.immersive .panel-head strong')
  assert.ok(inside(immersiveTitle, immersivePanel), `immersive panel title clipped: ${JSON.stringify({ immersiveTitle, immersivePanel })}`)
  // The scrim must cover the whole main column: an uncovered strip keeps the lyrics
  // live, so hover effects show through and clicks land on the console instead of
  // closing the panel.
  // 用户 2026-09-23 裁决：沉浸下的面板改成主视图整页（不再有浮层与遮罩）。
  // 断言从「遮罩盖住主区」变成「面板本身占满主区」，并且主区底部不再有未被覆盖的区域。
  const panelHost = await box('.linkle-room.immersive .task.has-panel')
  const contentArea = await box('.linkle-room .content-area')
  evidence.panelHost = { panelHost, contentArea }
  assert.ok(panelHost && contentArea, 'immersive panel host missing')
  assert.ok(Math.abs(panelHost.bottom - contentArea.bottom) <= 1 && Math.abs(panelHost.top - contentArea.top) <= 1, `the panel does not fill the main column: ${JSON.stringify({ panelHost, contentArea })}`)
  const hitTest = await js(`(() => {
    const host = document.querySelector('.linkle-room.immersive .task.has-panel').getBoundingClientRect()
    const target = document.elementFromPoint(host.left + host.width / 2, host.bottom - 12)
    return target ? String(target.className).slice(0, 60) : null
  })()`)
  evidence.panelHitTest = hitTest
  assert.ok(String(hitTest).includes('panel-body') || String(hitTest).includes('task'), `a point near the bottom of the main column is not inside the panel: ${hitTest}`)
  assert.equal(await js(`document.querySelectorAll('.linkle-room .panel-scrim').length`), 0, 'the scrim still renders although the panel is a page now')
  // The panel head already names the view; a second title inside the body
  // is the duplicate the mockup removed.
  const duplicateTitles = await js(`Array.from(document.querySelectorAll('.linkle-room .panel-body h3')).filter(heading => heading.textContent.trim() === '播放队列').length`)
  evidence.duplicateTitles = duplicateTitles
  assert.equal(duplicateTitles, 0, 'the queue panel repeats its title inside the body')
  await js()
  // The panel-head keys sit at the very top of a scrolling column: the tooltip must
  // flip below them instead of being clipped by the panel edge.
  // The panel-head keys sit at the very top of a scrolling column: the tooltip must
  // flip below them instead of being clipped by the panel edge.
  // Re-enable the forced-visible tooltips for this measurement only.
  await js(`(() => {
    const style = document.createElement('style')
    style.id = 'harness-tooltip-visible'
    style.textContent = '.linkle-room .tooltip{display:block !important}'
    document.head.append(style)
  })()`)
  const headTip = await tipBox('.linkle-room .panel-head button[aria-label="关闭面板"] ~ .tooltip', '.linkle-room .panel-head button[aria-label="关闭面板"]')
  assert.ok(inside(headTip, immersivePanel), `panel-head tooltip clipped: ${JSON.stringify({ headTip, immersivePanel })}`)
  evidence.panelHeadTooltip = headTip
  await js(`document.getElementById('harness-tooltip-visible')?.remove()`)
  await shot('08-immersive-queue')
  await js(`document.querySelector('.linkle-room .panel-head button[aria-label="关闭面板"]').click()`)
  await wait(200)

  // 设置 → 安全与高级 → 检查这台服务器: the probe must be reachable while a room is
  // open, must report the live service, and must never surface credentials.
  await js(`document.querySelector('.desktop-settings-link button').click()`)
  await until(() => js(`Boolean(document.querySelector('.fluent-settings-nav'))`), 'settings page')
  // 播放 holds the WinUI volume slider (默认音量): measure its parts, because a deformed
  // thumb is invisible to every type check.
  await js(`Array.from(document.querySelectorAll('.fluent-settings-nav [role="tab"]')).find(tab => tab.textContent.includes('播放')).click()`)
  await until(() => js(`Boolean(document.querySelector('.winui-slider-track'))`), 'general settings slider')
  const settingsLayout = await js(`(() => {
    const content = document.querySelector('.fluent-settings-content')
    const stack = document.querySelector('.fluent-settings-content-stack')
    const nav = document.querySelector('.fluent-settings-nav')
    const main = document.querySelector('.desktop-main')
    if (!content || !stack || !nav || !main) return null
    const box = node => node.getBoundingClientRect()
    const first = stack.firstElementChild ? box(stack.firstElementChild) : null
    return {
      main: { left: +box(main).left.toFixed(1), right: +box(main).right.toFixed(1), width: +box(main).width.toFixed(1) },
      content: { left: +box(content).left.toFixed(1), right: +box(content).right.toFixed(1), width: +box(content).width.toFixed(1) },
      stack: { left: +box(stack).left.toFixed(1), right: +box(stack).right.toFixed(1), width: +box(stack).width.toFixed(1) },
      paddingLeft: +parseFloat(getComputedStyle(stack).paddingLeft).toFixed(1),
      paddingRight: +parseFloat(getComputedStyle(stack).paddingRight).toFixed(1),
      navTitleLeft: +box(nav.querySelector('.fluent-settings-nav-title')).left.toFixed(1),
      headingLeft: first ? +first.left.toFixed(1) : null,
      cardWidth: first ? +first.width.toFixed(1) : null,
      overflow: content.scrollWidth - content.clientWidth,
      viewport: window.innerWidth,
    }
  })()`)
  evidence.settingsLayout = settingsLayout
  console.log('SETTINGS_LAYOUT ' + JSON.stringify(settingsLayout))
  assert.ok(settingsLayout, '量不到设置页布局')
  // ① 左右留白对称 ⇒ 内容居中、跟着窗口走（而不是贴左留一大块空白）。
  assert.ok(Math.abs(settingsLayout.paddingLeft - settingsLayout.paddingRight) <= 1,
    `设置页左右留白不对称（没跟着窗口铺满/居中）: ${JSON.stringify(settingsLayout)}`)
  // ② 卡片吃满内容列（没被 960 那类旧上限卡住）——宽窗口下卡片宽度应当明显大于 960。
  assert.ok(settingsLayout.cardWidth >= 960,
    `设置卡片没有跟着窗口变宽（仍被旧上限卡住）: ${JSON.stringify(settingsLayout)}`)
  // ③ 分类导航与内容第一行同一左边线（否则标签与卡片错位）。
  assert.ok(settingsLayout.headingLeft !== null && Math.abs(settingsLayout.navTitleLeft - settingsLayout.headingLeft) <= 2,
    `设置分类导航与内容没对齐（滚动条槽把内容推偏了？）: ${JSON.stringify(settingsLayout)}`)
  assert.ok(settingsLayout.overflow <= 1, `设置页出现横向溢出: ${JSON.stringify(settingsLayout)}`)
  // 同一套公式在**窄窗口**下必须退化成"满宽减两侧留白"（用户 2026-09-25 要求"跟随窗口大小铺满"，
  // 宽窗靠封顶居中、窄窗靠撑满，两者都得成立）。这里临时把窗口压到 900 再量一次，量完复原。
  const wideBounds = browserWindow.getBounds()
  browserWindow.setBounds({ ...wideBounds, width: 900, height: 700 })
  await wait(500)
  const narrowLayout = await js(`(() => {
    const stack = document.querySelector('.fluent-settings-content-stack')
    const content = document.querySelector('.fluent-settings-content')
    if (!stack || !content) return null
    const box = node => node.getBoundingClientRect()
    const first = stack.firstElementChild ? box(stack.firstElementChild) : null
    return {
      cardWidth: first ? +first.width.toFixed(1) : null,
      contentWidth: +box(content).width.toFixed(1),
      contentClientWidth: content.clientWidth,
      mainWidth: +box(document.querySelector('.desktop-main')).width.toFixed(1),
      overflow: content.scrollWidth - content.clientWidth,
      paddingLeft: +parseFloat(getComputedStyle(content).paddingLeft).toFixed(1),
      paddingRight: +parseFloat(getComputedStyle(content).paddingRight).toFixed(1),
    }
  })()`)
  browserWindow.setBounds(wideBounds)
  await wait(500)
  evidence.settingsNarrow = narrowLayout
  console.log('SETTINGS_LAYOUT_NARROW ' + JSON.stringify(narrowLayout))
  assert.ok(narrowLayout, '量不到窄窗口下的设置页布局')
  // 卡片吃满可滚动区（= clientWidth 再减左右 gutter；clientWidth 已扣掉滚动条，别拿 offsetWidth 算）。
  const expectedNarrow = narrowLayout.contentClientWidth - narrowLayout.paddingLeft - narrowLayout.paddingRight
  assert.ok(Math.abs(narrowLayout.cardWidth - expectedNarrow) <= 2,
    `窄窗口下设置卡片没有铺满（仍被旧上限卡住？）: ${JSON.stringify({ ...narrowLayout, expected: expectedNarrow })}`)
  assert.ok(narrowLayout.overflow <= 1, `窄窗口下设置页出现横向溢出: ${JSON.stringify(narrowLayout)}`)

  const sliderGeometry = await js(`(() => {
    const root = document.querySelector('.winui-slider')
    const track = root.querySelector('.winui-slider-track')
    const thumb = root.querySelector('.winui-slider-thumb')
    const range = root.querySelector('.winui-slider-range')
    const box = node => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return { w: +rect.width.toFixed(1), h: +rect.height.toFixed(1), radius: style.borderRadius, overflow: style.overflow, boxSizing: style.boxSizing, flexShrink: style.flexShrink } }
    return { root: box(root), track: box(track), thumb: box(thumb), range: box(range), size: root.getAttribute('data-size'), orientation: root.getAttribute('data-orientation') }
  })()`)
  evidence.sliderGeometry = sliderGeometry
  console.log('SLIDER_GEOMETRY ' + JSON.stringify(sliderGeometry))
  assert.ok(sliderGeometry.thumb.w >= 12 && Math.abs(sliderGeometry.thumb.w - sliderGeometry.thumb.h) <= 1, `the settings slider thumb is deformed: ${JSON.stringify(sliderGeometry.thumb)}`)
  await shot('16-settings-general')
  await js(`Array.from(document.querySelectorAll('.fluent-settings-nav [role="tab"]')).find(tab => tab.textContent.includes('安全与高级')).click()`)
  await until(() => js(`Boolean(Array.from(document.querySelectorAll('.desktop-page button')).find(button => button.textContent.trim() === '检查服务器'))`), 'probe button')
  const probeButton = await js(`(() => { const button = Array.from(document.querySelectorAll('.desktop-page button')).find(item => item.textContent.trim() === '检查服务器'); return { disabled: button.disabled, hint: button.parentElement.textContent.slice(0, 80) } })()`)
  evidence.probeButton = probeButton
  assert.equal(probeButton.disabled, false, `the probe button is disabled with a saved origin: ${JSON.stringify(probeButton)}`)
  await js(`Array.from(document.querySelectorAll('.desktop-page button')).find(button => button.textContent.trim() === '检查服务器').click()`)
  await until(() => js(`Boolean(document.querySelector('.fluent-settings-probe'))`), 'probe result')
  const probeText = await js(`document.querySelector('.fluent-settings-probe').textContent`)
  evidence.probe = probeText
  assert.ok(/状态：(可用|版本不兼容|无法连接)/.test(probeText), `probe status missing: ${probeText}`)
  assert.ok(probeText.includes('API 版本：') && probeText.includes('平台：') && probeText.includes('能力：') && probeText.includes('当前账号：'), `probe details incomplete: ${probeText}`)
  assert.ok(/能力：.*(已开启|未开启)/.test(probeText), `capabilities do not state on/off: ${probeText}`)
  assert.ok(!/MP_SESSION|MP_CSRF|MP_ROOM_ACCESS|cookie|token/i.test(probeText), `probe result leaks credentials: ${probeText}`)
  assert.ok(!/[0-9a-f]{32,}/i.test(probeText), `probe result contains a token-like value: ${probeText}`)
  await shot('12-settings-probe')

  // Back to the room, leave it, and use the lobby entry: the probe must also work
  // without a room, and its conclusion must arrive as a shell toast.
  await js(`Array.from(document.querySelectorAll('.desktop-service-nav button')).find(button => button.textContent.includes('Linkle')).click()`)
  await until(() => js(`Boolean(document.querySelector('.linkle-room'))`), 'back in the room')

  // 浅色主题下的沉浸视图（用户 2026-09-24）：深色歌词必须落在浅色底上，而不是直接压在照片上——
  // 压照片时对比度由封面决定，深色封面会直接把字吃掉。切主题走设置里的真开关，再回到会话。
  const themeSwitch = `(() => {
    const row = Array.from(document.querySelectorAll('.fluent-settings-row')).find(item => (item.textContent ?? '').includes('应用主题'))
    const node = row?.querySelector('[role="switch"]')
    if (node) node.click()
    return Boolean(node)
  })()`
  // Linkle 房间没有底部会话栏（那是 Banguru 的），回房间走侧栏的 Linkle 入口。
  const returnToRoom = `(() => {
    const button = Array.from(document.querySelectorAll('.desktop-service-nav button')).find(item => item.textContent.includes('Linkle'))
    if (button) button.click()
    return Boolean(button)
  })()`
  await js(`document.querySelector('.desktop-settings-link button[aria-label="设置"]').click()`)
  await until(() => js(`Boolean(document.querySelector('.fluent-settings-nav'))`), 'settings for the theme switch')
  await js(`Array.from(document.querySelectorAll('.fluent-settings-nav [role="tab"]')).find(tab => tab.textContent.includes('基础'))?.click()`)
  await until(() => js(`Boolean(Array.from(document.querySelectorAll('.fluent-settings-row')).find(item => (item.textContent ?? '').includes('应用主题')))`), 'appearance row')
  assert.ok(await js(themeSwitch), '设置里找不到应用主题开关')
  await until(() => js(`!document.documentElement.classList.contains('dark')`), 'light theme applied')
  assert.ok(await js(returnToRoom), '会话栏里没有返回当前会话')
  await until(() => js(`Boolean(document.querySelector('.linkle-room'))`), 'room after returning in light theme')
  await until(() => js(`Boolean(document.querySelector('.linkle-room.immersive .imm-art img'))`), 'immersive in light theme')
  await wait(900)
  const lightImmersive = await js(`(() => {
    const luminance = value => { const [r, g, b] = (String(value).match(/[\\d.]+/g) ?? []).slice(0, 3).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 }
    const room = document.querySelector('.linkle-room')
    const style = getComputedStyle(room)
    const cover = document.querySelector('.imm-bg-cover.on')
    const canvas = document.querySelector('.imm-bg-canvas')
    const lyric = document.querySelector('.linkle-room.immersive .lyrictext p.current') ?? document.querySelector('.linkle-room.immersive .lyrictext p')
    const title = document.querySelector('.linkle-room.immersive .imm-cover strong')
    return {
      dark: document.documentElement.classList.contains('dark'),
      current: style.getPropertyValue('--imm-current').trim(),
      filter: style.getPropertyValue('--imm-filter').trim(),
      coverOpacity: cover ? Number(getComputedStyle(cover).opacity) : null,
      canvasOpacity: canvas ? Number(getComputedStyle(canvas).opacity) : null,
      lyricLuma: lyric ? +luminance(getComputedStyle(lyric).color).toFixed(3) : null,
      titleLuma: title ? +luminance(getComputedStyle(title).color).toFixed(3) : null,
    }
  })()`)
  evidence.lightImmersive = lightImmersive
  console.log('LIGHT_IMMERSIVE ' + JSON.stringify(lightImmersive))
  assert.equal(lightImmersive.dark, false, `主题没切到浅色: ${JSON.stringify(lightImmersive)}`)
  assert.ok((lightImmersive.coverOpacity ?? 0) <= 0.6, `浅色下封面模糊层没有压到浅底上: ${JSON.stringify(lightImmersive)}`)
  if (lightImmersive.canvasOpacity !== null) assert.ok(lightImmersive.canvasOpacity <= 0.6, `浅色下 Kawarp 画布没有压到浅底上: ${JSON.stringify(lightImmersive)}`)
  assert.ok(lightImmersive.lyricLuma !== null && lightImmersive.lyricLuma < 0.45, `浅色下歌词不是深色字: ${JSON.stringify(lightImmersive)}`)
  assert.ok(lightImmersive.titleLuma !== null && lightImmersive.titleLuma < 0.45, `浅色下曲名不是深色字: ${JSON.stringify(lightImmersive)}`)
  await shot('21-immersive-light')
  // 悬浮遮罩与红心要跟深浅色走（用户 2026-09-25）：浅色下必须是另一套 token，且红心不许是红色。
  const lightCoverHover = await hoverCover('34-cover-like-hover-light')
  evidence.coverLikeHover.light = lightCoverHover
  console.log('COVER_LIKE_HOVER ' + JSON.stringify(evidence.coverLikeHover))
  assert.notEqual(lightCoverHover.scrim, evidence.coverLikeHover.dark.scrim, `浅色与深色的悬浮遮罩是同一个值（没跟主题走）: ${JSON.stringify(evidence.coverLikeHover)}`)
  assert.notEqual(lightCoverHover.fg, evidence.coverLikeHover.dark.fg, `浅色与深色的红心是同一个颜色（没跟主题走）: ${JSON.stringify(evidence.coverLikeHover)}`)
  const coverInk = await js(`(() => { const node = document.querySelector('.linkle-room .imm-like-ico'); return node ? getComputedStyle(node).color : null })()`)
  evidence.coverLikeHover.ink = coverInk
  // 浅色主题的像素判据方向相反：浅灰遮罩应当把封面提亮（用户要的是"看得出遮罩"，不是只看变量值）。
  assert.ok(lightCoverHover.pixels && lightCoverHover.plainPixels, `量不到浅色封面裁切图像素: ${JSON.stringify(lightCoverHover.pixels)}`)
  evidence.coverLikePixels.light = { hover: lightCoverHover.pixels, plain: lightCoverHover.plainPixels }
  console.log('COVER_LIKE_PIXELS ' + JSON.stringify(evidence.coverLikePixels))
  assert.ok(lightCoverHover.pixels.meanLuma > lightCoverHover.plainPixels.meanLuma + 0.05,
    `浅色下悬浮遮罩没有把封面提亮（遮罩没生效）: ${JSON.stringify(evidence.coverLikePixels)}`)
  // 两套配色都必须满足：红心不是红的（用户 2026-09-25 要求）+ 图标与遮罩明度差够大（各自压得住）。
  // 颜色可能是 #rgb / #rrggbbaa / rgb(...) —— 先按 4/8 位十六进制或 3 段数字统一解析成 [r,g,b]。
  const rgbOf = value => {
    const raw = String(value).trim()
    const hex = raw.match(/^#([0-9a-f]{3,8})$/i)
    if (hex) {
      let h = hex[1]
      if (h.length === 3) h = h.split('').map(c => c + c).join('')
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
    }
    return (raw.match(/[0-9.]+/g) ?? []).slice(0, 3).map(Number)
  }
  const luma = value => { const [r, g, b] = rgbOf(value); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 }
  for (const [name, theme] of [['dark', evidence.coverLikeHover.dark], ['light', lightCoverHover]]) {
    const rgb = rgbOf(theme.fg)
    assert.ok(rgb.length === 3 && rgb.every(Number.isFinite), `${name} 主题的红心颜色解析失败: ${theme.fg}`)
    assert.ok(!(rgb[0] > rgb[1] + 40 && rgb[0] > rgb[2] + 40), `${name} 主题的悬浮红心是红色（用户要求不用红色）: ${theme.fg}`)
    assert.ok(Math.abs(luma(theme.fg) - luma(theme.scrim)) >= 0.35, `${name} 主题的红心和遮罩太接近（对比度不够）: ${JSON.stringify(theme)}`)
  }
  // 白遮罩（用户 2026-09-24：浅色下开菜单整窗发白）。先把当时压在最上层的是谁量出来，
  // 再决定是 DOM 层还是窗口合成层的问题。
  await js(`document.querySelector('.linkle-room button[aria-label="更多播放选项"]').click()`)
  await until(() => js(`Boolean(document.querySelector('.linkle-room .menu.barmenu'))`), 'immersive options menu')
  await wait(400)
  const lightVeil = await js(`(() => {
    const probe = (x, y) => {
      const node = document.elementFromPoint(x, y)
      if (!node) return null
      const style = getComputedStyle(node)
      return { cls: String(node.className).slice(0, 44), bg: style.backgroundColor, opacity: style.opacity, z: style.zIndex, backdrop: style.backdropFilter, filter: style.filter.slice(0, 40) }
    }
    const backdrop = document.querySelector('.menu-backdrop')
    const shell = document.querySelector('.desktop-shell-surface')
    const mica = document.querySelector('.desktop-mica-layer')
    return {
      sidebar: probe(60, 300),
      room: probe(window.innerWidth - 300, 300),
      menu: probe(window.innerWidth - 120, 300),
      backdrop: backdrop ? { bg: getComputedStyle(backdrop).backgroundColor, z: getComputedStyle(backdrop).zIndex } : null,
      shell: shell ? { bg: getComputedStyle(shell).backgroundColor, opacity: getComputedStyle(shell).opacity } : null,
      mica: mica ? { bg: getComputedStyle(mica).backgroundColor, z: getComputedStyle(mica).zIndex, opacity: getComputedStyle(mica).opacity } : null,
    }
  })()`)
  evidence.lightVeil = lightVeil
  console.log('LIGHT_VEIL ' + JSON.stringify(lightVeil))
  // 白遮罩的根因是遮罩按钮吃到通用 `button:hover` 的 `--fill-control-secondary`（浅色 = 93% 白）。
  // 合成事件不产生 :hover，所以用 CDP 强制 hover 状态，直接验这条路径。
  const debuggerApi = browserWindow.webContents.debugger
  let hoverBackdrop = null
  try {
    debuggerApi.attach('1.3')
    await debuggerApi.sendCommand('DOM.enable')
    await debuggerApi.sendCommand('CSS.enable')
    const { root } = await debuggerApi.sendCommand('DOM.getDocument', { depth: 1 })
    const { nodeId } = await debuggerApi.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '.menu-backdrop' })
    await debuggerApi.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover', 'active'] })
    await wait(250)
    hoverBackdrop = await js(`(() => {
      const node = document.querySelector('.menu-backdrop')
      const style = getComputedStyle(node)
      return { bg: style.backgroundColor, opacity: style.opacity, cls: String(node.className) }
    })()`)
    await debuggerApi.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
  } finally {
    if (debuggerApi.isAttached()) debuggerApi.detach()
  }
  evidence.hoverBackdrop = hoverBackdrop
  console.log('BACKDROP_HOVER ' + JSON.stringify(hoverBackdrop))
  assert.ok(hoverBackdrop, 'CDP 强制 hover 失败，无法验证遮罩悬停')
  assert.equal(hoverBackdrop.bg, 'rgba(0, 0, 0, 0)', `遮罩悬停时被染色（浅色下就是整窗白遮罩）: ${JSON.stringify(hoverBackdrop)}`)
  await shot('24-immersive-menu-light')
  await js(`document.querySelector('.linkle-room .menu-backdrop')?.click()`)
  await wait(300)
  await js(`document.querySelector('.desktop-settings-link button[aria-label="设置"]').click()`)
  await until(() => js(`Boolean(document.querySelector('.fluent-settings-nav'))`), 'settings for the dark switch back')
  await js(`Array.from(document.querySelectorAll('.fluent-settings-nav [role="tab"]')).find(tab => tab.textContent.includes('基础'))?.click()`)
  await until(() => js(`Boolean(Array.from(document.querySelectorAll('.fluent-settings-row')).find(item => (item.textContent ?? '').includes('应用主题')))`), 'appearance row again')
  assert.ok(await js(themeSwitch), '第二次找不到应用主题开关')
  await until(() => js(`document.documentElement.classList.contains('dark')`), 'dark theme restored')
  assert.ok(await js(returnToRoom), '会话栏里没有返回当前会话（第二次）')
  await until(() => js(`Boolean(document.querySelector('.linkle-room'))`), 'room after returning in dark theme')
  await wait(400)

  await js(`(() => { window.confirm = () => true; return true })()`)
  await js(`document.querySelector('.linkle-room button[aria-label="退出房间"]').click()`)
  await until(() => js(`Boolean(document.querySelector('.linkle-lobby'))`), 'lobby after leaving the room')
  const lobbyProbe = await js(`(() => { const button = Array.from(document.querySelectorAll('.desktop-page button')).find(item => item.textContent.trim() === '检查服务器'); return button ? { found: true, disabled: button.disabled } : { found: false } })()`)
  evidence.lobbyProbe = lobbyProbe
  assert.ok(lobbyProbe.found && !lobbyProbe.disabled, `the lobby probe entry is missing: ${JSON.stringify(lobbyProbe)}`)
  await js(`Array.from(document.querySelectorAll('.desktop-page button')).find(button => button.textContent.trim() === '检查服务器').click()`)
  await until(() => js(`document.body.innerText.includes('Linkle 服务可用')`), 'probe toast in the lobby')
  // The DOM updates before the compositor paints the new view; let it commit before the shot.
  await wait(500)
  await shot('13-lobby-probe')

  // With the session cleared, the closed create entry must name the missing invite
  // instead of blaming the connection or showing a reconnect loop.
  // 房间管理：以本机身份建房 → 行内出现「我创建的」+ 改名/删除 → 两步确认齐备。
  // Order matters: this runs while the session is still alive (the gate needs an account).
  await js(`Array.from(document.querySelectorAll('.desktop-page button')).find(button => button.textContent.trim().endsWith('创建房间') && !button.disabled).click()`)
  await until(() => js(`Boolean(document.querySelector('.lobby-dialog[open]'))`), 'create dialog')
  const dialogStyle = await js(`(() => {
    const dialog = document.querySelector('.lobby-dialog')
    if (!dialog) return null
    const style = getComputedStyle(dialog)
    return { background: style.backgroundColor, opacity: style.opacity }
  })()`)
  console.log('DIALOG_SURFACE ' + JSON.stringify(dialogStyle))
  assert.match(String(dialogStyle?.background), /^rgb\(/, `对话框底色仍带透明度（faux-Mica 下会漏出下层）: ${JSON.stringify(dialogStyle)}`)

  await js(`(() => {
    const input = document.querySelector('.lobby-dialog input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '验收房间')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await js(`Array.from(document.querySelectorAll('.lobby-dialog footer button')).find(button => button.textContent.includes('创建房间')).click()`)
  await until(() => js(`Boolean(Array.from(document.querySelectorAll('.lobby-row .lobby-room-name')).find(node => node.textContent.includes('验收房间')))`), 'created room row')
  const manageRow = await js(`(() => {
    const row = Array.from(document.querySelectorAll('.lobby-row')).find(item => item.textContent.includes('验收房间'))
    const labels = row ? Array.from(row.querySelectorAll('button')).map(button => button.getAttribute('aria-label') ?? '') : []
    return { found: Boolean(row), edit: labels.some(label => label.startsWith('重命名')), remove: labels.some(label => label.startsWith('删除')), ownerTag: Boolean(row && row.textContent.includes('我创建的')) }
  })()`)
  evidence.manageRow = manageRow
  assert.ok(manageRow.found && manageRow.edit && manageRow.remove && manageRow.ownerTag, `可管理房间没有行内入口: ${JSON.stringify(manageRow)}`)
  await js(`Array.from(document.querySelectorAll('.lobby-row button')).find(button => (button.getAttribute('aria-label') ?? '').startsWith('重命名')).click()`)
  await until(() => js(`Boolean(document.querySelector('.lobby-dialog[open]'))`), 'rename dialog')
  const renameDialog = await js(`(() => ({ title: document.querySelector('.lobby-dialog h2')?.textContent ?? '', value: document.querySelector('.lobby-dialog input')?.value ?? '' }))()`)
  evidence.renameDialog = renameDialog
  assert.ok(renameDialog.title.includes('重命名') && renameDialog.value === '验收房间', `改名对话框没有预填当前名: ${JSON.stringify(renameDialog)}`)
  await js(`Array.from(document.querySelectorAll('.lobby-dialog footer button')).find(button => button.textContent.includes('取消')).click()`)
  await wait(300)
  await js(`Array.from(document.querySelectorAll('.lobby-row button')).find(button => (button.getAttribute('aria-label') ?? '').startsWith('删除')).click()`)
  await until(() => js(`Boolean(document.querySelector('.lobby-dialog[open]'))`), 'delete dialog')
  const deleteDialog = await js(`(() => ({
    title: document.querySelector('.lobby-dialog h2')?.textContent ?? '',
    body: document.querySelector('.lobby-dialog p')?.textContent ?? '',
    confirm: Array.from(document.querySelectorAll('.lobby-dialog footer button')).some(button => button.textContent.includes('确认删除')),
  }))()`)
  evidence.deleteDialog = deleteDialog
  assert.ok(/删除/.test(deleteDialog.title) && /不可撤销|一并清除/.test(deleteDialog.body) && deleteDialog.confirm, `删除确认缺少警告或确认键: ${JSON.stringify(deleteDialog)}`)
  await js(`Array.from(document.querySelectorAll('.lobby-dialog footer button')).find(button => button.textContent.includes('取消')).click()`)
  await wait(300)
  await shot('17-lobby-manage')

  // 私密房闭环（PLAN.md R5-3 的一半，自动化）：桌面建房 → 服务端的房间列表（网页端读的就是它）
  // 立刻出现 → 房主用密码直接进入。剩下「在浏览器里肉眼确认」那一步留给用户。
  await js(`Array.from(document.querySelectorAll('.desktop-page button')).find(button => button.textContent.trim().endsWith('创建房间') && !button.disabled).click()`)
  await until(() => js(`Boolean(document.querySelector('.lobby-dialog[open]'))`), 'private create dialog')
  await js(`(() => {
    const input = document.querySelector('.lobby-dialog input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '私密验收房')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('.lobby-dialog input[type="checkbox"]').click()
    return true
  })()`)
  await until(() => js(`Boolean(document.querySelector('.lobby-dialog input[type="password"]'))`), 'private password field')
  await js(`(() => {
    const input = document.querySelector('.lobby-dialog input[type="password"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'harness-pass')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await js(`Array.from(document.querySelectorAll('.lobby-dialog footer button')).find(button => button.textContent.includes('创建房间')).click()`)
  await until(() => js(`Boolean(Array.from(document.querySelectorAll('.lobby-row .lobby-room-name')).find(node => node.textContent.includes('私密验收房')))`), 'private room row in the lobby')
  const roomList = await invoke('musicPartyRequest', { input: { origin: service.origin, method: 'GET', path: '/api/rooms', clientVersion: '0.2.0' } })
  const listed = (() => { try { const value = JSON.parse(roomList.body); return Array.isArray(value) ? value : [] } catch { return [] } })()
  const published = listed.find(entry => entry.name === '私密验收房') ?? null
  evidence.privateRoom = { published: Boolean(published), visibility: published?.privateRoom ?? null, accessGranted: published?.accessGranted ?? null }
  console.log('PRIVATE_ROOM ' + JSON.stringify(evidence.privateRoom))
  assert.ok(published?.privateRoom === true, `桌面新建的私密房没有出现在服务端列表里（网页端读的同一个端点）: ${JSON.stringify(evidence.privateRoom)}`)
  await js(`(() => {
    const row = Array.from(document.querySelectorAll('.lobby-row')).find(item => item.textContent.includes('私密验收房'))
    const buttons = Array.from(row.querySelectorAll('.lobby-row-actions button'))
    buttons[buttons.length - 1].click()
    return true
  })()`)
  await until(() => js(`Boolean(document.querySelector('.lobby-dialog[open]'))`), 'join dialog for the private room')
  // The creator already holds the room-access proof (accessGranted=true in the list), so entering
  // their own private room must not ask for the password again.
  const joinDialog = await js(`(() => ({ title: document.querySelector('.lobby-dialog h2')?.textContent ?? '', asksPassword: Boolean(document.querySelector('.lobby-dialog input[type="password"]')) }))()`)
  evidence.privateRoomJoin = joinDialog
  console.log('PRIVATE_ROOM_JOIN_DIALOG ' + JSON.stringify(joinDialog))
  assert.equal(joinDialog.asksPassword, false, `房主进自己的私密房不该再要一次密码: ${JSON.stringify(joinDialog)}`)
  await js(`Array.from(document.querySelectorAll('.lobby-dialog footer button')).find(button => button.textContent.includes('加入房间')).click()`)
  await until(() => js(`Boolean(document.querySelector('.linkle-room .roomhead'))`), 'entered the private room as its creator')
  evidence.privateRoomJoined = await js(`document.querySelector('.linkle-room .identity h2')?.textContent ?? null`)
  console.log('PRIVATE_ROOM_JOINED ' + JSON.stringify(evidence.privateRoomJoined))
  await shot('18-private-room')
  // Leave again so the lobby checks below still describe the same surface.
  await js(`(() => { window.confirm = () => true; return true })()`)
  await js(`document.querySelector('.linkle-room button[aria-label="退出房间"]').click()`)
  await until(() => js(`Boolean(document.querySelector('.lobby-connect'))`), 'lobby after leaving the private room')

  await invoke('clearMusicPartySession', { origin: service.origin })
  const accountAfterClear = await invoke('musicPartyRequest', { input: { origin: service.origin, method: 'GET', path: '/api/account/me', clientVersion: '0.2.0' } })
  console.log('AFTER_CLEAR_ACCOUNT ' + accountAfterClear.status)
  // 方案 C: the connection card reports the fresh reading inline, so there is no toast to wait for.
  await js(`Array.from(document.querySelectorAll('.desktop-page button')).find(button => button.textContent.trim() === '检查服务器').click()`)
  await until(() => js(`document.body.innerText.includes('本机尚未登录')`), 'probe result after clearing the session')
  const probeAfterClear = await js(`document.querySelector('.lobby-card .lobby-note')?.textContent ?? null`)
  console.log('AFTER_CLEAR_PROBE ' + probeAfterClear)
  const lobbyLayout = await js(`(() => ({
    connectionCard: Boolean(document.querySelector('.lobby-card .lobby-kv')),
    inviteField: Boolean(document.querySelector('.lobby-invite input')),
    chips: document.querySelectorAll('.lobby-filters .lobby-chip').length,
    rows: document.querySelectorAll('.lobby-rows .lobby-row:not(.head)').length,
    rowActions: Array.from(document.querySelectorAll('.lobby-row-actions button')).filter(button => /进入|输入密码|已在此房间/.test(button.textContent)).length,
  }))()`)
  evidence.lobbyLayout = lobbyLayout
  console.log('LOBBY_LAYOUT ' + JSON.stringify(lobbyLayout))
  assert.ok(lobbyLayout.connectionCard && lobbyLayout.inviteField, `方案 C 的连接卡或邀请码卡缺失: ${JSON.stringify(lobbyLayout)}`)
  assert.equal(lobbyLayout.chips, 3, `筛选 chips 数量不对: ${JSON.stringify(lobbyLayout)}`)
  assert.ok(lobbyLayout.rows >= 1 && lobbyLayout.rowActions >= 1, `房间行缺少进入动作: ${JSON.stringify(lobbyLayout)}`)
  // 工具栏与表头右端必须落在同一条线上（用户 2026-09-24 圈出的那道空带）：
  // 它来自 `.lobby-rows` 的 scrollbar-gutter，预留槽会常驻，表头看着就比工具栏短一截。
  const roomAlign = await js(`(() => {
    const right = node => node ? +node.getBoundingClientRect().right.toFixed(1) : null
    const create = Array.from(document.querySelectorAll('.desktop-page button')).find(item => item.textContent.trim() === '创建房间')
    return { toolbar: right(create), headRow: right(document.querySelector('.lobby-rows .lobby-row.head')), rows: right(document.querySelector('.lobby-rows')), scrollGap: document.querySelector('.lobby-rows').scrollWidth - document.querySelector('.lobby-rows').clientWidth }
  })()`)
  evidence.roomAlign = roomAlign
  console.log('LOBBY_ALIGN ' + JSON.stringify(roomAlign))
  assert.ok(roomAlign.toolbar !== null && roomAlign.headRow !== null && Math.abs(roomAlign.toolbar - roomAlign.headRow) <= 3, `工具栏与表头右端没对齐: ${JSON.stringify(roomAlign)}`)
  // 空列表提示要居中（用户 2026-09-24：原来左对齐，看着像没写完的一行）。
  await fill('搜索 Linkle 房间', '没有这个房间')
  await until(() => js(`Boolean(document.querySelector('.lobby-rows .lobby-empty strong'))`), 'empty result state')
  await wait(300)
  const emptyState = await js(`(() => {
    const empty = document.querySelector('.lobby-rows .lobby-empty')
    const host = document.querySelector('.lobby-rows')
    const text = empty?.querySelector('strong')
    if (!empty || !host || !text) return null
    const textBox = text.getBoundingClientRect(), hostBox = host.getBoundingClientRect()
    return { drift: Math.round((textBox.left + textBox.width / 2) - (hostBox.left + hostBox.width / 2)), scrollGap: host.scrollWidth - host.clientWidth }
  })()`)
  evidence.emptyState = emptyState
  console.log('LOBBY_EMPTY ' + JSON.stringify(emptyState))
  assert.ok(emptyState && emptyState.scrollGap === 0 && Math.abs(emptyState.drift) <= 2, `空列表提示没有居中: ${JSON.stringify(emptyState)}`)
  await shot('23-lobby-empty')
  await fill('搜索 Linkle 房间', '')
  await wait(300)
  await js(`Array.from(document.querySelectorAll('.desktop-page button')).find(button => button.textContent.trim() === '刷新')?.click()`)
  await wait(1500)
  const lobbyState = await js(`(() => {
    const create = Array.from(document.querySelectorAll('.desktop-page button')).find(item => item.textContent.trim() === '创建房间')
    return { hint: document.querySelector('.lobby-hint')?.textContent ?? null, inlineBar: document.querySelector('.lobby-service-hint')?.textContent?.slice(0, 90) ?? null, topToast: document.querySelector('.shell-toaster-top .fui-Toast')?.textContent?.slice(0, 60) ?? null, createDisabled: create ? create.disabled : null, createTitle: create ? create.title : null }
  })()`)
  evidence.lobbyState = lobbyState
  console.log('LOBBY_STATE ' + JSON.stringify(lobbyState))
  await until(() => js(`(document.querySelector('.lobby-hint')?.textContent ?? '').includes('邀请码')`), 'credential hint in the lobby')
  const lobbyHint = await js(`document.querySelector('.lobby-hint').textContent`)
  evidence.lobbyHint = lobbyHint
  assert.match(lobbyHint, /本机还没有 Linkle 凭据，请先输入邀请码/, `the lobby does not name the missing credentials: ${lobbyHint}`)
  await shot('14-lobby-credentials-hint')
  // The shell's own Linkle status line must never label a credentials-missing loop as a
  // transport problem (重连中) — that is the state the user cannot debug.
  // 服务与账号已从页面底部迁进顶部探测卡片（用户 2026-09-25）：点按钮后卡片内容整体换成配置，
  // 返回后回到探测内容；首页那份"搜索音乐"同时删除（与房间搜索面板完全重复）。
  await js(`Array.from(document.querySelectorAll('.lobby-card button')).find(button => button.textContent.trim() === '服务与账号').click()`)
  await until(() => js(`Boolean(document.querySelector('.lobby-account-panel'))`), 'account panel inside the probe card')
  const accountSwap = await js(`(() => ({
    cardLabel: document.querySelector('.lobby-card')?.getAttribute('aria-label') ?? null,
    probeRows: document.querySelectorAll('.lobby-card .lobby-kv').length,
    address: document.querySelector('.lobby-account-panel input[aria-label="Linkle 服务地址"]')?.value ?? null,
    invite: Boolean(document.querySelector('.lobby-account-panel input[aria-label="Linkle 邀请码"]')),
    back: Boolean(document.querySelector('.lobby-card button[aria-label="返回服务器信息"]')),
    legacyDetails: Boolean(document.querySelector('details.shell-lobby-secondary')),
    homeSearch: document.body.innerText.includes('搜索音乐'),
    panel: (() => {
      const panel = document.querySelector('.lobby-account-panel')
      const style = getComputedStyle(panel)
      const rows = Array.from(panel.querySelectorAll(':scope > section > *'))
      return { border: style.borderTopWidth, pad: style.paddingTop, rowGaps: rows.map(row => getComputedStyle(row).marginTop) }
    })(),
  }))()`)
  evidence.accountSwap = accountSwap
  console.log('LOBBY_ACCOUNT_SWAP ' + JSON.stringify(accountSwap))
  assert.equal(accountSwap.cardLabel, '服务与账号', `点服务与账号后卡片没有换成配置: ${JSON.stringify(accountSwap)}`)
  assert.equal(accountSwap.probeRows, 0, `卡片内容没有被替换，探测行仍在: ${JSON.stringify(accountSwap)}`)
  assert.ok((accountSwap.address ?? "").startsWith("http"), `配置面板里没有服务地址输入框: ${JSON.stringify(accountSwap)}`)
  assert.ok(accountSwap.invite && accountSwap.back, `配置面板缺少邀请码或返回入口: ${JSON.stringify(accountSwap)}`)
  assert.equal(accountSwap.legacyDetails, false, `底部 details.shell-lobby-secondary 仍在: ${JSON.stringify(accountSwap)}`)
  assert.equal(accountSwap.homeSearch, false, `首页仍有"搜索音乐"残留: ${JSON.stringify(accountSwap)}`)
  // 服务与账号子面板不要分割线、留白收紧（用户 2026-09-25）。
  assert.equal(accountSwap.panel.border, '0px', `子面板还画着分割线: ${JSON.stringify(accountSwap.panel)}`)
  assert.equal(accountSwap.panel.pad, '0px', `子面板还留着上内边距: ${JSON.stringify(accountSwap.panel)}`)
  assert.ok(accountSwap.panel.rowGaps.length > 2 && accountSwap.panel.rowGaps[0] === '0px' && accountSwap.panel.rowGaps.slice(1).every(gap => gap === '6px'), `子面板留白没有收紧: ${JSON.stringify(accountSwap.panel)}`)
  const statusWords = await js(`(() => {
    const text = document.querySelector('.lobby-account-panel')?.innerText ?? ''
    return ['已连接','重连中','未连接','连接中','连接失败','会话已过期'].filter(word => text.includes(word))
  })()`)
  evidence.linkleStatusWords = statusWords
  const accountLabel = await js(`document.querySelector('.lobby-card .lobby-account')?.textContent?.trim() ?? null`)
  evidence.lobbyAccountLabel = accountLabel
  console.log('LOBBY_ACCOUNT_HEAD ' + JSON.stringify({ statusWords, accountLabel }))
  // 面板里那行「Linkle · 连接状态」已按用户要求删除（2026-09-25），大厅不再出现连接状态词；
  // 「凭据缺失」这件事仍由 .lobby-hint 明说（上面的 lobbyHint 断言），不会被写成「重连中」。
  assert.deepEqual(statusWords, [], `配置面板里仍有连接状态词: ${JSON.stringify(statusWords)}`)
  assert.match(String(accountLabel), /本机尚未登录|桌面用户/, `卡片头没有账号名: ${accountLabel}`)
  await shot('15-status-line')
  await js(`document.querySelector('.lobby-card button[aria-label="返回服务器信息"]').click()`)
  await until(() => js(`Boolean(document.querySelector('.lobby-card .lobby-kv'))`), 'probe rows back after 返回')
  assert.equal(await js(`Boolean(document.querySelector('.lobby-account-panel'))`), false, '返回后配置面板没有收起')

  // 侧栏可折叠（用户要求）：图标模式 + 记忆；展开后恢复，后面的断言不受影响。
  // 先等按钮出来再点：同一轮重排里刚出现的元素立刻用会偶发 Script failed to execute
  //（后端连跑两次复现：rc=1 卡在这一步，rc=0 正常）。
  await until(() => js(`Boolean(document.querySelector('button[aria-label="折叠侧栏"]'))`), 'collapse toggle')
  await js(`document.querySelector('button[aria-label="折叠侧栏"]').click()`)
  await wait(300)
  const collapsed = {
    attr: await js(`document.querySelector('.desktop-shell-grid').dataset.sidebar`),
    width: await js(`Number.parseFloat(getComputedStyle(document.querySelector('.desktop-shell-grid')).gridTemplateColumns.split(' ')[0])`),
    labels: await js(`getComputedStyle(document.querySelector('.desktop-service-nav span')).display`),
  }
  evidence.sidebarCollapsed = collapsed
  console.log('SIDEBAR_COLLAPSED ' + JSON.stringify(collapsed))
  assert.equal(collapsed.attr, 'collapsed', `侧栏没有折叠: ${JSON.stringify(collapsed)}`)
  assert.ok(collapsed.width <= 80, `折叠后侧栏宽度没收窄: ${JSON.stringify(collapsed)}`)
  assert.equal(collapsed.labels, 'none', `折叠后文字没有隐藏: ${JSON.stringify(collapsed)}`)
  // 折叠后还必须留得下「设置」和「展开」两个按钮：截图里看不到图标时，几何量才是准数。
  const railFooter = await js(`(() => {
    const rect = node => { const box = node.getBoundingClientRect(); return { x: +box.x.toFixed(1), y: +box.y.toFixed(1), w: +box.width.toFixed(1), h: +box.height.toFixed(1) } }
    const settings = document.querySelector('.desktop-settings-link button[aria-label="设置"]')
    const toggle = document.querySelector('.desktop-settings-link button[aria-label="展开侧栏"]')
    const toggleBox = rect(toggle)
    const center = document.elementFromPoint(toggleBox.x + toggleBox.w / 2, toggleBox.y + toggleBox.h / 2)
    const rail = rect(document.querySelector('.desktop-sidebar'))
    const outside = Array.from(document.querySelectorAll('.desktop-sidebar button')).map(button => {
      const box = rect(button)
      return { label: button.getAttribute('aria-label'), x: box.x, right: +(box.x + box.w).toFixed(1) }
    }).filter(item => item.x < rail.x - 0.5 || item.right > rail.x + rail.w + 0.5)
    return { rail, settings: rect(settings), toggle: toggleBox, hit: center?.closest('button')?.getAttribute('aria-label') ?? null, outside }
  })()`)
  evidence.sidebarFooter = railFooter
  console.log('SIDEBAR_FOOTER ' + JSON.stringify(railFooter))
  assert.ok(railFooter.settings.x >= railFooter.rail.x - 0.5 && railFooter.settings.y >= railFooter.rail.y, `折叠后「设置」越出侧栏: ${JSON.stringify(railFooter)}`)
  assert.ok(railFooter.toggle.x + railFooter.toggle.w <= railFooter.rail.x + railFooter.rail.w + 0.5, `折叠后「展开」越出侧栏: ${JSON.stringify(railFooter)}`)
  assert.deepEqual(railFooter.outside, [], `折叠后侧栏里还有按钮跑到栏外: ${JSON.stringify(railFooter.outside)}`)
  assert.ok(railFooter.toggle.y > railFooter.rail.y + railFooter.rail.h / 2, `折叠后「展开」没有贴到底部: ${JSON.stringify(railFooter.toggle)}`)
  assert.equal(railFooter.hit, '展开侧栏', `折叠后展开按钮点不到: ${JSON.stringify(railFooter)}`)
  // 折叠/展开图标要够大（用户 2026-09-24）：FluentButton 里的矢量图默认 20px，在 64px 栏里像个点。
  const footerIcon = await js(`(() => {
    const svg = document.querySelector('.desktop-settings-link button[aria-label="展开侧栏"] svg')
    if (!svg) return null
    const box = svg.getBoundingClientRect()
    return { w: +box.width.toFixed(1), h: +box.height.toFixed(1) }
  })()`)
  evidence.footerIcon = footerIcon
  console.log('SIDEBAR_FOOTER_ICON ' + JSON.stringify(footerIcon))
  assert.ok(footerIcon && footerIcon.w >= 22 && footerIcon.h >= 22, `折叠图标太小: ${JSON.stringify(footerIcon)}`)
  await wait(500)
  await shot('20-sidebar-collapsed')
  await until(() => js(`Boolean(document.querySelector('button[aria-label="展开侧栏"]'))`), 'expand toggle')
  await js(`document.querySelector('button[aria-label="展开侧栏"]').click()`)
  await wait(300)
  assert.equal(await js(`document.querySelector('.desktop-shell-grid').dataset.sidebar`), 'expanded', '侧栏没有展开回来')

  // 房间列表读失败 → 顶部 popup（用户 2026-09-24）。做法：把隔离服务停掉再刷新
  // （改地址那条路走不通：有活动会话时保存不会切换 origin，这是产品规则）。这条放在最后。
  // 服务是经 shell 起的，kill 只杀得掉 cmd.exe：要按进程树杀（service-acceptance 清理时也是这么做的）。
  assert.ok(service.child, '隔离服务进程句柄缺失，无法验证读失败提示')
  await promisify(execFile)('taskkill', ['/pid', String(service.child.pid), '/t', '/f'], { windowsHide: true }).catch(() => undefined)
  await wait(800)
  await js(`(() => { const button = Array.from(document.querySelectorAll('.desktop-page button')).find(item => item.textContent.trim() === '刷新'); if (button) button.click(); return Boolean(button) })()`)
  let failureToast = null
  for (let attempt = 0; attempt < 90 && !failureToast?.text; attempt += 1) {
    await wait(500)
    failureToast = await js(`(() => {
      const hosts = Array.from(document.querySelectorAll('.shell-toaster, .shell-toaster-top'))
      const line = (document.body.innerText.match(/无法读取 Linkle 房间列表[^\\n]*/) ?? [null])[0]
      const owner = hosts.find(node => node.textContent.includes('无法读取 Linkle 房间列表'))
      const box = owner ? owner.getBoundingClientRect() : null
      return {
        text: line,
        top: box ? Math.round(box.top) : null,
        isTopHost: owner ? owner.className.includes('shell-toaster-top') : false,
        rows: document.querySelectorAll('.lobby-rows .lobby-row:not(.head)').length,
        inlineBar: Boolean(document.querySelector('.lobby-service-hint')),
        genericHint: (document.querySelector('.lobby-hint')?.textContent ?? '').includes('连接 Linkle 服务并输入邀请码'),
      }
    })()`)
  }
  evidence.failureToast = failureToast
  console.log('LOBBY_FAILURE_TOAST ' + JSON.stringify(failureToast))
  assert.match(String(failureToast.text), /无法读取 Linkle 房间列表/, `列表读失败的 popup 文案不对: ${JSON.stringify(failureToast)}`)
  assert.ok(failureToast.top !== null && failureToast.top < 200, `列表读失败的 popup 不在顶部: ${JSON.stringify(failureToast)}`)
  assert.equal(failureToast.inlineBar, false, `列表读失败仍压在列表上方: ${JSON.stringify(failureToast)}`)
  assert.equal(failureToast.genericHint, false, `工具栏下又出现那句泛泛的提示: ${JSON.stringify(failureToast)}`)
  await shot('22-lobby-error-top')

  console.log('LINKLE_WORKSPACE_EVIDENCE ' + JSON.stringify(evidence))
  console.log('LINKLE_ONE_SCREEN_CHECKS_OK')
}

/** Real Go service and Electron IPC/Rust/libmpv; only the external music provider is a fixture. */
export async function runAcceptance(window, native) {
  window.showInactive()
  const material = await window.webContents.executeJavaScript('window.watchpartyDesktop.invoke("getDesktopWindowMaterial")')
  if (material !== 'mica') throw new Error(`window_material_not_applied:${material ?? 'unknown'}`)
  console.log(JSON.stringify({ check: 'window-material', material }))
  const dir = await mkdtemp(join(tmpdir(), 'watchparty-acceptance-'))
  const children = [], servers = [], sockets = new Set()
  let adapter, player, origin
  const invoke = (command, args = {}) => window.webContents.executeJavaScript(`window.watchpartyDesktop.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`).catch(error => {
    const code = typeof error?.code === 'string' ? error.code : typeof error === 'string' ? error : error?.message
    throw new Error(`${command}: ${typeof code === 'string' && /^[a-zA-Z0-9_ -]+$/.test(code) ? code : 'native_request_failed'}`)
  })
  const start = (exe, args, options) => { const p = spawn(exe, args, { windowsHide: true, ...options }); children.push(p); return p }
  try {
    const wav = pcm(12)
    let providerOrigin
    const provider = createServer((req, res) => {
      const u = new URL(req.url, providerOrigin)
      if (u.pathname === '/tone.wav') { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length }); res.end(wav); return }
      const id = u.searchParams.get('ids') ?? '1'
      const body = u.pathname === '/song/detail' ? { songs: [{ id: Number(id), name: `Generated ${id}`, dt: 12000, ar: [{ name: 'Acceptance' }], al: {} }] }
        : u.pathname === '/song/url/v1' ? { data: [{ url: `${providerOrigin}/tone.wav` }] } : {}
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body))
    }); servers.push(provider); providerOrigin = await listen(provider)
    const reservation = createServer(); const serviceOrigin = await listen(reservation); await new Promise(r => reservation.close(r))
    let offline = false, dropPatch = false, dropped = 0, resyncs = 0, awaitingGap = false
    const proxy = createServer((req, res) => {
      if (offline) { req.socket.destroy(); return }
      const upstream = request(serviceOrigin + req.url, { method: req.method, headers: req.headers }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res) })
      upstream.on('error', () => { res.destroy() }); req.pipe(upstream)
    }); servers.push(proxy); origin = await listen(proxy)
    const wsServer = new WebSocketServer({ noServer: true })
    proxy.on('upgrade', (req, socket, head) => {
      if (offline) { socket.destroy(); return }
      wsServer.handleUpgrade(req, socket, head, client => {
        const upstream = new WebSocket(serviceOrigin.replace('http:', 'ws:') + req.url, { headers: { Cookie: req.headers.cookie ?? '', Origin: origin } })
        sockets.add(client); sockets.add(upstream)
        const pending = []
        client.on('message', data => { if (JSON.parse(String(data)).type === 'player.resync') { resyncs++; awaitingGap = false } if (upstream.readyState === 1) upstream.send(data.toString()); else pending.push(data.toString()) })
        upstream.on('open', () => pending.splice(0).forEach(value => upstream.send(value)))
        upstream.on('message', data => { const event = JSON.parse(String(data)); if (dropPatch && event.type === 'queue.patch') { dropPatch = false; dropped++; awaitingGap = true; return } if (awaitingGap && event.type === 'player.state') return; if (client.readyState === 1) client.send(data.toString()) })
        for (const [a, b] of [[client, upstream], [upstream, client]]) { a.on('error', () => b.terminate()); a.on('close', () => { sockets.delete(a); b.terminate() }) }
      })
    })
    const exe = join(dir, 'musicparty.exe')
    const build = start('go', ['build', '-o', exe, './cmd/musicparty'], { cwd: resolve(root, '../musicparty/MusicParty/backend-go'), stdio: ['ignore', 'ignore', 'inherit'] })
    assert.equal((await once(build, 'exit'))[0], 0)
    const password = randomUUID()
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(systemroot|windir|path|temp|tmp)$/i.test(name)))
    const service = start(exe, [], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'], env: {
      ...env, SERVER_PORT: new URL(serviceOrigin).port, BASE_URL: origin, ALLOWED_ORIGINS: `${origin},${serviceOrigin}`,
      DB_PATH: join(dir, 'test.db'), DB_INIT_SCHEMA: 'true', DB_ENABLED: 'true', BOOTSTRAP_ADMIN_USERNAME: 'acceptance', BOOTSTRAP_ADMIN_PASSWORD: password,
      AUTH_SECURE_COOKIES: 'false', ROOM_ACCESS_TOKEN_SECRET: randomUUID(), NETEASE_API_URL: providerOrigin, NETEASE_COOKIE: 'generated-fixture',
      STATIC_PATH: join(dir, 'static'), LOCAL_LIBRARY_PATH: join(dir, 'library'), YOUTUBE_ENABLED: 'false', NAVIDROME_ENABLED: 'false', SQUIDIFY_ENABLED: 'false',
    } })
    await until(async () => { assert.equal(service.exitCode, null); try { return (await fetch(serviceOrigin + '/api/desktop/v1/health')).ok } catch { return false } }, 'Go ready', 30000)
    const login = await fetch(serviceOrigin + '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'acceptance', password }) })
    assert.equal(login.status, 200)
    const cookies = login.headers.getSetCookie().map(c => c.split(';')[0]); const csrf = cookies.find(c => c.startsWith('MP_CSRF=')).slice(8)
    const adminRequest = async (path, body) => { const r = await fetch(serviceOrigin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookies.join('; '), 'X-CSRF-Token': csrf }, body: JSON.stringify(body) }); assert.equal(r.status, 200, path); return r.json() }
    const admin = new WebSocket(serviceOrigin.replace('http:', 'ws:') + '/api/desktop/v1/ws?roomId=lounge', { headers: { Cookie: cookies.join('; '), Origin: serviceOrigin } }); sockets.add(admin)
    let adminState, queueVersion = 0
    admin.on('message', data => { const e = JSON.parse(String(data)); if(e.type === 'player.state') { adminState = e.payload; queueVersion = e.payload.queueVersion } if(e.type === 'queue.patch') queueVersion = e.payload.queueVersion })
    await once(admin, 'open'); admin.send(JSON.stringify({ type: 'client.hello', payload: { apiVersion: '2026-01', clientVersion: '0.2.0' } }))
    await until(() => adminState, 'admin snapshot')
    const enqueue = async id => { const version = queueVersion; admin.send(JSON.stringify({ type: 'enqueue', roomId: 'lounge', payload: { platform: 'netease', musicId: id, mutationId: randomUUID() } })); await until(() => queueVersion > version, 'enqueue') }
    await enqueue('1'); await until(() => adminState?.nowPlaying, 'playing before client joins')
    const { MusicPartyAdapter } = await import(await moduleUrl('musicparty-adapter'))
    const { NativeAudioPlayer } = await import(await moduleUrl('native-audio-player'))
    adapter = new MusicPartyAdapter({ origin, nativeInvoke: invoke }); player = new NativeAudioPlayer(invoke)
    let snapshot, localQueue, reconnects = 0
    adapter.subscribe(e => { if(e.type === 'playback') snapshot = e.snapshot; if(e.type === 'queue-state') localQueue = e; if(e.type === 'connection' && e.status === 'reconnecting') reconnects++ })
    adapter.bindPlayer(player, () => player.setAudioFocus(true))
    const invite = await adminRequest('/api/dev/rooms/lounge/invites', { label: 'isolated acceptance' })
    await adapter.redeemInvite(invite.code)
    const status = () => invoke('musicPartyAudio', { input: { playerId: player.id, command: { action: 'status' } } })
    const progressing = async label => { await until(async () => { try { const s = await status(); return s.loaded && !s.paused && s.position > .2 } catch { return false } }, label); const a = await status(); await wait(450); const b = await status(); assert.ok(b.position > a.position + .1, label); return b.position }
    console.log(JSON.stringify({ check: 'entry-without-enqueue', position: await progressing('initial playback'), evidence: 'Electron IPC + Rust + real libmpv; audible output not measured' }))
    offline = true; for (const s of [...sockets]) if(s !== admin) s.terminate()
    await until(() => reconnects > 0, 'transport loss detected')
    await enqueue('2'); await enqueue('3')
    offline = false
    await until(() => snapshot?.item?.id === '2', 'second track after reconnect', 35000)
    console.log(JSON.stringify({ check: 'reconnected-track-2', position: await progressing('track 2') }))
    await until(() => snapshot?.item?.id === '3', 'third track', 20000)
    console.log(JSON.stringify({ check: 'continuous-track-3', position: await progressing('track 3'), reconnects }))
    dropPatch = true; await enqueue('4'); await until(() => dropped === 1, 'one dropped queue patch'); await enqueue('5')
    await until(() => resyncs > 0 && localQueue?.queueVersion === queueVersion, 'queue gap recovered')
    console.log(JSON.stringify({ check: 'queue-gap-real-server', dropped, resyncs, queueVersion }))
    const wpReservation = createServer(); const wpOrigin = await listen(wpReservation); await new Promise(r => wpReservation.close(r))
    const wpService = start('node', [join(root, 'server/main.ts')], { cwd: root, stdio: 'ignore', env: {
      ...env, HOST: '127.0.0.1', PORT: new URL(wpOrigin).port, NODE_ENV: 'test', OPENLIST_URL: 'http://127.0.0.1:1',
      WATCHPARTY_MEDIA_ID_KEY: randomUUID(), SSL_KEY_FILE: '', SSL_CRT_FILE: '',
    } })
    await until(async () => { assert.equal(wpService.exitCode, null, 'isolated WatchParty exited'); try { return (await fetch(wpOrigin + '/ping')).ok } catch { return false } }, 'isolated WatchParty ready')
    let wpState
    const onState = (name, value) => { if(name === 'desktop://state') wpState = value.state }
    native.on('event', onState)
    try {
      await promisify(execFile)(join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/usr/bin/openssl.exe'), [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'focus.key'), '-out', join(dir, 'focus.pem'), '-days', '1',
        '-subj', '/CN=WatchParty isolated focus acceptance', '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE',
      ], { windowsHide: true })
      const certificate = await readFile(join(dir, 'focus.pem'), 'utf8')
      const focusWav = pcm(45)
      const https = createHttpsServer({ key: await readFile(join(dir, 'focus.key')), cert: certificate }, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': focusWav.length }); res.end(focusWav)
      }); servers.push(https)
      const httpsOrigin = (await listen(https)).replace('http:', 'https:')
      await invoke('importOriginTrust', { origin: httpsOrigin, pem: certificate })
      const settings = await invoke('getDesktopSettings')
      await invoke('updateDesktopSettings', { input: { backendOrigin: wpOrigin, nickname: 'Acceptance', theme: 'dark', playerPreferences: settings.playerPreferences } })
      await invoke('createDesktopRoom', { input: { nickname: 'Acceptance', initialMedia: { kind: 'http', url: `${httpsOrigin}/tone.wav`, title: 'Generated focus tone' } } })
      await until(() => wpState?.player?.loaded, 'WatchParty media loaded')
      const playAck = await invoke('executeRoomCommand', { command: { type: 'play' } })
      assert.equal(playAck.ok, true, `WatchParty play ACK: ${playAck.error?.code}`)
      try { await until(() => wpState?.player?.loaded && !wpState.player.paused && wpState.player.time > .2, 'WatchParty owns focus') }
      catch(error) { console.log(JSON.stringify({ check: 'focus-diagnostic', loaded: wpState?.player?.loaded, paused: wpState?.player?.paused, time: wpState?.player?.time, errorCode: wpState?.error?.code, roomPaused: wpState?.room?.paused })); throw error }
      assert.equal((await status()).paused, true)
      await player.setAudioFocus(true)
      await until(() => wpState?.player?.paused, 'MusicParty suspends WatchParty locally')
      assert.equal(wpState.room.paused, false, 'focus must not pause the shared room')
      await progressing('MusicParty focus restored')
      await invoke('executeRoomCommand', { command: { type: 'playerVisibility', visible: true } })
      await until(() => wpState?.player && !wpState.player.paused, 'WatchParty focus restored')
      assert.equal((await status()).paused, true)
      console.log('CROSS_PRODUCT_REAL_LIBMPV_FOCUS_OK')
    } finally {
      await invoke('stopDesktopSession').catch(() => {})
      native.off('event', onState)
    }
    await adapter.disconnect(); await player.dispose()
    await invoke('stopDesktopSession').catch(() => {})
    await window.loadURL('watchparty-app://desktop/index.html')
    await runServiceAcceptance({ window, native, invoke, exe, dir, env, start, servers, listen, until, pcm })
    const childArgs = process.defaultApp ? [app.getAppPath()] : []
    childArgs.push(`--acceptance-profile=${app.getPath('userData')}`)
    const peerEnv = { ...process.env }; delete peerEnv.ELECTRON_RUN_AS_NODE
    const second = start(process.execPath, [...childArgs, 'watchparty://room-second-instance'], { stdio: 'ignore', env: peerEnv })
    assert.equal((await once(second, 'exit'))[0], 0)
    await until(async () => (await invoke('currentDesktopLaunch'))?.roomId === 'room-second-instance', 'real second instance deep link')
    assert.equal(window.isDestroyed(), false)
    console.log('ELECTRON_SECOND_INSTANCE_DEEP_LINK_OK')
    const exec = promisify(execFile)
    const backup = join(dir, 'watchparty-protocol.reg')
    let hadRegistration = false
    try { await exec('reg.exe', ['export', 'HKCU\\Software\\Classes\\watchparty', backup, '/y'], { windowsHide: true }); hadRegistration = true } catch(error) { if(error.code !== 1) throw error }
    try {
      assert.equal(app.setAsDefaultProtocolClient('watchparty', process.execPath, childArgs), true)
      assert.equal(app.isDefaultProtocolClient('watchparty', process.execPath, childArgs), true)
      await shell.openExternal('watchparty://room-os-protocol')
      await until(async () => (await invoke('currentDesktopLaunch'))?.roomId === 'room-os-protocol', 'OS protocol dispatch')
      console.log('WINDOWS_OS_PROTOCOL_WARM_LAUNCH_OK')
    } finally {
      if(hadRegistration) await exec('reg.exe', ['import', backup], { windowsHide: true })
      else assert.equal(app.removeAsDefaultProtocolClient('watchparty', process.execPath, childArgs), true)
    }
    console.log('ELECTRON_REAL_SERVER_ACCEPTANCE_OK')
  } finally {
    await adapter?.disconnect(); await player?.dispose().catch(() => {})
    if(origin) await invoke('clearMusicPartySession', { origin }).catch(() => {})
    for(const socket of sockets) socket.terminate()
    for(const server of servers) { server.closeAllConnections(); await new Promise(r => server.close(r)) }
    for(const child of children.reverse()) if(child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit }
    console.log('ACCEPTANCE_PROCESSES_STOPPED; temporary generated data retained')
  }
}
