import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'

const executable = process.argv[2]
assert.ok(executable && isAbsolute(executable))
const cleanup = join(dirname(executable), 'BanguruCleanup.exe')
const root = await mkdtemp(join(tmpdir(), 'banguru-installed-check-'))
const local = join(root, 'local')
const profile = join(local, 'Banguru', 'User Data')
const settings = join(profile, 'settings.json')
const expected = '{"nickname":"installer-retain","backendOrigin":null}'
await mkdir(profile, { recursive: true })
await writeFile(settings, expected)
const env = { ...process.env, LOCALAPPDATA: local, ELECTRON_RUN_AS_NODE: '1' }
let child
let closed

async function start() {
  child = spawn(executable, [], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  closed = new Promise(resolve => child.once('close', resolve))
  await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`installed_startup_timeout: ${output}`)), 15000)
    const finish = error => { clearTimeout(timer); error ? reject(error) : resolve() }
    child.once('error', finish)
    child.once('close', code => finish(new Error(`installed_startup_exited: ${code}: ${output}`)))
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      output += chunk
      if (output.includes('ELECTRON_RENDERER_SANDBOX_OK')) finish()
    })
  })
}

async function stop() {
  if (!child) return
  if (child.exitCode === null) {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }) } catch {}
  }
  await closed
  child = undefined
}

function cleanupExit(args) {
  try { execFileSync(cleanup, args, { env, windowsHide: true, stdio: 'pipe' }); return 0 }
  catch (error) { if (typeof error.status === 'number') return error.status; throw error }
}

try {
  assert.equal(cleanupExit([]), 2, 'cleanup_without_explicit_purge_must_preserve_data')
  assert.equal(await readFile(settings, 'utf8'), expected)
  await start()
  assert.equal(cleanupExit(['--purge-installed-profile']), 1, 'running_client_must_block_purge')
  assert.equal(await readFile(settings, 'utf8'), expected)
  await stop()
  await start()
  assert.equal(await readFile(settings, 'utf8'), expected)
  console.log('INSTALLED_PROFILE_RETENTION_AND_PURGE_GUARD_OK')
} finally {
  await stop()
  await rm(root, { recursive: true, force: true })
}
