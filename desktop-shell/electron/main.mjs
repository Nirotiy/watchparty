import { app, BrowserWindow, ipcMain, protocol, net } from 'electron'
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SidecarClient } from './sidecar-client.mjs'
import policy from './policy.cjs'
import { getWallpaperBackdrop } from './wallpaper.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const directory = dirname(fileURLToPath(import.meta.url))
// Separate application identity and data directory preserve the user's Tauri client.
app.setName('Banguru')
const smoke = process.argv.includes('--smoke') || process.argv.includes('--conditions=watchparty-smoke')
const acceptance = process.argv.includes('--acceptance')
const protocolProbe = process.argv.find(arg => arg.startsWith('--protocol-probe='))?.slice('--protocol-probe='.length)
const acceptanceProfile = protocolProbe ?? process.argv.find(arg => arg.startsWith('--acceptance-profile='))?.slice('--acceptance-profile='.length)
if (acceptanceProfile && (dirname(resolve(acceptanceProfile)) !== resolve(tmpdir()) || !basename(acceptanceProfile).startsWith('watchparty-electron-smoke-'))) throw new Error('invalid_acceptance_profile')
app.setPath('userData', acceptanceProfile ?? (smoke || acceptance ? mkdtempSync(join(tmpdir(), 'watchparty-electron-smoke-')) : join(app.getPath('appData'), 'WatchParty-Electron-Local')))
protocol.registerSchemesAsPrivileged([{ scheme: 'watchparty-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const entry = 'watchparty-app://desktop/index.html'
let window
let native
let stopping = false
let latestLaunch
const pendingLinks = []
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
  protocol.handle('watchparty-app', request => {
    const url = new URL(request.url)
    if (url.host !== 'desktop' || request.method !== 'GET') return new Response('', { status: 403 })
    let pathname
    try { pathname = decodeURIComponent(url.pathname) } catch { return new Response('', { status: 400 }) }
    const target = resolve(assets, '.' + pathname)
    const rel = relative(assets, target)
    if (rel.startsWith('..') || isAbsolute(rel)) return new Response('', { status: 403 })
    return net.fetch(pathToFileURL(target).href)
  })
  window = new BrowserWindow({
    width: 1280, height: 800, minWidth: 960, minHeight: 640, title: 'Banguru',
    show: false, transparent: true, backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#202020', symbolColor: '#ffffff', height: 48 },
    webPreferences: { preload: join(directory, 'preload-built.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  })
  window.setMenu(null)
  window.on('enter-full-screen', () => window.webContents.send('watchparty:fullscreen', true))
  window.on('leave-full-screen', () => window.webContents.send('watchparty:fullscreen', false))
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: {
    ...details.responseHeaders,
    'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'"],
  } }))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.webContents.on('render-process-gone', () => app.quit())
  const handle = window.getNativeWindowHandle()
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString()
  native = new SidecarClient(join(directory, 'native', 'watchparty-native-sidecar.exe'), [app.getPath('userData'), hwnd])
  native.on('event', (name, payload) => {
    if (name === '__fullscreen' && typeof payload === 'boolean') window.setFullScreen(payload)
    if (policy.events.includes(name)) window.webContents.send(name, payload)
  })
  native.on('closed', () => { if (!stopping) app.quit() })
  ipcMain.handle('watchparty:request', async (event, command, args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== entry || !policy.validRequest(command, args)) return { error: 'invalid_desktop_request' }
    try {
      if (command === 'currentDesktopLaunch' && latestLaunch) return { result: latestLaunch }
      if (command === 'updateDesktopWindowChrome') {
        window.setTitle(args.title)
        const solidCaption = args.theme === 'dark' ? '#202020' : '#f3f3f3'
        window.setTitleBarOverlay({
          color: args.windowMaterial === 'auto' ? '#00000000' : solidCaption,
          symbolColor: args.theme === 'dark' ? '#ffffff' : '#1b1b1b',
          height: 48,
        })
        return { result: null }
      }
      if (command === 'getDesktopWallpaperBackdrop') {
        const backdrop = await getWallpaperBackdrop()
        return { result: { image: backdrop?.dataUrl ?? null, average: backdrop?.average ?? null } }
      }
      return { result: await native.request(command, args) }
    } catch (error) {
      return { error: error instanceof Error ? { message: error.message } : error }
    }
  })
  window.on('closed', () => app.quit())
  const links = deepLinks(process.argv)
  if (links.length === 1) pendingLinks.push(links[0])
  for (const url of pendingLinks.splice(0)) await openLink(url)
  await window.loadURL(entry)
  if (protocolProbe) {
    const launch = await window.webContents.executeJavaScript('window.watchpartyDesktop.invoke("currentDesktopLaunch")')
    writeFileSync(join(protocolProbe, 'protocol-result.json'), JSON.stringify({ nativeRoomId: latestLaunch?.roomId, rendererRoomId: launch?.roomId, pid: process.pid }))
    stopping = true
    await native.close()
    app.exit(launch?.roomId ? 0 : 1)
    return
  }
  if (smoke) console.log('ELECTRON_SMOKE_RENDERER_LOADED')
  if (smoke || acceptance) {
    let failed = false
    try {
      if (acceptance) {
        const { runAcceptance } = await import('./acceptance.mjs')
        await runAcceptance(window, native)
      } else {
        const { runSmoke } = await import('./smoke.mjs')
        await runSmoke(window, native)
      }
      console.log('ELECTRON_NATIVE_SMOKE_OK')
    } catch (error) {
      if (acceptance || smoke) console.error(error instanceof Error ? error.stack ?? error.message : 'electron_check_failed')
      console.error('ELECTRON_NATIVE_SMOKE_FAILED')
      failed = true
    } finally {
      stopping = true
      await native.close()
      app.exit(failed ? 1 : 0)
    }
  } else window.show()
  }).catch(() => { console.error('desktop_startup_failed'); app.quit() })
}
