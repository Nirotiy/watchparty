import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as wait } from 'node:timers/promises'

// Explicit invocation registers the specified complete local package after a successful cold launch.
const executable = process.argv[2]
assert.ok(executable && isAbsolute(executable) && executable.endsWith('.exe'))
const exec = promisify(execFile)
const dir = await mkdtemp(join(tmpdir(), 'watchparty-electron-smoke-protocol-'))
const backup = join(dir, 'previous-protocol.reg')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
let hadRegistration = false, success = false
try { await exec('reg.exe', ['export', 'HKCU\\Software\\Classes\\watchparty', backup, '/y'], { windowsHide: true }); hadRegistration = true } catch(error) { if(error.code !== 1) throw error }
try {
  const registration = await exec(executable, ['--register-deep-link', `--protocol-probe=${dir}`], { env, windowsHide: true, timeout: 15000 })
  assert.ok(registration.stdout.includes('WATCHPARTY_PROTOCOL_REGISTERED'))
  await exec('powershell.exe', ['-NoProfile', '-Command', "Start-Process -FilePath 'watchparty://room-cold-acceptance'"], { env, windowsHide: true, timeout: 15000 })
  let result
  for (let i = 0; i < 150; i++) {
    try { result = JSON.parse(await readFile(join(dir, 'protocol-result.json'), 'utf8')); break } catch { await wait(100) }
  }
  assert.equal(result?.nativeRoomId, 'room-cold-acceptance')
  assert.equal(result?.rendererRoomId, 'room-cold-acceptance')
  const normal = await exec(executable, ['--register-deep-link'], { env, windowsHide: true, timeout: 15000 })
  assert.ok(normal.stdout.includes('WATCHPARTY_PROTOCOL_REGISTERED'))
  success = true
  console.log(JSON.stringify({ check: 'WINDOWS_OS_PROTOCOL_COLD_LAUNCH_OK', executable, nativeAndRendererAgree: true, registration: 'normal packaged entry', previousRegistrationBackup: backup }))
} finally {
  if (!success && hadRegistration) await exec('reg.exe', ['import', backup], { windowsHide: true })
}
