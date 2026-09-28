import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron'
import { basename, dirname, join, resolve, relative, isAbsolute, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { SidecarClient } from './sidecar-client.mjs'
import policy from './policy.cjs'
import { fetchArtworkImage } from './artwork.mjs'
import { getWallpaperBackdrop } from './wallpaper.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const directory = dirname(fileURLToPath(import.meta.url))
// Separate application identity and data directory preserve the user's Tauri client.
app.setName('Banguru')
const smoke = process.argv.includes('--smoke') || process.argv.includes('--conditions=watchparty-smoke')
const acceptance = process.argv.includes('--acceptance')
const linkleCheck = process.argv.includes('--linkle-check')
const startupCheck = process.argv.includes('--startup-check')
const setupGuideCheck = process.argv.includes('--setup-guide-check')
const mediaCheck = process.argv.includes('--media-check')
const protocolProbe = process.argv.find(arg => arg.startsWith('--protocol-probe='))?.slice('--protocol-probe='.length)
const acceptanceProfile = protocolProbe ?? process.argv.find(arg => arg.startsWith('--acceptance-profile='))?.slice('--acceptance-profile='.length)
if (acceptanceProfile && (dirname(resolve(acceptanceProfile)) !== resolve(tmpdir()) || !basename(acceptanceProfile).startsWith('watchparty-electron-smoke-'))) throw new Error('invalid_acceptance_profile')
app.setPath('userData', acceptanceProfile ?? (smoke || acceptance || linkleCheck || startupCheck || setupGuideCheck || mediaCheck ? mkdtempSync(join(tmpdir(), 'watchparty-electron-smoke-')) : join(app.getPath('appData'), 'WatchParty-Electron-Local')))
protocol.registerSchemesAsPrivileged([{ scheme: 'watchparty-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const entry = 'watchparty-app://desktop/index.html'
let window
let native
let stopping = false
let latestLaunch
let appliedWindowMaterial = 'none'
let assetServer
let assetOrigin
const pendingLinks = []
function applyWindowMaterial(material) {
  if (!window || typeof window.setBackgroundMaterial !== 'function') throw new Error('window_material_unsupported')
  const nativeMaterial = material === 'auto' ? 'mica' : 'none'
  window.setBackgroundMaterial(nativeMaterial)
  appliedWindowMaterial = nativeMaterial
}
const deepLinks = args => args.filter(arg => arg.startsWith('watchparty://'))
async function openLink(url) {
  if (!native) { pendingLinks.push(url); return }
  try {
    latestLaunch = await native.request('__launch', { url })
    window?.webContents.send('desktop://launch', latestLaunch)
    window?.show(); window?.restore(); window?.focus()
  } catch {}
}
// Explicit opt-in so opening a portable test build never steals the OS association.
if (process.argv.includes('--register-deep-link')) {
  void app.whenReady().then(() => {
    const args = process.defaultApp ? [app.getAppPath()] : []
    if (protocolProbe) args.push(`--protocol-probe=${protocolProbe}`)
    const ok = app.setAsDefaultProtocolClient('watchparty', process.execPath, args)
      && app.isDefaultProtocolClient('watchparty', process.execPath, args)
    console.log(ok ? 'WATCHPARTY_PROTOCOL_REGISTERED' : 'WATCHPARTY_PROTOCOL_REGISTRATION_FAILED')
    app.exit(ok ? 0 : 1)
  })
} else if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', (_event, argv) => {
    if (acceptance) console.log(JSON.stringify({ check: 'second-instance-shape', links: argv.filter(arg => /^watchparty:/i.test(arg)).map(arg => { try { const u = new URL(arg); return { scheme: u.protocol, path: u.pathname, hasQuery: Boolean(u.search) } } catch { return { invalid: true } } }) }))
    window?.show(); window?.restore(); window?.focus()
    const links = deepLinks(argv)
    if (links.length === 1) void openLink(links[0])
  })
  app.on('open-url', (event, url) => { event.preventDefault(); void openLink(url) })
  app.on('before-quit', event => {
    if (stopping) return
    event.preventDefault(); stopping = true
    void native?.close().finally(() => app.quit())
    if (!native) app.quit()
  })
  void app.whenReady().then(async () => {
  if (smoke) console.log('ELECTRON_SMOKE_READY')
  const assets = resolve(directory, '../dist-electron')
  protocol.registerFileProtocol('watchparty-app', (request, callback) => {
    const url = new URL(request.url)
    if (url.host !== 'desktop' || request.method !== 'GET') return callback({ error: -6 })
    let pathname
    try { pathname = decodeURIComponent(url.pathname) } catch { return callback({ error: -6 }) }
    const target = resolve(assets, '.' + pathname)
    const rel = relative(assets, target)
    if (rel.startsWith('..') || isAbsolute(rel)) return callback({ error: -6 })
    callback({ path: target })
  })
  assetServer = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
      // 库封面（phase 2）：渲染层的 <img> 打到这个只读路由，主进程让侧车带站点凭据取字节，
      // 再把字节当成同源图片发出去。渲染层因此既不碰后端地址，也不拿 data URL。
      const artwork = /^\/artwork\/(media|poster)\/([^/]+)$/.exec(pathname)
      if (artwork) {
        if (request.method !== 'GET') return response.writeHead(404).end()
        try {
          const image = await native.request('mediaImage', { kind: artwork[1], id: artwork[2] })
          const bytes = Buffer.from(image?.base64 ?? '', 'base64')
          if (!bytes.byteLength) return response.writeHead(404).end()
          response.writeHead(200, {
            'Content-Type': image?.contentType ?? 'application/octet-stream',
            'Content-Length': bytes.byteLength,
            'Cache-Control': 'private, max-age=300',
            'X-Content-Type-Options': 'nosniff',
          })
          response.end(bytes)
        } catch {
          // 取不到图就是没有封面：卡片自己会退回图标，不用把这当成页面错误。
          response.writeHead(404, { 'Cache-Control': 'no-store' }).end()
        }
        return
      }
      const target = resolve(assets, `.${pathname}`)
      const rel = relative(assets, target)
      if (rel.startsWith('..') || isAbsolute(rel) || request.method !== 'GET') return response.writeHead(404).end()
      const body = await readFile(target)
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }
      response.writeHead(200, { 'Content-Type': types[extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
      response.end(body)
    } catch { response.writeHead(404).end() }
  })
  await new Promise(resolveServer => assetServer.listen(0, '127.0.0.1', resolveServer))
  assetOrigin = `http://127.0.0.1:${assetServer.address().port}`
  window = new BrowserWindow({
    width: 1300, height: 800, minWidth: 960, minHeight: 640, title: 'Banguru',
    show: false, transparent: false, backgroundColor: '#202020',
    // 顶栏整条由页面画（preload 注入的 #watchparty-titlebar）。原生 WCO 一旦启用就
    // 无法在运行时收起来（setTitleBarOverlay 只改样式不摘按钮），而播放页要求整屏
    // 无顶栏 ⇒ 原生按钮改成自绘，播放时随播放控件一起隐藏。
    titleBarStyle: 'hidden',
    webPreferences: { preload: join(directory, 'preload-built.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  })
  applyWindowMaterial('auto')
  window.setMenu(null)
  window.on('enter-full-screen', () => window.webContents.send('watchparty:fullscreen', true))
  window.on('leave-full-screen', () => window.webContents.send('watchparty:fullscreen', false))
  window.on('maximize', () => window.webContents.send('watchparty:window-state', { maximized: true }))
  window.on('unmaximize', () => window.webContents.send('watchparty:window-state', { maximized: false }))
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: {
    ...details.responseHeaders,
    'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'"],
  } }))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(JSON.stringify({ event: 'did-fail-load', errorCode, errorDescription, validatedURL }))
  })
  window.webContents.once('dom-ready', () => window.show())
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(JSON.stringify({ event: 'render-process-gone', reason: details.reason, exitCode: details.exitCode }))
    app.quit()
  })
  const handle = window.getNativeWindowHandle()
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString()
  native = new SidecarClient(join(directory, 'native', 'watchparty-native-sidecar.exe'), [app.getPath('userData'), hwnd])
  native.on('event', (name, payload) => {
    if (name === '__fullscreen' && typeof payload === 'boolean') window.setFullScreen(payload)
    if (policy.events.includes(name)) window.webContents.send(name, payload)
  })
  native.on('closed', () => { console.error(JSON.stringify({ event: 'native-closed', stopping })); if (!stopping) app.quit() })
  // Artwork is fetched from platform CDNs. Only the isolated acceptance profiles
  // point at a loopback fixture, and they generate their own certificate, so the
  // verification bypass is scoped to those runs and to loopback literals.
  const harnessLoopback = smoke || acceptance || linkleCheck
  if (harnessLoopback) window.webContents.session.setCertificateVerifyProc((request, callback) => {
    const host = request.hostname?.toLowerCase() ?? ''
    callback(host === 'localhost' || host === '127.0.0.1' || host === '::1' ? 0 : -3)
  })
  ipcMain.handle('watchparty:request', async (event, command, args) => {
    const frameUrl = event.senderFrame?.url ?? ''
    const trustedFrame = frameUrl === `${assetOrigin}/index.html`
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !trustedFrame || !policy.validRequest(command, args)) {
      return { error: 'invalid_desktop_request' }
    }
    try {
      if (command === 'currentDesktopLaunch' && latestLaunch) return { result: latestLaunch }
      if (command === 'updateDesktopWindowChrome') {
        window.setTitle(args.title)
        applyWindowMaterial(args.windowMaterial)
        return { result: null }
      }
      if (command === 'windowControl') {
        if (args.action === 'minimize') window.minimize()
        else if (args.action === 'close') window.close()
        else if (window.isMaximized()) window.unmaximize()
        else window.maximize()
        return { result: { maximized: window.isMaximized() } }
      }
      if (command === 'getDesktopWallpaperBackdrop') {
        const backdrop = await getWallpaperBackdrop()
        return { result: { image: backdrop?.dataUrl ?? null, average: backdrop?.average ?? null } }
      }
      if (command === 'getDesktopWindowMaterial') return { result: appliedWindowMaterial }
      if (command === 'fetchArtworkImage') return { result: { dataUrl: await fetchArtworkImage(args.url, { allowLoopback: harnessLoopback }) } }
      // 导出落盘（歌单导出）：路径由系统保存对话框决定，渲染层只给建议名/后缀/正文。
      if (command === 'saveTextFile') {
        const filters = { txt: [{ name: '文本文件', extensions: ['txt'] }], csv: [{ name: 'CSV 表格', extensions: ['csv'] }], json: [{ name: 'JSON 数据', extensions: ['json'] }] }[args.extension]
        const picked = await dialog.showSaveDialog(window, { title: '导出当前队列', defaultPath: `${args.suggestedName}.${args.extension}`, filters })
        if (picked.canceled || !picked.filePath) return { result: { saved: false } }
        await writeFile(picked.filePath, args.text, 'utf8')
        return { result: { saved: true, path: picked.filePath } }
      }
      if (command === 'getLinkleDevConfig') return { result: {
        origin: process.env.LINKLE_DEV_ORIGIN?.trim() || null,
        roomId: process.env.LINKLE_DEV_ROOM?.trim() || null,
        invite: process.env.LINKLE_DEV_INVITE?.trim() || null,
      } }
      return { result: await native.request(command, args) }
    } catch (error) {
      // 侧车错误是 {code, message}：码必须一起回到渲染层（UI 按码做映射，不解析 message）。
      if (error instanceof Error) return { error: { message: error.message } }
      if (error && typeof error === 'object' && typeof error.code === 'string') return { error: { code: error.code, message: error.message ?? error.code } }
      return { error }
    }
  })
  window.on('closed', () => { assetServer?.close(); app.quit() })
  const links = deepLinks(process.argv)
  if (links.length === 1) pendingLinks.push(links[0])
  for (const url of pendingLinks.splice(0)) await openLink(url)
  const loadTimeout = setTimeout(() => {
    console.error(JSON.stringify({ event: 'load-timeout', url: entry }))
    stopping = true
    void native.close().finally(() => app.exit(1))
  }, 15000)
  try {
    await window.loadURL(`${assetOrigin}/index.html`)
  } finally {
    clearTimeout(loadTimeout)
  }
  console.log(JSON.stringify({ event: 'did-finish-load', url: window.webContents.getURL() }))
  window.show()
  if (startupCheck) {
    try {
      const ready = await window.webContents.executeJavaScript(`Promise.all([
        window.watchpartyDesktop.invoke('getDesktopSettings'),
        window.watchpartyDesktop.invoke('getDesktopWindowMaterial'),
      ]).then(([settings, material]) => Boolean(settings?.playerPreferences && ['mica', 'none'].includes(material)))`)
      if (!ready) throw new Error('desktop_startup_check_failed')
      console.log('ELECTRON_STARTUP_CHECK_OK')
      stopping = true
      await native.close()
      app.exit(0)
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'desktop_startup_check_failed')
      stopping = true
      await native.close()
      app.exit(1)
    }
    return
  }
  // 首启向导检查必须跑在全新 profile 上：它断言的就是「完成位 false → 向导顶在首屏」。
  // 因此单独一个分支，不能并进下面那个会先种 setupCompleted:true 的 harness 块。
  if (setupGuideCheck) {
    try {
      const { runSetupGuideCheck } = await import('./setup-guide-check.mjs')
      await runSetupGuideCheck(window, native)
      console.log('ELECTRON_SETUP_GUIDE_CHECK_OK')
      stopping = true
      await native.close()
      app.exit(0)
    } catch (error) {
      console.error(error instanceof Error ? error.stack ?? error.message : `electron_check_rejected ${JSON.stringify(error) ?? String(error)}`)
      console.error('ELECTRON_SETUP_GUIDE_CHECK_FAILED')
      stopping = true
      await native.close()
      app.exit(1)
    }
    return
  }
  // 媒体库（多源 phase 1）对着真实本地栈跑：真库、真文件、真截图。
  if (mediaCheck) {
    try {
      const { runMediaCheck } = await import('./media-check.mjs')
      await runMediaCheck(window, native)
      console.log('ELECTRON_MEDIA_CHECK_OK')
      stopping = true
      await native.close()
      app.exit(0)
    } catch (error) {
      console.error(error instanceof Error ? error.stack ?? error.message : `electron_check_rejected ${JSON.stringify(error) ?? String(error)}`)
      console.error('ELECTRON_MEDIA_CHECK_FAILED')
      stopping = true
      await native.close()
      app.exit(1)
    }
    return
  }
  if (protocolProbe) {
    const launch = await window.webContents.executeJavaScript('window.watchpartyDesktop.invoke("currentDesktopLaunch")')
    writeFileSync(join(protocolProbe, 'protocol-result.json'), JSON.stringify({ nativeRoomId: latestLaunch?.roomId, rendererRoomId: launch?.roomId, pid: process.pid }))
    stopping = true
    await native.close()
    app.exit(launch?.roomId ? 0 : 1)
    return
  }
  if (smoke) console.log('ELECTRON_SMOKE_RENDERER_LOADED')
  if (smoke || acceptance || linkleCheck) {
    let failed = false
    // Harness profiles are always brand new, so the shell would treat every check as a first
    // run and mount the setup guide over the lobby. The pre-existing assertions all assume a
    // configured client, so seed the completion flag up front and let the guide's own
    // assertions (G5) flip this flag themselves.
    await window.webContents.executeJavaScript(`window.watchpartyDesktop.invoke('getDesktopSettings').then(settings => window.watchpartyDesktop.invoke('updateDesktopSettings', { input: { backendOrigin: settings.backendOrigin, allowRemoteHttp: settings.allowRemoteHttp, nickname: settings.nickname, theme: settings.theme, windowMaterial: settings.windowMaterial, playerPreferences: settings.playerPreferences, setupCompleted: true } })).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`)
    console.log('ELECTRON_HARNESS_SETUP_SEEDED')
    try {
      if (acceptance || linkleCheck) {
        const { runAcceptance, runLinkleCheck } = await import('./acceptance.mjs')
        if (linkleCheck) await runLinkleCheck(window, native)
        else await runAcceptance(window, native)
      } else {
        const { runSmoke } = await import('./smoke.mjs')
        await runSmoke(window, native)
      }
      console.log('ELECTRON_NATIVE_SMOKE_OK')
    } catch (error) {
      // Native rejections arrive as the sidecar's bare error string, which is not an Error
      // instance; without this the packaged smoke reported a reason-less 'electron_check_failed'.
      if (acceptance || smoke || linkleCheck) console.error(error instanceof Error ? error.stack ?? error.message : `electron_check_rejected ${JSON.stringify(error) ?? String(error)}`)
      console.error('ELECTRON_NATIVE_SMOKE_FAILED')
      failed = true
    } finally {
      stopping = true
      await native.close()
      app.exit(failed ? 1 : 0)
    }
  } else window.show()
  }).catch(error => { console.error(error instanceof Error ? error.stack ?? error.message : error); console.error('desktop_startup_failed'); stopping = true; void native?.close().finally(() => app.exit(1)) })
}
