// Runs the actual MusicParty executable in a new temporary working directory.
// No repository database, .env, platform cookie file or media fixture is opened.
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const assert = require('node:assert/strict')

async function main() {
  assert.equal(process.platform, 'win32', 'requires Windows Credential Manager')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchparty-mp-http-'))
  const children = []
  let timer
  const start = (exe, args, options) => {
    const child = spawn(exe, args, { windowsHide: true, ...options })
    children.push(child)
    return child
  }
  try {
    const goRoot = path.resolve(__dirname, '../../../musicparty/MusicParty/backend-go')
    const exe = path.join(dir, 'musicparty-e2e.exe')
    const build = start('go', ['build', '-o', exe, './cmd/musicparty'], { cwd: goRoot, stdio: 'inherit' })
    assert.equal((await once(build, 'exit'))[0], 0, 'Go build failed')
    const rustRoot = path.resolve(__dirname, '../../src-tauri')
    const rustBuild = start('cargo', ['test', '--lib', '--no-run', '--message-format=json'], { cwd: rustRoot, stdio: ['ignore', 'pipe', 'inherit'] })
    let artifacts = ''
    rustBuild.stdout.on('data', chunk => { artifacts += chunk })
    assert.equal((await once(rustBuild, 'exit'))[0], 0, 'Rust build failed')
    const testExe = artifacts.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      .find(item => item.reason === 'compiler-artifact' && item.profile.test && item.target.name === 'watchparty_desktop' && item.executable)?.executable
    assert.ok(testExe)
    const reservation = net.createServer()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const port = reservation.address().port
    await new Promise(resolve => reservation.close(resolve))
    const origin = `http://127.0.0.1:${port}`
    // Pass only OS basics plus explicit test configuration to the real server.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(systemroot|windir|path|temp|tmp)$/i.test(name)))
    const password = randomUUID()
    const server = start(exe, [], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...env, SERVER_PORT: String(port), BASE_URL: origin, ALLOWED_ORIGINS: origin,
      DB_PATH: path.join(dir, 'test.db'), DB_INIT_SCHEMA: 'true', DB_ENABLED: 'true',
      BOOTSTRAP_ADMIN_USERNAME: 'e2e-admin', BOOTSTRAP_ADMIN_PASSWORD: password,
      AUTH_SECURE_COOKIES: 'false', ROOM_ACCESS_TOKEN_SECRET: randomUUID(),
      LOCAL_LIBRARY_PATH: path.join(dir, 'empty-library'), LOCAL_LIBRARY_ENABLED: 'true',
      YOUTUBE_ENABLED: 'false', NAVIDROME_ENABLED: 'false', SQUIDIFY_ENABLED: 'false',
      NETEASE_API_URL: 'http://127.0.0.1:1', STATIC_PATH: path.join(dir, 'empty-static'),
    } })
    let listening = false
    server.stdout.on('data', chunk => { if (chunk.toString().includes('musicparty Go backend listening')) listening = true })
    server.stderr.resume()
    for (let i = 0; !listening && i < 200; i++) {
      assert.equal(server.exitCode, null, 'test server exited during startup')
      await delay(100)
    }
    assert.ok(listening, 'actual Go server readiness log missing')
    const health = await fetch(`${origin}/api/desktop/v1/health`, { signal: AbortSignal.timeout(5000) })
    assert.equal(health.status, 200)
    console.log(`MUSICPARTY_REAL_SERVER_READY pid=${server.pid} origin=${origin}`)
    const rust = start(testExe, ['musicparty::real_http_tests::private_room_cookie_logout_against_real_server', '--exact', '--ignored', '--nocapture'], {
      cwd: rustRoot, stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, MP_E2E_ORIGIN: origin, MP_E2E_ADMIN_PASSWORD: password },
    })
    console.log(`RUST_HTTP_CLIENT pid=${rust.pid} serverPid=${server.pid}`)
    assert.notEqual(rust.pid, server.pid)
    let output = ''
    rust.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk) })
    timer = setTimeout(() => rust.kill(), 390000)
    assert.equal((await once(rust, 'exit'))[0], 0, 'Rust real HTTP acceptance failed')
    assert.ok(output.includes('MP_HTTP_RUST_REAL_SERVER_E2E_OK'), 'Rust completion evidence missing')
    assert.equal(server.exitCode, null)
    console.log('MUSICPARTY_HTTP_CROSS_PROCESS_E2E_OK')
  } finally {
    clearTimeout(timer)
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'exit'); child.kill(); await closed
      }
    }
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()))
    assert.ok(path.basename(dir).startsWith('watchparty-mp-http-'))
    const removeFiles = folder => {
      for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, item.name)
        if (item.isDirectory()) { removeFiles(file); fs.rmdirSync(file) } else fs.unlinkSync(file)
      }
    }
    removeFiles(dir)
    fs.rmdirSync(dir)
    console.log('MP_HTTP_PROCESS_AND_TEMP_CLEANUP_OK')
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
