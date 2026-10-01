import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { SidecarClient } from '../desktop-shell/electron/sidecar-client.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const origin = 'http://127.0.0.1:18848'
const directory = 'D:/WatchParty-Diagnostics'
const profile = await fs.mkdtemp(path.join(directory, 'music-native-profile-'))
const executable = path.join(repo, 'desktop-shell/electron/native/watchparty-native-sidecar.exe')
const digest = async () => createHash('sha256').update(await fs.readFile(executable)).digest('hex')
const before = await digest()
const checks = {}
const observations = {}
const playerId = randomUUID()
const syncOnly = process.argv.includes('--sync-only')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
app.setPath('userData', profile)
void app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, titleBarStyle: 'hidden', backgroundColor: '#000000', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const handle = window.getNativeWindowHandle()
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString()
  process.env.WATCHPARTY_LIBMPV_PATH = path.join(process.env.LOCALAPPDATA, 'WatchParty/runtime/libmpv-2.dll')
  delete process.env.WATCHPARTY_CATALOG_APPROVAL_SECRET
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[key]
  const native = new SidecarClient(executable, [profile, hwnd])
  const credentialFile = path.join(profile, 'guest-session.json')
  let created = false
  let completed = false
  let phase = 'guest-fixture'
  let failureCode = null
  const check = (name, result) => { checks[name] = Boolean(result); assert.ok(result, name) }
  const request = async (route, method = 'GET', body) => {
    const result = await native.request('musicPartyRequest', { input: { origin, path: route, method, body, clientVersion: '0.2.0' } })
    return { status: result.status, body: JSON.parse(result.body) }
  }
  const audio = command => native.request('musicPartyAudio', { input: { playerId, command } })
  const receiveState = async predicate => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const event = JSON.parse((await native.request('musicPartyWsReceive')).event)
      if (event.type === 'player.state' && predicate(event.payload)) return event.payload
    }
    throw new Error('music_state_timeout')
  }
  try {
    // A separate guest exercises native identity without reading an administrator password.
    const guest = await fetch(origin + '/api/account/guest', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ displayName: 'VPS native validation' }) })
    assert.equal(guest.status, 200, 'guest_creation_failed')
    const cookies = guest.headers.getSetCookie()
    const value = name => cookies.find(cookie => cookie.startsWith(name + '='))?.split(';')[0].slice(name.length + 1)
    assert.ok(value('MP_SESSION') && value('MP_CSRF'), 'guest_cookies_missing')
    await fs.writeFile(credentialFile, JSON.stringify({ session: value('MP_SESSION'), csrf: value('MP_CSRF') }))
    const quote = value => `'${value.replaceAll("'", "''")}'`
    const command = `& ([scriptblock]::Create([IO.File]::ReadAllText(${quote(path.join(repo, 'deploy/native-test-credential.ps1'))}))) -ConfigurationFile ${quote(credentialFile)} -Origin ${quote(origin)} -Mode MusicSession`
    const provision = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, encoding: 'utf8', timeout: 30000 })
    assert.equal(provision.status, 0, 'music_credential_fixture_failed')
    created = JSON.parse(provision.stdout.trim()).created
    assert.ok(created, 'existing_music_credential_preserved_validation_aborted')
    await fs.unlink(credentialFile)
    phase = 'native-api'
    const me = await request('/api/account/me')
    check('nativeGuestSession', me.status === 200 && me.body.guest === true)
    const sources = await request('/api/platforms')
    check('nativeSources', sources.status === 200 && sources.body.length === 3)
    phase = 'native-websocket'
    const hello = JSON.parse((await native.request('musicPartyWsConnect', { input: { origin, roomId: 'lounge', clientVersion: '0.2.0' } })).event)
    check('nativeHandshake', hello.type === 'server.hello')
    await native.request('musicPartyWsSend', { event: JSON.stringify({ type: 'enqueue', requestId: 'vps-enqueue', payload: { platform: 'netease', musicId: '22672740', mutationId: 'vps-native-' + Date.now() } }) })
    const initial = await receiveState(state => Boolean(state.nowPlaying))
    check('nativeRoomSnapshot', Boolean(initial.nowPlaying.music.id))
    observations.initialPositionMs = initial.nowPlaying.currentPosition
    phase = 'native-audio'
    await audio({ action: 'volume', volume: 0 })
    for (const [platform, id] of (syncOnly ? [] : [['netease', '22672740'], ['bilibili', 'BV1pv6TYeEHL']])) {
      const resolved = await request(`/api/desktop/v1/media/${platform}/${id}/resolve`)
      check(platform + 'Resolve', resolved.status === 200 && Boolean(resolved.body.url))
      await audio({ action: 'load', url: new URL(resolved.body.url, origin).href, itemId: id })
      await audio({ action: 'focus', active: true })
      await audio({ action: 'snapshot', itemId: id, position: 0, playing: true })
      const deadline = Date.now() + 45000
      let status
      do { await delay(500); status = await audio({ action: 'status' }) } while (Date.now() < deadline && !(status.loaded && status.position > 2))
      check(platform + 'NativePlayback', status.loaded && status.position > 2 && !status.paused)
      observations[platform + 'ProgressSeconds'] = status.position
      await audio({ action: 'snapshot', itemId: id, position: 30, playing: true })
      await delay(2000)
      status = await audio({ action: 'status' })
      check(platform + 'NativeSeek', status.position >= 29 && status.position < 45)
      await audio({ action: 'stop' })
    }
    phase = 'cross-client-pause'
    await native.request('musicPartyWsSend', { event: JSON.stringify({ type: 'control.toggle-pause', requestId: 'vps-pause', payload: {} }) })
    const paused = await receiveState(state => state.isPaused !== initial.isPaused)
    check('nativeControlBroadcast', paused.isPaused !== initial.isPaused)
    console.log(JSON.stringify({ phase, paused: paused.isPaused }))
    await delay(syncOnly ? 30000 : 15000)
    await native.request('musicPartyWsSend', { event: JSON.stringify({ type: 'control.toggle-pause', requestId: 'vps-resume', payload: {} }) })
    const resumed = await receiveState(state => state.isPaused === initial.isPaused)
    check('nativeControlRestored', resumed.isPaused === initial.isPaused)
    completed = true
  } catch (error) {
    failureCode = typeof error === 'string' ? error : error?.code ?? 'VALIDATION_FAILED'
  } finally {
    await audio({ action: 'dispose' }).catch(() => {})
    await native.request('musicPartyWsDisconnect').catch(() => {})
    if (created) {
      await request('/api/account/logout', 'POST', {}).catch(() => {})
      await native.request('clearMusicPartySession', { origin }).catch(() => { checks.credentialCleanup = false })
    }
    await fs.unlink(credentialFile).catch(() => {})
    await native.close()
    checks.sidecarBytesUnchanged = before === await digest()
    const report = { checks, observations, phase, failureCode, completed, passed: completed && Object.values(checks).every(Boolean), sidecarSha256: before, scope: 'independent HTTP rehearsal; real Rust bridge, WS and libmpv; excludes production HTTPS and Tunnel' }
    await fs.writeFile(path.join(directory, syncOnly ? 'vps-music-sync-20261001.json' : 'vps-music-native-20261001.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report))
    window.destroy()
    app.exit(report.passed ? 0 : 1)
  }
})
