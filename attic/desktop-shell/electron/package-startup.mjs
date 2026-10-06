import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { dirname, isAbsolute, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const executable = process.argv[2]
const resultPath = process.argv[3]
assert.ok(executable && isAbsolute(executable))
assert.ok(resultPath && isAbsolute(resultPath))
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
delete env.WATCHPARTY_LOCAL_LAUNCH
const directory = dirname(executable)
const literal = value => `'${value.replaceAll("'", "''")}'`
function powershell(script) {
  return execFileSync(process.env.WATCHPARTY_SMOKE_POWERSHELL ?? 'powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, windowsHide: true, encoding: 'utf8' }).trim()
}
function windows() {
  const script = `$items = @(Get-CimInstance Win32_Process -Filter "Name = 'watchparty-runtime.exe'" | Where-Object { $_.ExecutablePath -eq ${literal(join(directory, 'watchparty-runtime.exe'))} } | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p.MainWindowHandle -ne 0) { @{ id = $p.Id; parentId = $_.ParentProcessId; handle = $p.MainWindowHandle.ToInt64() } } }); ConvertTo-Json -InputObject $items -Compress`
  return JSON.parse(powershell(script) || '[]')
}
function assertSandboxArguments() {
  const script = `$items = @(Get-CimInstance Win32_Process -Filter "Name = 'watchparty-runtime.exe'" | Where-Object { $_.ExecutablePath -eq ${literal(join(directory, 'watchparty-runtime.exe'))} } | ForEach-Object { $_.CommandLine }); ConvertTo-Json -InputObject $items -Compress`
  const commands = JSON.parse(powershell(script) || '[]')
  assert.ok(commands.some(command => command.includes('--type=renderer')), 'renderer_process_missing')
  assert.ok(commands.every(command => !/--(?:no-sandbox|disable-renderer-sandbox|disable-gpu-sandbox)\b/.test(command)), 'sandbox_disabled_in_process_arguments')
}
function stop(pid) {
  try { execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }) } catch {}
}
async function observe(child) {
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.equal(child.exitCode, null, `normal_startup_exited: ${output}`)
    if (output.includes('ELECTRON_RENDERER_SANDBOX_OK')) return
    await delay(100)
  }
  throw new Error(`normal_renderer_not_loaded: ${output}`)
}

const primary = spawn(executable, [], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
const primaryExit = new Promise(resolve => primary.once('close', resolve))
let cmdWindow
try {
  await observe(primary)
  assertSandboxArguments()
  const initial = windows()
  assert.equal(initial.length, 1)
  const secondary = spawn(executable, [], { env, windowsHide: true, stdio: 'ignore' })
  let timeout
  const code = await Promise.race([
    new Promise(resolve => secondary.once('close', resolve)),
    new Promise(resolve => { timeout = setTimeout(() => { stop(secondary.pid); resolve('timeout') }, 7000) }),
  ])
  clearTimeout(timeout)
  assert.equal(code, 0, 'second_instance_must_exit')
  assert.equal(primary.exitCode, null)
  assert.deepEqual(windows().map(window => window.id), initial.map(window => window.id))
  stop(primary.pid)
  await primaryExit

  const cmd = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${join(directory, 'Start-WatchParty.cmd')}""`], { env, windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' })
  assert.equal(await new Promise(resolve => cmd.once('close', resolve)), 0)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = windows()
    if (found.length === 1) { cmdWindow = found[0]; break }
    await delay(100)
  }
  assert.ok(cmdWindow, 'cmd_window_missing')
  await delay(1000)
  assert.equal(windows().length, 1)
  assertSandboxArguments()
  await writeFile(resultPath, JSON.stringify({ passed: true, executable, arguments: [], pollutedElectronEnvironment: true, rendererSandboxed: true, normalWindow: true, singleInstance: true, cmdWindow: true, lockBypass: false }, null, 2) + '\n', { flag: 'wx' })
  console.log('PACKAGED_DEFAULT_STARTUP_OK')
} finally {
  stop(primary.pid)
  await primaryExit
  if (cmdWindow) stop(cmdWindow.parentId)
}
