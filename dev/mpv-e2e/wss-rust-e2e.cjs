// Windows acceptance test: independent Node TLS server and the real Rust state API.
// OPENSSL may point to an executable; Git for Windows is detected without a PATH change.
const { spawn, spawnSync, fork } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

async function main() {
  assert.equal(process.platform, 'win32', 'this test uses Windows Credential Manager')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchparty-wss-rust-'))
  const cert = path.join(dir, 'cert.pem')
  const key = path.join(dir, 'key.pem')
  const gitOpenSSL = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe')
  const openssl = process.env.OPENSSL || (fs.existsSync(gitOpenSSL) ? gitOpenSSL : 'openssl')
  let server
  let rust
  let watchdog
  try {
    const generated = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1',
      '-addext', 'basicConstraints=critical,CA:FALSE',
      '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
      '-addext', 'extendedKeyUsage=serverAuth'], { windowsHide: true, encoding: 'utf8', timeout: 15000 })
    if (generated.error || generated.status !== 0) throw new Error(`certificate generation failed: ${generated.error?.message || generated.stderr}`)
    server = fork(path.join(__dirname, 'wss-fixture.cjs'), [], {
      env: { ...process.env, WSS_FIXTURE_PORT: '0', WSS_FIXTURE_CERT: cert, WSS_FIXTURE_KEY: key, WSS_FIXTURE_STRICT: '1' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true,
    })
    const validated = new Set()
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Node fixture readiness timeout')), 10000)
      server.on('message', message => {
        validated.add(message.type)
        if (message.type === 'ready') { clearTimeout(timeout); resolve(message) }
      })
      server.once('error', error => { clearTimeout(timeout); reject(error) })
      server.once('exit', () => { clearTimeout(timeout); reject(new Error('Node fixture exited before readiness')) })
    })
    assert.equal(ready.pid, server.pid)
    const origin = `https://127.0.0.1:${ready.port}`
    console.log(`NODE_WSS_READY pid=${ready.pid} origin=${origin}`)
    // Build first so the runtime deadline does not include a cold Rust build.
    const cwd = path.resolve(__dirname, '../../src-tauri')
    const build = spawn('cargo', ['test', '--lib', '--no-run', '--message-format=json'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
    let artifacts = ''
    build.stdout.on('data', chunk => { artifacts += chunk })
    const [buildCode] = await once(build, 'exit')
    assert.equal(buildCode, 0, 'Rust test build failed')
    const executable = artifacts.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      .find(item => item.reason === 'compiler-artifact' && item.profile.test && item.target.name === 'watchparty_desktop' && item.executable)?.executable
    assert.ok(executable, 'Rust test executable missing')
    rust = spawn(executable, ['musicparty_ws::tests::connects_to_external_wss_fixture', '--exact', '--ignored', '--nocapture'], {
      cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, WSS_E2E_ORIGIN: origin, WSS_E2E_CERT: cert, WSS_E2E_DIR: dir },
    })
    console.log(`RUST_WSS_CLIENT pid=${rust.pid} serverPid=${server.pid}`)
    assert.notEqual(rust.pid, server.pid)
    let output = ''
    rust.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk) })
    watchdog = setTimeout(() => rust.kill(), 45000)
    const [code, signal] = await once(rust, 'exit')
    assert.equal(code, 0, `Rust acceptance test failed (${signal || 'exit code'})`)
    assert.ok(output.includes('RUST_WSS_CROSS_PROCESS_OK'), 'Rust success marker missing')
    assert.ok(validated.has('hello-validated'), 'Node did not validate client.hello')
    assert.ok(validated.has('roundtrip-validated'), 'Node did not validate Rust send')
    assert.equal(server.exitCode, null, 'Node fixture crashed')
    console.log('NODE_RUST_WSS_CROSS_PROCESS_OK')
  } finally {
    clearTimeout(watchdog)
    for (const child of [rust, server]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'exit')
        child.kill()
        await closed
      }
    }
    // Remove only files in the freshly created test directory, never a repository tree.
    const removeFiles = folder => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name)
        if (entry.isDirectory()) { removeFiles(file); fs.rmdirSync(file) } else fs.unlinkSync(file)
      }
    }
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()))
    assert.ok(path.basename(dir).startsWith('watchparty-wss-rust-'))
    removeFiles(dir)
    fs.rmdirSync(dir)
    console.log('WSS_TEST_PROCESS_AND_FILE_CLEANUP_OK')
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
