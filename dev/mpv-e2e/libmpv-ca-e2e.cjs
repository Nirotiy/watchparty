// Real libmpv playback against a temporary HTTPS server; no existing media or CA is changed.
const { spawn, spawnSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const https = require('node:https')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')

async function main() {
  assert.equal(process.platform, 'win32')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchparty-libmpv-ca-'))
  const dll = process.env.WATCHPARTY_LIBMPV_PATH || path.join(process.env.LOCALAPPDATA, 'WatchParty/runtime/libmpv-2.dll')
  const gitSSL = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git/usr/bin/openssl.exe')
  const openssl = process.env.OPENSSL || (fs.existsSync(gitSSL) ? gitSSL : 'openssl')
  const children = []
  const audioWorker = process.argv.includes('--audio-worker')
  let server
  const start = (exe, args, options) => {
    const child = spawn(exe, args, { windowsHide: true, ...options }); children.push(child); return child
  }
  try {
    const ssl = args => {
      const result = spawnSync(openssl, args, { cwd: dir, windowsHide: true, encoding: 'utf8', timeout: 15000 })
      if (result.error || result.status !== 0) throw new Error(`OpenSSL failed: ${result.error?.message || result.stderr}`)
    }
    ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2',
      '-subj', '/CN=WatchParty ephemeral acceptance CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
    ssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=127.0.0.1'])
    fs.writeFileSync(path.join(dir, 'server.ext'), 'subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n')
    ssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'server.ext'])
    // Thirty seconds of PCM silence, generated in memory instead of reading media samples.
    const dataBytes = 48000 * 2 * 2 * 30
    const wave = Buffer.alloc(44 + dataBytes)
    wave.write('RIFF'); wave.writeUInt32LE(36 + dataBytes, 4); wave.write('WAVEfmt ', 8)
    wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22)
    wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(192000, 28)
    wave.writeUInt16LE(4, 32); wave.writeUInt16LE(16, 34)
    wave.write('data', 36); wave.writeUInt32LE(dataBytes, 40)
    let requests = 0
    let tlsErrors = 0
    server = https.createServer({ key: fs.readFileSync(path.join(dir, 'server.key')), cert: fs.readFileSync(path.join(dir, 'server.pem')) }, (request, response) => {
      if (request.url !== '/fixture.wav') { response.writeHead(404); response.end(); return }
      requests++
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '')
      const first = range ? Number(range[1]) : 0
      const last = range && range[2] ? Math.min(Number(range[2]), wave.length - 1) : wave.length - 1
      if (first > last || first >= wave.length) { response.writeHead(416, { 'Content-Range': `bytes */${wave.length}` }); response.end(); return }
      response.writeHead(range ? 206 : 200, { 'Content-Type': 'audio/wav', 'Content-Length': last - first + 1,
        'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${first}-${last}/${wave.length}` } : {}) })
      response.end(wave.subarray(first, last + 1))
    })
    server.on('tlsClientError', () => { tlsErrors++ })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const origin = `https://127.0.0.1:${server.address().port}`
    const cwd = path.resolve(__dirname, '../../src-tauri')
    const build = start('cargo', ['build', '--bin', 'libmpv-surface-smoke', '--message-format=json'], { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
    let artifacts = ''
    build.stdout.on('data', chunk => { artifacts += chunk })
    assert.equal((await once(build, 'exit'))[0], 0)
    const executable = artifacts.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      .find(item => item.reason === 'compiler-artifact' && item.target.name === 'libmpv-surface-smoke' && item.executable)?.executable
    assert.ok(executable)
    console.log(`LIBMPV_DLL_SHA256 ${crypto.createHash('sha256').update(fs.readFileSync(dll)).digest('hex')}`)
    console.log(`HTTPS_MEDIA_READY pid=${process.pid} origin=${origin}`)
    for (const name of ['untrusted', 'trusted', 'other-origin', 'hostname-mismatch']) {
      const hasCA = name !== 'untrusted'
      const mediaOrigin = name === 'hostname-mismatch' ? origin.replace('127.0.0.1', 'localhost') : origin
      const trustOrigin = name === 'other-origin' ? origin.replace('127.0.0.1', 'localhost') : mediaOrigin
      const env = { ...process.env, WATCHPARTY_LIBMPV_PATH: dll, WATCHPARTY_MEDIA_TEST_URL: `${mediaOrigin}/fixture.wav`,
        WATCHPARTY_SMOKE_TRUST_DIR: path.join(dir, name), WATCHPARTY_SMOKE_TRUST_ORIGIN: trustOrigin,
        WATCHPARTY_SMOKE_HIDDEN: '1', WATCHPARTY_SMOKE_END_FILE: '1', WATCHPARTY_SMOKE_AUDIO_WORKER: audioWorker ? '1' : '0' }
      delete env.WATCHPARTY_MEDIA_TEST_FILE
      delete env.WATCHPARTY_MEDIA_TEST_CA
      if (hasCA) env.WATCHPARTY_MEDIA_TEST_CA = path.join(dir, 'ca.pem')
      const beforeRequests = requests
      const beforeErrors = tlsErrors
      const player = start(executable, [], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
      console.log(`LIBMPV_CASE ${name} playerPid=${player.pid}`)
      let output = '', errors = ''
      player.stdout.on('data', chunk => { output += chunk })
      player.stderr.on('data', chunk => { errors += chunk })
      const timer = setTimeout(() => player.kill(), 90000)
      const [code, signal] = await once(player, 'exit')
      clearTimeout(timer)
      assert.equal(signal, null, `${name}: smoke timed out`)
      if (name === 'trusted') {
        assert.equal(code, 0, `${name}: ${errors}`)
        const report = JSON.parse(output)
        const checks = audioWorker
          ? ['nativeAudio', 'fileLoaded', 'playAdvanced', 'pauseApplied', 'seekApplied', 'focusEnforced', 'staleDisposeIgnored', 'disposeAndRecreate', 'mediaFailureRejected']
          : ['fileLoaded', 'playAdvanced', 'pauseApplied', 'seekApplied', 'rateApplied', 'volumeApplied']
        for (const key of checks) assert.equal(report[key], true, key)
        if (!audioWorker) assert.equal(report.endFile, 'eof')
        assert.ok(requests > beforeRequests, 'libmpv must fetch the HTTPS media')
        console.log(`${audioWorker ? 'MUSICPARTY_NATIVE_AUDIO_OK' : 'LIBMPV_CA_PLAYBACK_OK'} position=${audioWorker ? report.position : report.state.time} requests=${requests - beforeRequests}`)
      } else {
        assert.notEqual(code, 0, `${name}: unexpected successful exit; stdout=${output}; stderr=${errors}`)
        assert.ok(errors.includes('PLAYBACK_ERROR'), `${name}: expected playback rejection, got ${errors}`)
        assert.equal(requests, beforeRequests, `${name}: rejected TLS must not reach HTTP`)
        assert.ok(tlsErrors > beforeErrors, `${name}: TLS rejection evidence missing`)
        console.log(`LIBMPV_CA_REJECTED ${name}`)
      }
    }
    console.log(audioWorker ? 'MUSICPARTY_NATIVE_AUDIO_E2E_OK' : 'LIBMPV_CUSTOM_CA_E2E_OK')
  } finally {
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill(); await ended }
    }
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()))
    assert.ok(path.basename(dir).startsWith('watchparty-libmpv-ca-'))
    const removeFiles = folder => {
      for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, item.name)
        if (item.isDirectory()) { removeFiles(file); fs.rmdirSync(file) } else fs.unlinkSync(file)
      }
    }
    removeFiles(dir); fs.rmdirSync(dir)
    console.log('LIBMPV_CA_TEMP_CLEANUP_OK')
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
