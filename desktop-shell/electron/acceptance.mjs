import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app, shell } from 'electron'
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
  for (const dep of ['musicparty-contract', 'retry']) if (js.includes(`from "./${dep}"`)) js = js.replaceAll(`from "./${dep}"`, `from "${await moduleUrl(dep)}"`)
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

/** Real Go service and Electron IPC/Rust/libmpv; only the external music provider is a fixture. */
export async function runAcceptance(window, native) {
  window.showInactive()
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
