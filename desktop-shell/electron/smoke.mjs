import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as wait } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** Exercises the real sandboxed preload, Electron IPC, Rust process and libmpv DLL. */
export async function runSmoke(window, native) {
  async function until(check, label, timeout = 5000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await check()) return
      await wait(50)
    }
    throw new Error(label)
  }
  window.showInactive()
  await wait(400)
  const chrome = await window.webContents.executeJavaScript(`(() => {
    const bar = document.getElementById('watchparty-titlebar');
    return { drag: getComputedStyle(bar).getPropertyValue('-webkit-app-region'),
      height: bar.getBoundingClientRect().height, top: document.getElementById('root').getBoundingClientRect().top,
      nativeControls: navigator.windowControlsOverlay.visible,
      controls: Array.from(bar.querySelectorAll('.wpc-btn')).map(node => node.getAttribute('aria-label')) };
  })()`)
  console.log(JSON.stringify({ windowChrome: chrome }))
  assert.equal(chrome.drag, 'drag'); assert.equal(chrome.height, 48)
  assert.equal(chrome.top, 48)
  // 原生 WCO 已拆（播放页要整屏），窗口按钮改成页面自绘的三个。
  assert.equal(chrome.nativeControls, false, `原生窗口按钮还在: ${JSON.stringify(chrome)}`)
  assert.deepEqual(chrome.controls, ['最小化', '最大化', '关闭'], `顶栏不是自绘的三个按钮: ${JSON.stringify(chrome)}`)
  await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === '设置')
    if (!button) throw new Error('settings_navigation_missing')
    button.click()
  })()`)
  await wait(100)
  const fluentSettings = await window.webContents.executeJavaScript(`(() => ({
    provider: Boolean(document.querySelector('.fluent-settings-provider')),
    tabs: document.querySelectorAll('.fluent-settings-nav [role="tab"]').length,
    themeSwitch: Boolean(document.querySelector('.fluent-settings-content [role="switch"]')),
  }))()`)
  assert.deepEqual(fluentSettings, { provider: true, tabs: 5, themeSwitch: true })
  await window.webContents.executeJavaScript(`(() => {
    const tab = [...document.querySelectorAll('.fluent-settings-nav [role="tab"]')].find(item => item.textContent?.includes('播放'))
    if (!tab) throw new Error('playback_tab_missing')
    tab.click()
  })()`)
  await until(
    () => window.webContents.executeJavaScript("Boolean(document.querySelector('.fluent-settings-content [role=\"combobox\"]'))"),
    'playback_settings_not_ready'
  )
  await window.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('.desktop-page')
    window.__dropdownOverflow = []
    let frames = 0
    const sample = () => {
      window.__dropdownOverflow.push(page.scrollWidth - page.clientWidth)
      if (++frames < 20) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    const dropdown = document.querySelector('.fluent-settings-content [role="combobox"]')
    if (!dropdown) throw new Error('fluent_dropdown_missing')
    dropdown.click()
  })()`)
  await wait(150)
  const dropdownState = await window.webContents.executeJavaScript(`(() => {
    const listbox = document.querySelector('[role="listbox"]')
    const portal = listbox?.closest('.fui-FluentProvider')
    const page = document.querySelector('.desktop-page')
    window.__dropdownOverflow.push(page.scrollWidth - page.clientWidth)
    const root = document.getElementById('root').getBoundingClientRect()
    const body = document.body.getBoundingClientRect()
    const heading = document.querySelector('.fluent-settings-heading').getBoundingClientRect()
    return { listbox: Boolean(listbox), portalUsesShellGrid: Boolean(portal?.classList.contains('desktop-shell-grid')), overflow: Math.max(...window.__dropdownOverflow), root: { width: root.width, height: root.height }, body: { width: body.width, height: body.height }, heading: { width: heading.width, height: heading.height } }
  })()`)
  assert.equal(dropdownState.listbox, true)
  assert.equal(dropdownState.portalUsesShellGrid, false, 'dropdown portal must not inherit the application shell layout')
  assert.ok(dropdownState.overflow <= 1, 'dropdown must not create horizontal overflow')
  assert.ok(dropdownState.heading.width > 0 && dropdownState.heading.height > 0, 'settings content remains visible while dropdown is open')
  await window.webContents.executeJavaScript(`(() => {
    document.querySelector('[role="combobox"]')?.blur()
    const control = document.querySelector('.fluent-settings-volume')
    // Fluent's Slider renders a focusable role="slider" thumb rather than an <input type=range>,
    // so drive it with the key a user would press and keep the real keyboard path under test.
    const slider = control?.querySelector('[role="slider"]')
    if (!control || !slider) throw new Error('fluent_volume_slider_missing')
    slider.focus()
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
  })()`)
  await wait(50)
  const restoredVolume = await window.webContents.executeJavaScript(`(() => {
    const control = document.querySelector('.fluent-settings-volume')
    const before = control?.textContent?.trim()
    control?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return { before }
  })()`)
  await wait(50)
  restoredVolume.after = await window.webContents.executeJavaScript("document.querySelector('.fluent-settings-volume')?.textContent?.trim()")
  assert.notEqual(restoredVolume.before, '30%', 'keyboard volume adjustment must update the draft')
  assert.equal(restoredVolume.after, '30%', 'double-click must restore the default volume draft')
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('watchparty-titlebar').querySelector('.wpc-title').textContent"), 'Banguru')
  assert.equal(window.getTitle(), 'Banguru')
  const lobbyLayout = await window.webContents.executeJavaScript(`(() => {
    const shell = document.querySelector('.desktop-shell-grid').getBoundingClientRect()
    const sidebar = document.querySelector('.desktop-sidebar').getBoundingClientRect()
    const settings = document.querySelector('.desktop-settings-link').getBoundingClientRect()
    return { shellBottom: shell.bottom, sidebarBottom: sidebar.bottom, sidebarRight: sidebar.right, settingsRight: settings.right, settingsBottom: settings.bottom, settingsHeight: settings.height }
  })()`)
  assert.equal(lobbyLayout.settingsBottom, lobbyLayout.sidebarBottom)
  // The settings row is full-bleed by design (index.css: margin-inline:-12px with
  // padding-inline:12px), so its right edge meets the sidebar's; anything past it is overflow.
  assert.ok(lobbyLayout.sidebarRight >= lobbyLayout.settingsRight)
  assert.equal(lobbyLayout.settingsHeight, 64)
  if (process.platform === 'win32') {
    const handle = window.getNativeWindowHandle()
    const hwnd = handle.readBigUInt64LE().toString()
    const width = window.getSize()[0]
    const script = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CaptionProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static long Hit(long handle, int x, int y) {
    var h = new IntPtr(handle); Rect r; GetWindowRect(h, out r);
    double scale = GetDpiForWindow(h) / 96.0;
    int px = r.Left + (int)(x * scale), py = r.Top + (int)(y * scale);
    return SendMessage(h, 0x84, IntPtr.Zero, new IntPtr((py << 16) | (px & 0xffff))).ToInt64();
  }
}
'@
Write-Output ([CaptionProbe]::Hit(${hwnd}, 150, 16))
Write-Output ([CaptionProbe]::Hit(${hwnd}, $width - 20, 16))`
    // Async child execution keeps Electron's main thread free to answer WM_NCHITTEST.
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 15000 })
    const [dragRegion, corner] = stdout.trim().split(/\r?\n/).map(Number)
    assert.equal(dragRegion, 2, 'Windows must return HTCAPTION for the drag region')
    // 8/9/20 = HTMINBUTTON/HTMAXBUTTON/HTCLOSE：右上角还有原生窗口按钮就说明 WCO 又回来了，
    // 而它无法在运行时收起来（播放页要求整屏无顶栏）。
    assert.equal([8, 9, 20].includes(corner), false, `右上角还有原生窗口按钮: ${corner}`)
    console.log('WINDOWS_CAPTION_HIT_TEST_OK')
    console.log('WINDOWS_TOP_RIGHT_HIT ' + JSON.stringify({ corner }))
  }
  // 顶栏按钮是自绘的（原生 WCO 拆掉了，否则播放页收不起顶栏）：形状 + 最大化往返。
  const chromeButtons = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#watchparty-titlebar .wpc-btn')).map(node => node.getAttribute('aria-label'))`)
  assert.deepEqual(chromeButtons, ['最小化', '最大化', '关闭'], `顶栏按钮不是自绘的三个: ${JSON.stringify(chromeButtons)}`)
  await window.webContents.executeJavaScript(`window.watchpartyDesktop.invoke('windowControl', { action: 'maximize' })`)
  await wait(500)
  assert.equal(window.isMaximized(), true, '自绘的最大化没有生效')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#watchparty-titlebar .wpc-maximize').getAttribute('aria-label')`), '向下还原', '最大化后按钮没有变成还原字形')
  await window.webContents.executeJavaScript(`window.watchpartyDesktop.invoke('windowControl', { action: 'maximize' })`)
  await wait(500)
  assert.equal(window.isMaximized(), false, '自绘的还原没有生效')
  console.log('WINDOWS_CUSTOM_CAPTION_BUTTONS_OK')
  assert.equal(window.isResizable(), true)
  window.setFullScreen(true)
  await wait(250)
  console.log(JSON.stringify({ fullscreen: window.isFullScreen(), captionDisplay: await window.webContents.executeJavaScript("getComputedStyle(document.getElementById('watchparty-titlebar')).display") }))
  assert.equal(await window.webContents.executeJavaScript("getComputedStyle(document.getElementById('watchparty-titlebar')).display"), 'none')
  window.setFullScreen(false)
  await wait(250)
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('root').getBoundingClientRect().top"), 48)
  console.log('ELECTRON_WINDOW_CHROME_OK')
  const invoke = (command, args = {}) => window.webContents.executeJavaScript(`window.watchpartyDesktop.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`)
  assert.deepEqual(await window.webContents.executeJavaScript('[typeof require, typeof process, window.watchpartyDesktop.runtime]'), ['undefined', 'undefined', 'electron'])
  await assert.rejects(invoke('__shutdown'))
  await invoke('updateDesktopWindowChrome', { title: 'Linkle', theme: 'light', windowMaterial: 'none' })
  assert.equal(window.getTitle(), 'Linkle')
  await assert.rejects(invoke('updateDesktopWindowChrome', { title: 'WatchParty', theme: 'dark', windowMaterial: 'auto' }))
  await assert.rejects(invoke('updateDesktopWindowChrome', { title: 'Banguru', theme: 'dark', windowMaterial: 'mica' }))
  await invoke('updateDesktopWindowChrome', { title: 'Banguru', theme: 'dark', windowMaterial: 'auto' })
  // Windows may reserve the default fixture port, so the runner can hand us its own origin.
  const backendOrigin = process.env.WATCHPARTY_SMOKE_BACKEND_ORIGIN ?? 'http://127.0.0.1:18082'
  const settings = await invoke('getDesktopSettings')
  // The check runs in a throwaway profile, so what matters is that it is not already pointing at
  // the fixture. A fresh install may legitimately carry a shipped default origin.
  assert.notEqual(settings.backendOrigin, backendOrigin, 'the smoke profile must start away from its own fixture')
  const configuredSettings = await invoke('updateDesktopSettings', { input: {
    backendOrigin, nickname: settings.nickname,
    theme: settings.theme, windowMaterial: settings.windowMaterial,
    playerPreferences: settings.playerPreferences,
  } })
  assert.equal(configuredSettings.backendOrigin, backendOrigin)
  await invoke('verifyBackend')
  // 通用媒体通道（P1-1）：白名单内的路由原样带回 {status, body}，白名单外/错动词由 sidecar 拒绝。
  const capabilities = await invoke('mediaRequest', { method: 'GET', path: '/api/media/capabilities', query: null, body: null })
  assert.equal(capabilities.status, 200, JSON.stringify(capabilities))
  assert.equal(JSON.parse(capabilities.body).libraries, true)
  const libraries = await invoke('mediaRequest', { method: 'GET', path: '/api/media/libraries', query: null, body: null })
  assert.equal(libraries.status, 200, JSON.stringify(libraries))
  const libraryRows = JSON.parse(libraries.body).libraries
  assert.ok(Array.isArray(libraryRows) && libraryRows.length >= 1, JSON.stringify(libraryRows))
  assert.equal(typeof libraryRows[0].id, 'string')
  console.log('MEDIA_LIBRARIES ' + JSON.stringify({ capabilities: JSON.parse(capabilities.body), libraries: libraryRows.map(row => ({ id: row.id, kind: row.kind, health: row.health })) }))
  for (const attempt of [
    { method: 'GET', path: '/api/media/roots', query: null, body: null },
    { method: 'POST', path: '/api/media/list', query: null, body: {} },
    // 相位 3 起 catalog 是开的；仍要关着的是这些（错动词 / 别的 surface）
    { method: 'DELETE', path: '/api/media/catalog', query: null, body: null },
    { method: 'GET', path: '/api/media/posters/9', query: null, body: null },
    { method: 'POST', path: '/api/admin/media-libraries/lib_anime/scrape/extra', query: null, body: null },
    { method: 'GET', path: '/api/desktop/v1/health', query: null, body: null },
  ]) {
    const denied = await invoke('mediaRequest', attempt).then(() => null, error => error)
    assert.equal(denied?.code, 'MEDIA_ROUTE_DENIED', `${attempt.method} ${attempt.path} → ${JSON.stringify(denied)}`)
  }
  const audioDevices = await invoke('listAudioOutputDevices')
  assert.ok(Array.isArray(audioDevices), 'native audio enumeration must return an array')
  for (const device of audioDevices) {
    assert.equal(typeof device.id, 'string')
    assert.ok(device.id.length > 0)
    assert.equal(typeof device.name, 'string')
    assert.ok(device.name.length > 0)
  }
  await assert.rejects(invoke('listAudioOutputDevices', { unexpected: true }))
  console.log(JSON.stringify({ nativeAudioOutputDevices: audioDevices.length }))
  // The package runner owns this fixture and may have to move it off a Windows-reserved port.
  const healthOrigin = process.env.WATCHPARTY_SMOKE_HEALTH_ORIGIN ?? 'http://127.0.0.1:18081'
  const health = await invoke('musicPartyRequest', { input: { origin: healthOrigin, path: '/api/desktop/v1/health', method: 'GET', body: null, clientVersion: '0.2.0' } })
  assert.deepEqual(Object.keys(health).sort(), ['body', 'status'])
  await assert.rejects(invoke('musicPartyRequest', { input: { origin: healthOrigin, path: '/.env', method: 'GET', body: null, clientVersion: '0.2.0' } }))
  await native.request('__launch', { url: 'watchparty://room-electron-smoke' })
  assert.equal((await invoke('currentDesktopLaunch')).roomId, 'room-electron-smoke')
  await assert.rejects(native.request('__launch', { url: 'watchparty://room-electron-smoke?ticket=forbidden' }))
  // Generated PCM, no existing media or credentials. Silence avoids disturbing the user.
  const seconds = 8, rate = 48000, samples = seconds * rate
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40)
  const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length }); response.end(wav) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const playerId = randomUUID()
  const audio = command => invoke('musicPartyAudio', { input: { playerId, command } })
  try {
    await audio({ action: 'load', itemId: 'generated', url: `http://127.0.0.1:${server.address().port}/generated.wav` })
    await audio({ action: 'snapshot', itemId: 'generated', position: 0, playing: true })
    await audio({ action: 'focus', active: true })
    await wait(900)
    const playing = await audio({ action: 'status' })
    assert.equal(playing.loaded, true); assert.equal(playing.paused, false); assert.ok(playing.position > 0.2)
    await audio({ action: 'snapshot', itemId: 'generated', position: 2, playing: false })
    await wait(100)
    const paused = await audio({ action: 'status' })
    assert.equal(paused.paused, true); assert.ok(Math.abs(paused.position - 2) < 0.5)
    await audio({ action: 'dispose' })
    console.log(JSON.stringify({ electronIPC: true, localMusicPartyHealth: health.status, realLibmpv: { progress: playing.position, paused: paused.paused }, reconnect: 'not-tested' }))
    await writeFile(join(tmpdir(), 'watchparty-electron-smoke.png'), (await window.webContents.capturePage()).toPNG())
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}
