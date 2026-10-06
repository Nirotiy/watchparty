import { cp, copyFile, mkdir, readFile, writeFile, rename, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { rcedit } from 'rcedit'
import { installationMarker } from './profile.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const directory = fileURLToPath(new URL('.', import.meta.url))
const installed = process.argv.includes('--installed')
const preconfigured = process.argv.includes('--preconfigured')
if (process.argv.slice(2).some(arg => arg !== '--installed' && arg !== '--preconfigured')) throw new Error('invalid_package_argument')
if (preconfigured && !installed) throw new Error('preconfigured_package_requires_installed')
if (preconfigured && (!process.env.BANGURU_PRESET_USERNAME || !process.env.BANGURU_PRESET_PASSWORD)) throw new Error('preconfigured_package_requires_explicit_credentials')
const sidecarPath = join(directory, 'native', 'watchparty-native-sidecar.exe')
async function newestMtime(folder) {
  let newest = { mtimeMs: 0, file: '' }
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name)
    const candidate = entry.isDirectory() ? await newestMtime(file) : { mtimeMs: (await stat(file)).mtimeMs, file }
    if (candidate.mtimeMs > newest.mtimeMs) newest = candidate
  }
  return newest
}
// A sidecar older than the Rust sources ships green gates around code that is not in the binary.
// Checked before anything is created so a rejected run leaves no half-made package directory.
const watched = [await newestMtime(join(root, 'src-tauri', 'src')), ...(await Promise.all(
  ['Cargo.toml', 'Cargo.lock'].map(async file => ({ mtimeMs: (await stat(join(root, 'src-tauri', file))).mtimeMs, file: join(root, 'src-tauri', file) }))
))]
const newestSource = watched.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
const sidecarStat = await stat(sidecarPath).catch(() => null)
if (!sidecarStat) throw new Error(`sidecar_missing: ${sidecarPath} — run npm run electron:build`)
if (sidecarStat.mtimeMs < newestSource.mtimeMs) {
  throw new Error(`sidecar_stale: ${newestSource.file} changed after ${sidecarPath} was built — run npm run electron:build`)
}
if (installed) {
  const cleanup = await stat(join(directory, 'native/banguru-profile-cleanup.exe')).catch(() => null)
  if (!cleanup || cleanup.mtimeMs < newestSource.mtimeMs) throw new Error('profile_cleanup_missing_or_stale: run npm run electron:build')
}
// Electron no longer runs a postinstall: index.js fetches dist/ on first
// require, which must happen before dist/ is copied below.
createRequire(import.meta.url)('electron')
const builtAt = new Date().toISOString()
const stamp = builtAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const name = `WatchParty-Electron-${stamp}`
const output = join(root, 'artifacts', 'electron-local', name)
await mkdir(output, { recursive: false }).catch(async error => {
  if (error.code !== 'ENOENT') throw error
  await mkdir(join(root, 'artifacts', 'electron-local'), { recursive: true })
  await mkdir(output)
})
for (const entry of await readdir(join(directory, 'node_modules/electron/dist'))) {
  await cp(join(directory, 'node_modules/electron/dist', entry), join(output, entry), { recursive: true, errorOnExist: true, force: false })
}
await rename(join(output, 'electron.exe'), join(output, 'watchparty-runtime.exe'))
if (installed) {
  await writeFile(join(output, installationMarker), '')
  await copyFile(join(directory, 'native/banguru-profile-cleanup.exe'), join(output, 'BanguruCleanup.exe'))
}
execFileSync('rustc', ['--edition=2024', '-C', 'opt-level=2', '-C', 'strip=symbols', join(directory, 'portable-launcher.rs'), '-o', join(output, 'Banguru.exe')], { stdio: 'inherit', windowsHide: true })
const icon = join(directory, 'assets', 'banguru-logo.ico')
for (const executable of ['Banguru.exe', 'watchparty-runtime.exe']) {
  await rcedit(join(output, executable), { icon })
}
const app = join(output, 'resources/app')
await mkdir(join(app, 'electron/native'), { recursive: true })
await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'watchparty-electron-local', version: '0.1.0', type: 'module', main: 'electron/main.mjs' }, null, 2))
for (const file of ['main.mjs', 'profile.mjs', 'preload-built.cjs', 'policy.cjs', 'sidecar-client.mjs', 'smoke.mjs', 'wallpaper.mjs', 'artwork.mjs']) await copyFile(join(directory, file), join(app, 'electron', file))
await cp(join(directory, 'assets'), join(app, 'electron/assets'), { recursive: true })
if (preconfigured) {
  const origin = new URL(process.env.BANGURU_PRESET_ORIGIN?.trim() || 'https://39.108.227.53:8443')
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('invalid_preset_origin')
  const caPath = process.env.BANGURU_PRESET_CA_PATH?.trim() || join(directory, 'assets', 'vps-root-ca.pem')
  const pem = await readFile(caPath, 'utf8')
  const profile = {
    formatVersion: 1,
    profileId: 'vps-default-v1',
    backendOrigin: origin.origin,
    caAsset: 'vps-root-ca.pem',
    caPemSha256: createHash('sha256').update(pem.replace(/\r\n?/g, '\n'), 'utf8').digest('hex'),
    siteBasicAuth: {
      username: process.env.BANGURU_PRESET_USERNAME,
      password: process.env.BANGURU_PRESET_PASSWORD,
    },
  }
  await copyFile(caPath, join(app, 'electron/assets/vps-root-ca.pem'))
  await writeFile(join(app, 'electron/assets/connection-profile.json'), JSON.stringify(profile, null, 2) + '\n')
}
await cp(join(directory, '../dist-electron'), join(app, 'dist-electron'), { recursive: true })
const native = join(app, 'electron/native')
await copyFile(join(directory, 'native/watchparty-native-sidecar.exe'), join(native, 'watchparty-native-sidecar.exe'))
await copyFile(process.env.WATCHPARTY_LIBMPV_PATH ?? join(process.env.LOCALAPPDATA, 'WatchParty/runtime/libmpv-2.dll'), join(native, 'libmpv-2.dll'))
await copyFile(join(directory, 'LICENSE-public-ca.txt'), join(output, 'LICENSE-public-ca.txt'))
await writeFile(join(output, 'Start-WatchParty.cmd'), '@echo off\r\nstart "" "%~dp0Banguru.exe" %*\r\n')
await copyFile(join(directory, 'create-desktop-shortcut.ps1'), join(output, 'Create-Desktop-Shortcut.ps1'))
await writeFile(join(output, 'Create-Desktop-Shortcut.cmd'), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Create-Desktop-Shortcut.ps1"\r\n')
const hashes = {}
async function hashTree(folder, prefix = '') {
  for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name
    if (entry.isDirectory()) await hashTree(join(folder, entry.name), relative + '/')
    else hashes[relative] = createHash('sha256').update(await readFile(join(folder, entry.name))).digest('hex')
  }
}
await hashTree(output)
const manifest = {
  distribution: installed ? 'installed-payload' : 'portable',
  builtAt, watchpartyHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceState: 'dirty working tree; HEAD alone cannot reproduce this package',
  profile: 'local unsigned Windows x64; debug Rust sidecar; Electron directory distribution',
  validated: [],
  validationNote: 'Packaging is not acceptance. See the separately recorded test results for this build.',
  notValidated: ['audible system output on room entry', 'physical network adapter outage', 'packaged-build acceptance until separately run', 'multi-monitor DPI and all fullscreen cases', 'faux-Mica wallpaper layer appearance and playback visibility on real hardware'],
  sha256: hashes,
}
await writeFile(join(output, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ output, executable: 'Banguru.exe', builtAt, exeSha256: hashes['Banguru.exe'], sidecarSha256: hashes['resources/app/electron/native/watchparty-native-sidecar.exe'] }, null, 2))
