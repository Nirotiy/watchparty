import { cp, copyFile, mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../..', import.meta.url))
const directory = fileURLToPath(new URL('.', import.meta.url))
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
await rename(join(output, 'electron.exe'), join(output, `${name}.exe`))
const app = join(output, 'resources/app')
await mkdir(join(app, 'electron/native'), { recursive: true })
await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'watchparty-electron-local', version: '0.1.0', type: 'module', main: 'electron/main.mjs' }, null, 2))
for (const file of ['main.mjs', 'preload-built.cjs', 'policy.cjs', 'sidecar-client.mjs', 'smoke.mjs', 'wallpaper.mjs', 'artwork.mjs']) await copyFile(join(directory, file), join(app, 'electron', file))
await cp(join(directory, '../dist-electron'), join(app, 'dist-electron'), { recursive: true })
const native = join(app, 'electron/native')
await copyFile(join(directory, 'native/watchparty-native-sidecar.exe'), join(native, 'watchparty-native-sidecar.exe'))
await copyFile(process.env.WATCHPARTY_LIBMPV_PATH ?? join(process.env.LOCALAPPDATA, 'WatchParty/runtime/libmpv-2.dll'), join(native, 'libmpv-2.dll'))
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
  builtAt, watchpartyHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceState: 'dirty working tree; HEAD alone cannot reproduce this package',
  profile: 'local unsigned Windows x64; debug Rust sidecar; Electron directory distribution',
  validated: [],
  validationNote: 'Packaging is not acceptance. See the separately recorded test results for this build.',
  notValidated: ['audible system output on room entry', 'physical network adapter outage', 'packaged-build acceptance until separately run', 'multi-monitor DPI and all fullscreen cases', 'faux-Mica wallpaper layer appearance and playback visibility on real hardware'],
  sha256: hashes,
}
await writeFile(join(output, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ output, executable: `${name}.exe`, builtAt, exeSha256: hashes[`${name}.exe`], sidecarSha256: hashes['resources/app/electron/native/watchparty-native-sidecar.exe'] }, null, 2))
