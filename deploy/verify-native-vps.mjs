import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { SidecarClient } from '../desktop-shell/electron/sidecar-client.mjs'
import { app, BrowserWindow } from 'electron'

const repo = fileURLToPath(new URL('../', import.meta.url))
const diagnostics = 'D:/WatchParty-Diagnostics'
const origin = 'https://39.108.227.53:8443'
const executable = path.join(repo, 'desktop-shell/electron/native/watchparty-native-sidecar.exe')
const profile = await fs.mkdtemp(path.join(diagnostics, 'vps-native-profile-'))
const pem = await fs.readFile(path.join(diagnostics, 'watchparty-vps-root-ca.crt'), 'utf8')
const digest = async () => createHash('sha256').update(await fs.readFile(executable)).digest('hex')
const before = await digest()
const checks = {}
const playback = process.argv.includes('--playback')
let latestState
const waitFor = async (predicate, name, timeout = 90000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(name)
}
app.setPath('userData', profile)
void app.whenReady().then(async () => {
const window = new BrowserWindow({ show: false, width: 960, height: 640, titleBarStyle: 'hidden', transparent: false, backgroundColor: '#000000', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
window.setMenu(null)
const handle = window.getNativeWindowHandle()
const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString()
process.env.WATCHPARTY_LIBMPV_PATH = path.join(process.env.LOCALAPPDATA, 'WatchParty/runtime/libmpv-2.dll')
delete process.env.WATCHPARTY_CATALOG_APPROVAL_SECRET
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[name]
const native = new SidecarClient(executable, [profile, hwnd])
native.on('event', (name, event) => { if (name === 'desktop://state') latestState = event.state })
let createdCredential = false
let completed = false
let failureCode = null
let phase = 'settings-read'
try {
  const settings = await native.request('getDesktopSettings')
  phase = 'settings-write'
  const input = { backendOrigin: origin, allowRemoteHttp: false, nickname: 'VPS validation', theme: settings.theme, windowMaterial: settings.windowMaterial, playerPreferences: settings.playerPreferences, setupCompleted: true }
  await native.request('updateDesktopSettings', { input })
  try {
    phase = 'unknown-ca'
    await native.request('mediaRequest', { method: 'GET', path: '/api/media/capabilities' })
    checks.unknownCaRejected = false
  } catch (error) {
    checks.unknownCaRejected = error?.code === 'TLS_TRUST_REQUIRED'
  }
  assert.equal(checks.unknownCaRejected, true, 'Unknown CA must fail before credential provisioning')
  await native.request('importOriginTrust', { origin, pem })
  phase = 'native-credential-fixture'
  const quote = value => `'${value.replaceAll("'", "''")}'`
  const provisionCommand = `& ([scriptblock]::Create([IO.File]::ReadAllText(${quote(path.join(repo, 'deploy/native-test-credential.ps1'))}))) -ConfigurationFile ${quote(path.join(diagnostics, 'vps-config-20261001/operator-input.json'))} -Origin ${quote(origin)}`
  const provision = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', provisionCommand], { windowsHide: true, encoding: 'utf8', timeout: 30000 })
  if (provision.status !== 0) {
    const operator = JSON.parse(await fs.readFile(path.join(diagnostics, 'vps-config-20261001/operator-input.json'), 'utf8'))
    let message = provision.stderr || provision.stdout
    for (const value of Object.values(operator)) message = message.replaceAll(value, '[redacted]')
    console.log(JSON.stringify({ phase, fixtureError: message.slice(-1500) }))
    throw new Error('native_credential_fixture_failed')
  }
  createdCredential = JSON.parse(provision.stdout.trim()).created
  if (playback) await native.request('updateDesktopSettings', { input: { ...input, backendOrigin: null } })
  await native.request('updateDesktopSettings', { input })
  phase = 'authenticated-api'
  const api = async args => {
    const response = await native.request('mediaRequest', args)
    return { status: response.status, body: JSON.parse(response.body) }
  }
  const capabilities = await api({ method: 'GET', path: '/api/media/capabilities' })
  checks.nativeAuthenticatedTls = capabilities.status === 200 && capabilities.body.catalogApproval === 'secret'
  console.log(JSON.stringify({ phase, status: capabilities.status, code: capabilities.body?.code ?? null }))
  assert.equal(checks.nativeAuthenticatedTls, true)
  const libraries = await api({ method: 'GET', path: '/api/media/libraries' })
  checks.libraryHealth = libraries.status === 200 && libraries.body.libraries.length === 3 && libraries.body.libraries.every(library => library.health === 'ok')
  assert.equal(checks.libraryHealth, true)
  const catalog = await api({ method: 'GET', path: '/api/media/catalog', query: 'libraryId=lib_anime' })
  const cards = catalog.body.items
  assert.ok(Array.isArray(cards) && cards.length > 0, 'Migrated catalog must contain cards')
  const posterCard = cards.find(card => card.hasPoster) ?? cards[0]
  const poster = await native.request('mediaImage', { kind: 'poster', id: posterCard.id })
  checks.cachedPoster = poster.contentType.startsWith('image/') && Buffer.from(poster.base64, 'base64').length > 100
  const refusal = await api({ method: 'POST', path: '/api/admin/media-libraries/lib_anime/approval', body: {} })
  checks.nativeCannotSelfApprove = refusal.status === 401 && refusal.body.code === 'CATALOG_APPROVAL_SECRET_REQUIRED'
  if (playback) {
    phase = 'catalog-playback'
    const films = await api({ method: 'GET', path: '/api/media/catalog', query: 'libraryId=lib_film' })
    const detail = await api({ method: 'GET', path: `/api/media/catalog/${films.body.items[0].id}`, query: 'episodeTitles=0' })
    const child = detail.body.children.find(entry => /\.mkv$/i.test(entry.name)) ?? detail.body.children.find(entry => /\.(mp4|webm)$/i.test(entry.name))
    assert.ok(child, 'catalog_video_required')
    await native.request('createDesktopRoom', { input: { nickname: 'VPS media validation', initialMedia: { kind: 'openlist', mediaId: child.mediaId, title: child.name, container: child.name.split('.').at(-1) } } })
    await waitFor(() => latestState?.connection === 'ready', 'native_room_not_ready')
    checks.nativeRealtime = true
    await native.request('executeRoomCommand', { command: { type: 'volume', volume: 0 } })
    await native.request('executeRoomCommand', { command: { type: 'play' } })
    await waitFor(() => latestState?.player?.loaded && latestState.player.time > 2, 'native_media_no_progress')
    checks.nativeVideoPlayback = true
    await native.request('executeRoomCommand', { command: { type: 'seek', positionSeconds: 60 } })
    await waitFor(() => latestState?.player?.time >= 59 && latestState.player.time < 90, 'native_media_seek_failed', 45000)
    checks.nativeVideoSeek = true
    const subtitle = latestState.player.subtitleTracks[0]
    assert.ok(subtitle, 'sample_has_no_subtitle_track')
    await native.request('executeRoomCommand', { command: { type: 'selectSubtitleTrack', trackId: subtitle.id } })
    await waitFor(() => latestState?.player?.subtitleTracks.some(track => track.id === subtitle.id && track.selected), 'subtitle_selection_failed', 10000)
    checks.nativeEmbeddedSubtitles = true
    await native.request('stopDesktopSession')
  }
  await native.request('deleteOriginTrust', { origin })
  try {
    await native.request('mediaRequest', { method: 'GET', path: '/api/media/capabilities' })
    checks.deleteTrustRevokesAccess = false
  } catch (error) {
    checks.deleteTrustRevokesAccess = error?.code === 'TLS_TRUST_REQUIRED'
  }
  assert.ok(Object.values(checks).every(Boolean))
  completed = true
} catch (error) {
  failureCode = error?.code ?? error?.message ?? (typeof error === 'string' ? error : 'VALIDATION_FAILED')
} finally {
  if (playback) await native.request('stopDesktopSession').catch(() => {})
  if (createdCredential) await native.request('clearSiteCredentials').catch(() => { checks.credentialCleanup = false })
  await native.close()
  checks.sidecarBytesUnchanged = before === await digest()
  const report = { checks, completed, phase, failureCode, passed: completed && Object.values(checks).every(Boolean), sidecarSha256: before, profile, scope: playback ? 'real native public TLS, temporary room, migrated OpenList video playback and seek' : 'real native sidecar, public VPS TLS, read-only migrated catalog' }
  await fs.writeFile(path.join(diagnostics, playback ? 'vps-native-playback-20261001.json' : 'vps-native-validation-20261001.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  window.destroy()
  app.exit(report.passed ? 0 : 1)
}
})
