import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { createRequire } from 'node:module'
const { WebSocket } = createRequire(import.meta.url)('ws')

/** Exercises shipped React forms against two isolated real Go services through native IPC. */
export async function runServiceAcceptance({ window, native, invoke, exe, dir, env, start, servers, listen, until, pcm }) {
  const services = [], calls = [], mediaAuth = [], providerCalls = []
  const upgraded = new Set()
  let playerId
  const originalRequest = native.request
  native.request = async function(command, args) {
    if (command === 'musicPartyAudio' && args.input.command.action !== 'status') {
      playerId = args.input.playerId
      calls.push({ audio: args.input.command.action, playerId })
    }
    const result = await originalRequest.call(this, command, args)
    if (command === 'musicPartyAudio' && args.input.command.action !== 'status') console.log(JSON.stringify({ check: 'native-audio-result', action: args.input.command.action, item: args.input.command.itemId, ...result }))
    if (command === 'musicPartyRequest') {
      const call = { origin: args.input.origin, path: args.input.path, status: result.status }
      if (args.input.path?.startsWith('/api/desktop/v1/search/')) {
        try {
          const payload = JSON.parse(result.body)
          call.itemCount = Array.isArray(payload.items) ? payload.items.length : null
        } catch { call.itemCount = null }
      }
      calls.push(call)
    }
    if (command === 'musicPartyWsConnect') calls.push({ origin: args.input?.origin, path: 'ws' })
    return result
  }
  const js = source => window.webContents.executeJavaScript(source)
  const click = async text => {
    await until(() => js(`Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim().endsWith(${JSON.stringify(text)}) && !b.disabled)`), `button ${text}`)
    await js(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().endsWith(${JSON.stringify(text)}) && !b.disabled).click()`)
    await wait(60)
  }
  const fill = async (label, value) => {
    await until(() => js(`Boolean(document.querySelector('input[aria-label=${JSON.stringify(label)}]'))`), `input ${label}`)
    await js(`(() => { const input = document.querySelector('input[aria-label=${JSON.stringify(label)}]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await wait(30)
  }
  const textContains = text => js(`document.body.innerText.includes(${JSON.stringify(text)})`)
  const status = () => invoke('musicPartyAudio', { input: { playerId, command: { action: 'status' } } })
  const playing = async label => {
    await until(async () => { if (!playerId) return false; const s = await status(); return s.loaded && !s.paused && s.position > .1 }, label)
    const a = await status(); await wait(350); assert.ok((await status()).position > a.position + .1, label)
  }
  try {
    const wav = pcm(90)
    let mediaOrigin
    const provider = createServer((req, res) => {
      const url = new URL(req.url, mediaOrigin)
      if (url.pathname === '/cloudsearch' || url.pathname === '/song/detail' || url.pathname === '/song/url/v1') {
        const id = url.searchParams.get('ids') ?? url.searchParams.get('id') ?? /\b(101|201)\b/.exec(url.searchParams.get('keywords') ?? '')?.[1]
        const matched = id ? url.searchParams.get('cookie') === `generated-fixture-${id === '201' ? 'B' : 'A'}` : null
        providerCalls.push({ path: url.pathname, method: req.method, credentialMatchesService: matched })
        console.log(JSON.stringify({ check: 'provider-auth', path: url.pathname, credentialMatchesService: matched }))
      }
      if (url.pathname.startsWith('/api/netease/stream/')) {
        mediaAuth.push({ path: url.pathname, hasSession: /(?:^|;\s*)MP_SESSION=[^;]+/.test(req.headers.cookie ?? '') })
      }
      if (url.pathname === '/tone.wav') {
        const range = req.headers.range
        const headers = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
        if (range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range)
          if (match) {
            const start = Number(match[1]); const requestedEnd = match[2] ? Number(match[2]) : wav.length - 1
            const end = Math.min(requestedEnd, wav.length - 1)
            if (start <= end && start < wav.length) {
              const body = wav.subarray(start, end + 1)
              res.writeHead(206, { ...headers, 'Content-Length': body.length, 'Content-Range': `bytes ${start}-${end}/${wav.length}` })
              if (req.method !== 'HEAD') res.end(body); else res.end()
              return
            }
          }
          res.writeHead(416, { 'Content-Range': `bytes */${wav.length}` }); res.end(); return
        }
        res.writeHead(200, { ...headers, 'Content-Length': wav.length })
        if (req.method !== 'HEAD') res.end(wav); else res.end()
        return
      }
      const id = url.searchParams.get('ids') ?? url.searchParams.get('id') ?? /\b(101|201)\b/.exec(url.searchParams.get('keywords') ?? '')?.[1] ?? '101'
      res.setHeader('Content-Type', 'application/json')
      if (url.pathname === '/cloudsearch') {
        res.end(JSON.stringify({ result: { songs: [{ id: Number(id), name: `Service track ${id}`, dt: 90000, ar: [], al: {} }] } }))
      } else {
        res.end(JSON.stringify(url.pathname === '/song/detail' ? { songs: [{ id: Number(id), name: `Service track ${id}`, dt: 90000, ar: [], al: {} }] } : { data: [{ url: `${mediaOrigin}/tone.wav` }] }))
      }
    }); servers.push(provider); mediaOrigin = await listen(provider)
    for (const [label, track] of [['A', '101'], ['B', '201']]) {
      const cwd = join(dir, `service-${label}`); await mkdir(cwd)
      const reservation = createServer(); const upstreamOrigin = await listen(reservation)
      const proxy = createServer((req, res) => {
        const path = new URL(req.url, 'http://localhost').pathname
        const upstream = httpRequest(upstreamOrigin + req.url, { method: req.method, headers: req.headers }, reply => {
          if (path.startsWith('/api/netease/stream/')) console.log(JSON.stringify({ check: 'service-stream', service: label, native: req.headers['user-agent'] === 'MusicParty Desktop', hasSession: /(?:^|;\s*)MP_SESSION=[^;]+/.test(req.headers.cookie ?? ''), status: reply.statusCode, contentType: reply.headers['content-type'], length: reply.headers['content-length'], range: reply.headers['content-range'], acceptsRanges: reply.headers['accept-ranges'] }))
          res.writeHead(reply.statusCode, reply.headers); reply.pipe(res)
        })
        upstream.on('error', () => res.destroy()); req.pipe(upstream)
      })
      proxy.on('upgrade', (req, socket, head) => {
        upgraded.add(socket)
        const upstream = httpRequest(upstreamOrigin + req.url, { headers: req.headers })
        upstream.on('upgrade', (reply, peer, rest) => {
          upgraded.add(peer)
          socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`)
          if (rest.length) socket.write(rest); if (head.length) peer.write(head)
          peer.pipe(socket); socket.pipe(peer)
          socket.on('close', () => peer.destroy()); peer.on('error', () => socket.destroy())
        })
        upstream.on('error', () => socket.destroy()); upstream.end()
      })
      servers.push(proxy); const origin = await listen(proxy)
      await new Promise(r => reservation.close(r))
      console.log(JSON.stringify({ check: 'service-start', service: label }))
      const password = randomUUID()
      // Windows can return UNKNOWN when a second temporary executable is spawned directly
      // while Electron owns the first child. Run through COMSPEC and retain stderr for diagnosis.
      const child = start(exe, [], { cwd, shell: true, stdio: ['ignore', 'ignore', 'pipe'], env: {
        ...env, SERVER_PORT: new URL(upstreamOrigin).port, BASE_URL: origin, ALLOWED_ORIGINS: origin,
        DB_PATH: join(cwd, 'generated.db'), DB_INIT_SCHEMA: 'true', DB_ENABLED: 'true',
        BOOTSTRAP_ADMIN_USERNAME: 'acceptance', BOOTSTRAP_ADMIN_PASSWORD: password,
        AUTH_SECURE_COOKIES: 'false', ROOM_ACCESS_TOKEN_SECRET: randomUUID(), NETEASE_API_URL: mediaOrigin,
        NETEASE_COOKIE: `generated-fixture-${label}`, STATIC_PATH: join(cwd, 'static'), LOCAL_LIBRARY_PATH: join(cwd, 'library'),
        YOUTUBE_ENABLED: 'false', NAVIDROME_ENABLED: 'false', SQUIDIFY_ENABLED: 'false',
      } })
      child.stderr?.on('data', data => calls.push({ process: 'service-startup', label, stderr: String(data).trim() }))
      await until(async () => {
        if (child.exitCode !== null) {
          const diagnostics = calls.filter(call => call.process === 'service-startup' && call.label === label).map(call => call.stderr).join('\\n')
          throw new Error(`service_${label}_exited_${child.exitCode}${diagnostics ? `: ${diagnostics}` : ''}`)
        }
        try { return (await fetch(origin + '/api/desktop/v1/health', { signal: AbortSignal.timeout(2000) })).ok } catch { return false }
      }, `service ${label}`, 30000)
      console.log(JSON.stringify({ check: 'service-ready', service: label }))
      const login = await fetch(origin + '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'acceptance', password }) })
      assert.equal(login.status, 200)
      const cookies = login.headers.getSetCookie().map(c => c.split(';')[0])
      const csrf = cookies.find(c => c.startsWith('MP_CSRF=')).slice(8)
      const admin = async (path, body, method = 'POST') => {
        const result = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookies.join('; '), 'X-CSRF-Token': csrf }, body: JSON.stringify(body) })
        assert.equal(result.status, 200, `admin ${label} ${path}`); return result.json()
      }
      const invite = await admin('/api/dev/rooms/lounge/invites', { label: 'generated UI acceptance' })
      const desktopHeaders = { Cookie: cookies.join('; '), 'X-Desktop-API-Version': '2026-01', 'X-Desktop-Client-Version': '0.2.0' }
      const resolveProbe = await fetch(`${origin}/api/desktop/v1/media/netease/${track}/resolve`, { headers: desktopHeaders })
      if (!resolveProbe.ok) throw new Error(`media_resolve_probe_${label}_${resolveProbe.status}`)
      const resolved = await resolveProbe.json()
      if (typeof resolved.url !== 'string' || !resolved.url || resolved.music?.platform !== 'netease') throw new Error(`media_resolve_probe_invalid_${label}`)
      const streamProbe = await fetch(new URL(resolved.url, origin), { headers: desktopHeaders })
      if (!streamProbe.ok || streamProbe.headers.get('content-type')?.split(';')[0] !== 'audio/wav') throw new Error(`media_stream_probe_${label}_${streamProbe.status}_${streamProbe.headers.get('content-type')}`)
      if (!providerCalls.some(entry => entry.path === '/song/url/v1' && entry.credentialMatchesService)) throw new Error(`provider_cookie_missing_${label}`)
      const adminSocket = new WebSocket(origin.replace('http:', 'ws:') + '/api/desktop/v1/ws?roomId=lounge', { headers: { Cookie: cookies.join('; '), Origin: origin } })
      await new Promise((resolve, reject) => { adminSocket.once('open', resolve); adminSocket.once('error', reject) })
      const hello = new Promise((resolve, reject) => {
        const onMessage = data => { try { const event = JSON.parse(String(data)); if (event.type === 'server.hello') { adminSocket.off('message', onMessage); resolve(event) } } catch {} }
        adminSocket.on('message', onMessage); adminSocket.once('error', reject)
      })
      adminSocket.send(JSON.stringify({ type: 'client.hello', payload: { apiVersion: '2026-01', clientVersion: '0.2.0' } }))
      await hello
      services.push({ origin, admin, invite: invite.code, track, adminSocket, child, enqueue: (musicId) => new Promise((resolve, reject) => {
        const mutationId = randomUUID()
        const onMessage = data => { try { const event = JSON.parse(String(data)); if (event.type === 'enqueue.ack' && event.payload?.mutationId === mutationId) { adminSocket.off('message', onMessage); resolve(event) } if (event.type === 'enqueue.nack' && event.payload?.mutationId === mutationId) { adminSocket.off('message', onMessage); reject(new Error(event.payload?.reason ?? 'enqueue_rejected')) } } catch {} }
        adminSocket.on('message', onMessage)
        adminSocket.send(JSON.stringify({ type: 'enqueue', roomId: 'lounge', payload: { platform: 'netease', musicId, mutationId } }))
      }) })
    }
    const [a, b] = services
    await click('Linkle')
    for (const service of services) {
      await fill('Linkle 服务地址', service.origin); await click('保存服务')
      await fill('Linkle 邀请码', service.invite); await click('兑换并进入')
      await until(() => textContains('已进入'), 'React invite result')
      await until(() => textContains('已连接'), 'React MusicParty ready')
      await wait(250)
      await fill('搜索音乐', `fixture ${service.track}`); await click('搜索')
      await until(() => textContains(`Service track ${service.track}`), 'React search result')
      await click('播放')
      await until(() => textContains('已加入房间队列，跟随房间播放'), 'React enqueue accepted')
      try { await playing(`React ${service.track} native playback`) }
      catch (error) {
        const diagnostics = await js(`({ text: document.body.innerText, playerId: ${JSON.stringify(playerId)} })`)
        const audio = playerId ? await status().catch(e => ({ error: String(e) })) : null
        throw new Error(`${error.message}; react=${JSON.stringify(diagnostics)}; audio=${JSON.stringify(audio)}; mediaAuth=${JSON.stringify(mediaAuth.map(({ path, hasSession }) => ({ path, hasSession })))}; provider=${JSON.stringify(providerCalls)}; commands=${JSON.stringify(calls.filter(c => c.audio || c.path?.includes('/resolve')))}`)
      }
    }
    await fill('Linkle 服务地址', a.origin); await click('保存服务'); await click('连接')
    await until(() => textContains('Service track 101'), 'A restored without redeeming again')
    assert.equal(await textContains('Service track 201'), false, 'B state leaked into A')
    await playing('A restored playback')
    const connectedBefore = calls.filter(c => c.path === 'ws').length
    await click('设置'); await click('安全与会话'); await playing('settings keeps playing')
    await click('首页'); await click('Banguru')
    await until(async () => (await status()).paused, 'background music suspended')
    await click('Linkle'); await playing('return restores local focus')
    assert.equal(calls.filter(c => c.path === 'ws').length, connectedBefore, 'navigation reconnected the room')
    console.log('REACT_REAL_SERVICES_A_B_A_AND_NAVIGATION_OK')

    // Changing the password invalidates previous room-access proofs. The member is not an admin.
    const privatePassword = randomUUID()
    await a.admin('/api/rooms/lounge', { name: 'Private acceptance', isPrivate: true, password: privatePassword }, 'PUT')
    await click('设置'); await click('安全与会话')
    await fill('房间 ID', 'lounge'); await fill('房间密码', 'generated-wrong-password')
    const before = calls.length
    await click('验证并保存授权')
    await until(() => calls.slice(before).some(c => c.path?.endsWith('/verify') && c.status === 403), 'wrong private password rejected')
    await fill('房间密码', privatePassword); await click('验证并保存授权')
    await until(() => textContains('房间授权已更新'), 'correct private password accepted')
    const verifications = calls.slice(before).filter(c => c.path?.endsWith('/verify'))
    assert.deepEqual(verifications.map(c => [c.origin, c.status]), [[a.origin, 403], [a.origin, 200]])
    await click('首页'); await click('连接'); await playing('private room reconnect after verification')
    await click('设置'); await click('安全与会话'); await click('注销 Linkle')
    await until(() => textContains('已从服务端注销'), 'React logout')
    assert.equal(calls.findLast(c => c.path === '/api/account/logout')?.origin, a.origin)
    const request = origin => invoke('musicPartyRequest', { input: { origin, method: 'GET', path: '/api/desktop/v1/search/netease?q=acceptance', clientVersion: '0.2.0' } })
    assert.equal((await request(a.origin)).status, 401, 'A credential survived logout')
    assert.notEqual((await request(b.origin)).status, 401, 'A logout cleared B credentials')
    await click('首页'); await fill('Linkle 服务地址', b.origin); await click('连接')
    await until(() => textContains('Service track 201'), 'B session survives A logout'); await playing('B after A logout')
    const saved = await js(`JSON.parse(localStorage.getItem('watchparty.local-settings'))`)
    assert.equal(saved.services.length, 2)
    assert.equal(saved.services.find(s => s.id === saved.activeServiceId).origin, a.origin)
    await click('设置'); await click('安全与会话'); await click('注销 Linkle')
    await until(() => textContains('已从服务端注销'), 'B logout')
    await window.loadURL('watchparty-app://desktop/index.html')
    await click('Linkle')
    assert.equal(await js(`document.querySelector('input[aria-label="Linkle 服务地址"]').value`), a.origin)
    console.log('REACT_PRIVATE_ROOM_VERIFY_LOGOUT_ORIGIN_ISOLATION_AND_PROFILE_RELOAD_OK')
  } catch (error) {
    console.log(JSON.stringify({ check: 'service-acceptance-failure', message: error.message, providerPaths: providerCalls.map(call => call.path), requests: calls.filter(call => call.path).map(({ origin, path, status, itemCount }) => ({ origin, path, status, itemCount })) }))
    throw error
  } finally {
    for (const socket of upgraded) socket.destroy()
    for (const service of services) service.adminSocket.terminate()
    for (const service of services) {
      if (service.child.exitCode === null) {
        try { execFileSync('taskkill', ['/pid', String(service.child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }) } catch {}
      }
    }
    native.request = originalRequest
    for (const service of services) await invoke('clearMusicPartySession', { origin: service.origin }).catch(() => {})
  }
}
