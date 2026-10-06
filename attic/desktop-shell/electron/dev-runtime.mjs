import { cp, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// This workspace prevents Chromium from creating its sandbox window station.
// Keep the development runtime in the user's normal application directory.
export async function developmentRuntime() {
  const executable = createRequire(import.meta.url)('electron')
  if (process.platform !== 'win32' || process.env.ELECTRON_OVERRIDE_DIST_PATH) return executable
  if (!process.env.LOCALAPPDATA) throw new Error('electron_local_app_data_missing')
  const source = dirname(executable)
  const version = (await readFile(join(source, 'version'), 'utf8')).trim()
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) throw new Error('electron_version_invalid')
  const hash = createHash('sha256').update(await readFile(executable)).digest('hex').slice(0, 12)
  const parent = join(process.env.LOCALAPPDATA, 'Banguru', 'development')
  const target = join(parent, `electron-${version}-${hash}`)
  const runtime = join(target, 'electron.exe')
  if (await stat(runtime).catch(() => null)) return runtime
  await mkdir(parent, { recursive: true })
  const staging = await mkdtemp(join(parent, 'electron-staging-'))
  try {
    await cp(source, staging, { recursive: true })
    await rename(staging, target).catch(async error => {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !await stat(runtime).catch(() => null)) throw error
    })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return runtime
}
