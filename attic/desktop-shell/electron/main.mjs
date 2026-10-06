import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron'
import { basename, dirname, join, resolve, relative, isAbsolute, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { SidecarClient } from './sidecar-client.mjs'
import policy from './policy.cjs'
import { fetchArtworkImage } from './artwork.mjs'
import { getWallpaperBackdrop } from './wallpaper.mjs'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { desktopProfile } from './profile.mjs'

const directory = dirname(fileURLToPath(import.meta.url))
if (['no-sandbox', 'disable-renderer-sandbox', 'disable-gpu-sandbox'].some(flag => app.commandLine.hasSwitch(flag))) {
  throw new Error('electron_sandbox_required')
}
app.enableSandbox()
// Separate application identity and data directory preserve the user's Tauri client.
app.setName('Banguru')
const appId = 'top.nirotiy.banguru'
const appIcon = join(directory, 'assets', process.platform === 'win32' ? 'banguru-logo.ico' : 'banguru-logo-256.png')
if (process.platform === 'win32') app.setAppUserModelId(appId)
const smoke = process.argv.includes('--smoke') || process.argv.includes('--conditions=watchparty-smoke')
const acceptance = process.argv.includes('--acceptance')
const linkleCheck = process.argv.includes('--linkle-check')
const startupCheck = process.argv.includes('--startup-check')
const setupGuideCheck = process.argv.includes('--setup-guide-check')
const mediaCheck = process.argv.includes('--media-check')
const uiAudit = process.argv.includes('--ui-audit')
const viewShot = process.argv.includes('--view-shot')
const protocolProbe = process.argv.find(arg => arg.startsWith('--protocol-probe='))?.slice('--protocol-probe='.length)
const configureLocal = process.argv.includes('--configure-local')
const configureOrigin = process.argv.find(arg => arg.startsWith('--configure-origin='))?.slice('--configure-origin='.length)
const configureCertificate = process.argv.find(arg => arg.startsWith('--configure-certificate='))?.slice('--configure-certificate='.length)
const configureCredentials = process.argv.includes('--configure-site-credentials')
const acceptanceProfile = protocolProbe ?? process.argv.find(arg => arg.startsWith('--acceptance-profile='))?.slice('--acceptance-profile='.length)
if (acceptanceProfile && (dirname(resolve(acceptanceProfile)) !== resolve(tmpdir()) || !basename(acceptanceProfile).startsWith('watchparty-electron-smoke-'))) throw new Error('invalid_acceptance_profile')
const checking = smoke || acceptance || linkleCheck || startupCheck || setupGuideCheck || mediaCheck || uiAudit || viewShot
const { installed, portable, legacyPath: legacyUserDataPath, userDataPath } = desktopProfile({
  defaultApp: process.defaultApp, executableDirectory: dirname(process.execPath),
  appData: app.getPath('appData'), localAppData: process.env.LOCALAPPDATA, acceptanceProfile, checking,
})
// Native credentials must use the same profile decision, never a caller's inherited flag.
process.env.WATCHPARTY_INSTALLED_PROFILE = installed ? '1' : '0'
// Chromium's Windows single-instance lock is created inside userData. Create the
// directory first so a first launch cannot fail with an opaque access-denied lock error.
mkdirSync(userDataPath, { recursive: true })
if (portable && !existsSync(join(userDataPath, 'settings.json'))) {
  for (const file of ['settings.json', 'trust.json']) {
    const source = join(legacyUserDataPath, file)
    const target = join(userDataPath, file)
    if (existsSync(source) && !existsSync(target)) copyFileSync(source, target)
  }
}
app.setPath('userData', userDataPath)
if (installed) app.setPath('sessionData', userDataPath)
const freshInstalledProfile = installed && !existsSync(join(userDataPath, 'settings.json'))
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

function pemHash(pem) {
  return createHash('sha256').update(pem.replace(/\r\n?/g, '\n'), 'utf8').digest('hex')
}

async function readBundledConnectionProfile() {
  if (!freshInstalledProfile) return null
  try {
    const profilePath = join(directory, 'assets', 'connection-profile.json')
    const profile = JSON.parse(await readFile(profilePath, 'utf8'))
    const origin = new URL(profile.backendOrigin)
    if (profile.formatVersion !== 1 || profile.profileId !== 'vps-default-v1' || origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('invalid_connection_profile')
    if (typeof profile.caAsset !== 'string' || basename(profile.caAsset) !== profile.caAsset || profile.caAsset !== 'vps-root-ca.pem' || !/^[a-f0-9]{64}$/.test(profile.caPemSha256 ?? '')) throw new Error('invalid_connection_profile')
    const pem = await readFile(join(directory, 'assets', profile.caAsset), 'utf8')
    const hash = pemHash(pem)
    if (hash !== profile.caPemSha256) throw new Error('connection_profile_ca_hash_mismatch')
    const credentials = profile.siteBasicAuth
    if (credentials !== undefined && (typeof credentials !== 'object' || typeof credentials.username !== 'string' || typeof credentials.password !== 'string' || !credentials.username.trim() || !credentials.password || credentials.username.length > 256 || credentials.password.length > 4096)) throw new Error('invalid_connection_profile_credentials')
    return { origin: origin.origin, pem, credentials: credentials ? { username: credentials.username, password: credentials.password } : null }
  } catch (error) {
    console.error(`BANGURU_CONNECTION_PROFILE_SKIPPED ${error instanceof Error ? error.message : 'invalid_connection_profile'}`)
    return null
  }
}

async function applyBundledConnectionProfile() {
  const profile = await readBundledConnectionProfile()
  if (!profile) return
  let credentialsWritten = false
  try {
    await native.request('importOriginTrust', { origin: profile.origin, pem: profile.pem })
    const current = await native.request('getDesktopSettings')
    if (current.backendOrigin && current.backendOrigin !== profile.origin) throw new Error('connection_profile_origin_conflict')
    await native.request('updateDesktopSettings', { input: {
      backendOrigin: profile.origin,
      allowRemoteHttp: false,
      nickname: current.nickname,
      theme: current.theme,
      windowMaterial: current.windowMaterial,
      playerPreferences: current.playerPreferences,
      setupCompleted: current.setupCompleted,
    } })
    if (profile.credentials) {
      credentialsWritten = true
      await native.request('setSiteCredentials', { input: profile.credentials })
    }
    console.log(profile.credentials ? 'BANGURU_CONNECTION_PROFILE_APPLIED_WITH_CREDENTIALS' : 'BANGURU_CONNECTION_PROFILE_APPLIED')
  } catch (error) {
    console.error(`BANGURU_CONNECTION_PROFILE_FAILED ${error instanceof Error ? error.message : 'connection_profile_failed'}`)
    if (freshInstalledProfile) {
      if (credentialsWritten) {
        try { await native.request('clearSiteCredentials') } catch {}
      }
      try { await rm(join(userDataPath, 'settings.json'), { force: true }) } catch {}
    }
  }
}
// 进程级兜底（M2 键盘与读屏批）：未捕获异常先收侧车再退出，别留孤儿进程；
// 未处理的 Promise 拒绝只记录日志，不打断正在跑的会话。
process.on('uncaughtException', (error) => {
  console.error(JSON.stringify({ event: 'main-uncaught-exception', message: error instanceof Error ? error.stack ?? error.message : String(error) }))
  stopping = true
  void Promise.resolve(native?.close()).finally(() => app.exit(1))
})
process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({ event: 'main-unhandled-rejection', reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason) }))
})
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
    const executable = process.env.WATCHPARTY_PORTABLE_LAUNCHER ?? process.execPath
    const ok = app.setAsDefaultProtocolClient('watchparty', executable, args)
      && app.isDefaultProtocolClient('watchparty', executable, args)
    console.log(ok ? 'WATCHPARTY_PROTOCOL_REGISTERED' : 'WATCHPARTY_PROTOCOL_REGISTRATION_FAILED')
    app.exit(ok ? 0 : 1)
  })
} else {
  const singleInstanceLock = app.requestSingleInstanceLock()
  if (!singleInstanceLock && process.env.WATCHPARTY_LOCAL_LAUNCH !== '1') {
    app.quit()
  } else {
  if (!singleInstanceLock) console.error(JSON.stringify({ event: 'single-instance-lock-unavailable', localLaunch: true }))
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
    icon: appIcon,
    // 显示窗口不依赖 renderer 的 dom-ready。资源、sidecar 或 IPC 出错时仍需让用户看到
    // Electron 窗口和启动日志，而不是静默停留在后台。
    show: true, transparent: false, backgroundColor: '#202020',
    // 顶栏整条由页面画（preload 注入的 #watchparty-titlebar）。原生 WCO 一旦启用就
    // 无法在运行时收起来（setTitleBarOverlay 只改样式不摘按钮），而播放页要求整屏
    // 无顶栏 ⇒ 原生按钮改成自绘，播放时随播放控件一起隐藏。
    titleBarStyle: 'hidden',
    webPreferences: { preload: join(directory, 'preload-built.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  })
  if (process.platform === 'win32' && process.env.WATCHPARTY_PORTABLE_LAUNCHER) {
    window.setAppDetails({ appId, relaunchDisplayName: 'Banguru',
      relaunchCommand: `"${process.env.WATCHPARTY_PORTABLE_LAUNCHER}"`,
      relaunchIcon: appIcon, relaunchIconIndex: 0 })
  }
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
  await applyBundledConnectionProfile()
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
  const rendererSandboxed = await window.webContents.executeJavaScript('window.watchpartyDesktop?.sandboxed === true')
  if (!rendererSandboxed) throw new Error('electron_renderer_sandbox_missing')
  console.log('ELECTRON_RENDERER_SANDBOX_OK')
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
  if (configureLocal) {
    try {
      const origin = new URL(configureOrigin ?? '')
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('invalid_configuration_origin')
      if (!configureCertificate) throw new Error('certificate_path_required')
      const pem = await readFile(resolve(configureCertificate), 'utf8')
      const trust = await native.request('importOriginTrust', { origin: origin.origin, pem })
      if (trust?.origin !== origin.origin || !/^[a-f0-9]{64}$/.test(trust?.fingerprint ?? '')) throw new Error('certificate_import_failed')
      const current = await native.request('getDesktopSettings')
      const settings = await native.request('updateDesktopSettings', { input: {
        backendOrigin: origin.origin,
        allowRemoteHttp: false,
        nickname: current.nickname,
        theme: current.theme,
        windowMaterial: current.windowMaterial,
        playerPreferences: current.playerPreferences,
        setupCompleted: current.setupCompleted,
      } })
      if (settings?.backendOrigin !== origin.origin) throw new Error('server_settings_not_saved')
      if (configureCredentials) {
        const credentials = await native.request('promptSiteCredentials')
        console.log(credentials ? 'WATCHPARTY_SITE_CREDENTIALS_SAVED' : 'WATCHPARTY_SITE_CREDENTIALS_SKIPPED')
      }
      console.log('WATCHPARTY_LOCAL_CONFIGURATION_OK')
      stopping = true
      await native.close()
      app.exit(0)
    } catch (error) {
      const code = typeof error === 'string' && /^[a-zA-Z0-9_:-]{1,96}$/.test(error)
        ? error
        : error instanceof Error && /^[a-zA-Z0-9_:-]{1,96}$/.test(error.message) ? error.message : 'local_configuration_failed'
      console.error(`WATCHPARTY_LOCAL_CONFIGURATION_FAILED ${code}`)
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
  // UI/UX 排查（M0）：对比度、焦点可见性、Tab 序、触达尺寸、响应式溢出、reduced-motion、
  // 明暗/高对比三态。同首启向导检查一样，设置先置完成位，否则向导会占住首屏。
  if (uiAudit) {
    try {
      await window.webContents.executeJavaScript("window.watchpartyDesktop.invoke('getDesktopSettings').then(settings => window.watchpartyDesktop.invoke('updateDesktopSettings', { input: { backendOrigin: settings.backendOrigin, allowRemoteHttp: settings.allowRemoteHttp, nickname: settings.nickname, theme: settings.theme, windowMaterial: settings.windowMaterial, playerPreferences: settings.playerPreferences, setupCompleted: true } }))")
      const { runUiAudit } = await import('./ui-audit.mjs')
      await runUiAudit(window, native)
      console.log('ELECTRON_UI_AUDIT_OK')
      stopping = true
      await native.close()
      app.exit(0)
    } catch (error) {
      console.error(error instanceof Error ? error.stack ?? error.message : `electron_check_rejected ${JSON.stringify(error) ?? String(error)}`)
      console.error('ELECTRON_UI_AUDIT_FAILED')
      stopping = true
      await native.close()
      app.exit(1)
    }
    return
  }
  // 视觉探针（M2-2/M2-3 用）：种完成位后依次打开设置页与 Linkle 大厅创建对话框，
  // 截图并读取关键控件的计算几何。同 ui-audit，先置完成位免得向导占住首屏。
  if (viewShot) {
    try {
      await window.webContents.executeJavaScript("window.watchpartyDesktop.invoke('getDesktopSettings').then(settings => window.watchpartyDesktop.invoke('updateDesktopSettings', { input: { backendOrigin: settings.backendOrigin, allowRemoteHttp: settings.allowRemoteHttp, nickname: settings.nickname, theme: settings.theme, windowMaterial: settings.windowMaterial, playerPreferences: settings.playerPreferences, setupCompleted: true } }))")
      const { runViewShot } = await import('./view-shot.mjs')
      await runViewShot(window)
      console.log('ELECTRON_VIEW_SHOT_OK')
      stopping = true
      await native.close()
      app.exit(0)
    } catch (error) {
      console.error(error instanceof Error ? error.stack ?? error.message : `electron_check_rejected ${JSON.stringify(error) ?? String(error)}`)
      console.error('ELECTRON_VIEW_SHOT_FAILED')
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
}
