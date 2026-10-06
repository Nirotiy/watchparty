import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { isAbsolute } from 'node:path'
import { writeFile } from 'node:fs/promises'

const executable = process.argv[2]
assert.ok(executable && isAbsolute(executable) && executable.endsWith('.exe'))
const resultPath = process.argv[3]
assert.ok(!resultPath || isAbsolute(resultPath))
const startedAt = new Date().toISOString()
let healthRequests = 0
let backendPings = 0
let usingExistingHealthService = false
const fixturePort = Number(process.env.WATCHPARTY_SMOKE_HEALTH_PORT ?? 18081)
let servedPort = fixturePort

const server = createServer((request, response) => {
  if (request.url === '/api/desktop/v1/health') {
    healthRequests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"status":"ok","apiVersion":"2026-01"}')
    return
  }
  // P1-1：通用媒体通道要走两条真实形状的只读路由（这是夹具，不是真服务）。
  if (request.url === '/api/media/capabilities') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"libraries":true,"artwork":true,"catalog":false,"mediaAdmin":true}')
    return
  }
  if (request.url === '/api/media/libraries') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"libraries":[{"id":"lib_anime","name":"Anime","kind":"anime","sourceId":"src_seed","sourceName":"OpenList","health":"ok"}]}')
    return
  }
  if (request.url === '/ping') {
    // `verifyBackend` only requires a 2xx from <backendOrigin>/ping; without this the packaged
    // smoke could never get past configuring a backend it has no way to reach.
    backendPings += 1
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('pong')
    return
  }
  response.writeHead(404)
  response.end()
})

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(fixturePort, '127.0.0.1', resolve) })
} catch (error) {
  if (error?.code === 'EADDRINUSE') usingExistingHealthService = true
  else if (error?.code !== 'EACCES') throw error
  // Windows hands out dynamic TCP reservations (Hyper-V / WinNAT) that can swallow the whole
  // 180xx block, and EACCES there is not something this runner may fix by killing anything.
  // Bind an ephemeral port instead and tell the app's health probe where the fixture landed.
  else {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    servedPort = server.address().port
  }
}
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
if (!usingExistingHealthService) {
  const fixtureOrigin = `http://127.0.0.1:${servedPort}`
  env.WATCHPARTY_SMOKE_HEALTH_ORIGIN = fixtureOrigin
  env.WATCHPARTY_SMOKE_BACKEND_ORIGIN = fixtureOrigin
}
const child = spawn(executable, ['--conditions=watchparty-smoke'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
let output = ''
child.stdout.on('data', chunk => { output += chunk.toString() })
let timedOut = false
const timeout = setTimeout(() => {
  timedOut = true
  if (child.exitCode === null) {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }) } catch {}
  }
}, 60000)
let code
try {
  code = await new Promise((resolve, reject) => { child.once('close', value => resolve(value ?? 1)); child.once('error', reject) })
} finally {
  clearTimeout(timeout)
  if (!usingExistingHealthService) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
const lines = output.split(/\r?\n/)
const markers = ['ELECTRON_SMOKE_READY', 'ELECTRON_SMOKE_RENDERER_LOADED', 'WINDOWS_CAPTION_HIT_TEST_OK', 'ELECTRON_WINDOW_CHROME_OK', 'ELECTRON_NATIVE_SMOKE_OK']
const observed = markers.filter(marker => lines.includes(marker))
const nativeLine = lines.find(line => line.startsWith('{"electronIPC":'))
const nativeResult = nativeLine ? JSON.parse(nativeLine) : null
const passed = !timedOut && code === 0 && observed.length === markers.length && (usingExistingHealthService || (healthRequests > 0 && backendPings > 0))
const result = { startedAt, finishedAt: new Date().toISOString(), executable, passed, exitCode: code, timedOut, markers: observed,
  health: usingExistingHealthService
    ? { kind: 'existing local service; package smoke did not create an isolated fixture', port: servedPort, requests: 'not observed by this runner' }
    : { kind: 'isolated generated HTTP fixture, not a real MusicParty service', port: servedPort, requests: healthRequests },
  backend: usingExistingHealthService
    ? { kind: 'existing local service; package smoke did not create an isolated /ping fixture', port: servedPort, requests: 'not observed by this runner' }
    : { kind: 'isolated generated /ping fixture, not a real WatchParty backend', port: servedPort, requests: backendPings },
  electronIPC: nativeResult?.electronIPC === true, realLibmpv: nativeResult?.realLibmpv ?? null,
  notTested: ['real MusicParty service', 'audible output', 'reconnect'] }
if (resultPath) await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(result))
process.exitCode = passed ? 0 : 1
