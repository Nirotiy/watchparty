import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { setTimeout as wait } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { nativeImage } from 'electron'
const { WebSocket } = createRequire(import.meta.url)('ws')

/** 渲染层最后一条 console 错误。 */
let lastRendererError = null
// 兑换请求里上报的名字：只用来断言「本机 ID 真的写进服务端」，不在日志里回显自由文本。
let lastRedeemDisplayName = null

/**
 * Album art must be reachable over https — the NetEase adapter upgrades every
 * http cover URL — so the fixture serves two self-signed loopback images. The
 * shell accepts loopback certificates in acceptance modes only (main.mjs).
 */
async function startCoverFixture({ dir, servers, listen }) {
  const key = join(dir, 'cover.key')
  const pem = join(dir, 'cover.pem')
  await promisify(execFile)(join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/usr/bin/openssl.exe'), [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', pem, '-days', '1',
    '-subj', '/CN=WatchParty isolated album art', '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE',
  ], { windowsHide: true })
  const artwork = hue => {
    const size = 96
    // createFromBitmap reads BGRA, the same order toBitmap writes.
    const bitmap = Buffer.alloc(size * size * 4)
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4
      const rgb = hslToRgb(hue + (x / size) * 20, 0.62, 0.30 + (y / size) * 0.34)
      bitmap[offset] = rgb[2]; bitmap[offset + 1] = rgb[1]; bitmap[offset + 2] = rgb[0]; bitmap[offset + 3] = 255
    }
    return nativeImage.createFromBitmap(bitmap, { width: size, height: size }).toJPEG(92)
  }
  const images = { '/cover.jpg': artwork(18), '/cover-b.jpg': artwork(268) }
  const server = createHttpsServer({ key: await readFile(key), cert: await readFile(pem) }, (request, response) => {
    const pathname = new URL(request.url ?? '/', 'https://127.0.0.1').pathname
    if (pathname === '/not-an-image') { response.writeHead(200, { 'Content-Type': 'text/plain' }).end('not an image'); return }
    const image = images[pathname]
    if (!image) { response.writeHead(404).end(); return }
    response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': image.length })
    response.end(image)
  })
  servers.push(server)
  return (await listen(server)).replace('http:', 'https:')
}

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360 / 360
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = t => {
    let value = t
    if (value < 0) value += 1
    if (value > 1) value -= 1
    if (value < 1 / 6) return p + (q - p) * 6 * value
    if (value < 1 / 2) return q
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6
    return p
  }
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)].map(value => Math.round(value * 255))
}

/** 验收用的本机 ID 名字（这里种进设置，兑换观察器据此断言；两端共用同一常量）。 */
const LOCAL_ID_NAME = '验收ID'

const FIXTURE_WORDS = [
  ['Hello', 'from', 'the', 'fixture'],
  ['Every', 'word', 'carries', 'its', 'own', 'time'],
  ['Sweep', 'across', 'the', 'line'],
  ['Second', 'line', 'translated'],
  ['Timing', 'comes', 'from', 'the', 'room', 'clock'],
]
const FIXTURE_LINE_SPACING = 5000
const FIXTURE_YRC = FIXTURE_WORDS.map((words, line) => {
  const lineStart = line * FIXTURE_LINE_SPACING
  let cursor = lineStart
  const body = words.map(word => {
    const duration = 240 + word.length * 30
    const marker = `(${cursor},${duration},0)`
    cursor += duration + 160
    return `${marker}${word}`
  }).join(' ')
  return `[${lineStart},${Math.max(600, cursor - lineStart)}]${body}`
}).join('\n')
const FIXTURE_LRC = FIXTURE_WORDS.map((words, line) => `[00:${String(line * 5).padStart(2, '0')}.000]${words.join(' ')}`).join('\n')
const FIXTURE_TRANSLATION = FIXTURE_WORDS.map((words, line) => `[00:${String(line * 5).padStart(2, '0')}.500]译文第 ${line + 1} 行`).join('\n')

/** Exercises shipped React forms against two isolated real Go services through native IPC. */
export async function runServiceAcceptance({ window, native, invoke, exe, dir, env, start, servers, listen, until, pcm, stopAtWorkspace = false, onWorkspace = null }) {
  const services = [], calls = [], mediaAuth = [], providerCalls = []
  const upgraded = new Set()
  let playerId
  // 渲染层最后一条错误：几何/交互断言失败时，失败载荷里能直接看到抛点。
  window.webContents.on('console-message', (...args) => {
    const details = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : null
    const level = details ? details.level : args[1]
    const message = details ? details.message : args[2]
    if (level === 'error' || Number(level) >= 3) lastRendererError = String(message ?? '')
  })
  const originalRequest = native.request
  native.request = async function(command, args) {
    if (command === 'musicPartyAudio' && args.input.command.action !== 'status') {
      playerId = args.input.playerId
      calls.push({ audio: args.input.command.action, playerId })
    }
    const result = await originalRequest.call(this, command, args)
    if (command === 'musicPartyAudio' && args.input.command.action !== 'status') console.log(JSON.stringify({ check: 'native-audio-result', action: args.input.command.action, item: args.input.command.itemId, ...result }))
    if (command === 'musicPartyRequest') {
      if (args.input.path === '/api/desktop/v1/invites/redeem') {
        // The invite code is a single-use credential: log its shape, never its value, and keep the
        // failure body (which carries the server's reason) only for non-2xx answers.
        const body = (args.input.body ?? {})
        lastRedeemDisplayName = typeof body.displayName === 'string' ? body.displayName : null
        console.log('REDEEM_BODY ' + JSON.stringify({
          origin: args.input.origin,
          codeLength: typeof body.code === 'string' ? body.code.length : 0,
          hasDisplayName: Boolean(body.displayName),
          displayNameIsLocalId: lastRedeemDisplayName === LOCAL_ID_NAME,
          status: result.status,
          failure: result.status === 200 ? null : String(result.body ?? '').slice(0, 100),
        }))
      }
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
  const shot = async name => {
    await mkdir(join(dir, 'shots'), { recursive: true })
    const image = await window.webContents.capturePage()
    const target = join(dir, 'shots', `${name}.png`)
    await writeFile(target, image.toPNG())
    console.log(`SHOT ${target}`)
    return target
  }
  /**
   * 按矩形截图（截图坐标是物理像素，rect 是 CSS 像素 —— 乘 devicePixelRatio 归一）。
   * 用于"同一区域、两个状态"的像素级对比：整窗截图会随窗口尺寸/DPI 漂移，裁剪后不会。
   */
  const shotRect = async (name, selector) => {
    const rect = await window.webContents.executeJavaScript(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (!node) return null
      const r = node.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    })()`)
    if (!rect || rect.width < 1 || rect.height < 1) return null
    const scale = await window.webContents.executeJavaScript('window.devicePixelRatio || 1')
    const image = await window.webContents.capturePage({
      x: Math.round(rect.x * scale), y: Math.round(rect.y * scale),
      width: Math.round(rect.width * scale), height: Math.round(rect.height * scale),
    })
    await mkdir(join(dir, 'shots'), { recursive: true })
    const target = join(dir, 'shots', `${name}.png`)
    await writeFile(target, image.toPNG())
    console.log(`SHOT ${target}`)
    return { path: target, rect }
  }
  const click = async text => {
    await until(() => js(`Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim().endsWith(${JSON.stringify(text)}) && !b.disabled)`), `button ${text}`)
    await js(`Array.from(document.querySelectorAll('.desktop-page button')).find(b => b.textContent.trim().endsWith(${JSON.stringify(text)}) && !b.disabled).click()`)
    await wait(60)
  }
  // 行内动作键改成图标后没有文字了（用户 2026-09-25），按 aria-label 点。
  const clickLabel = async label => {
    await until(() => js(`Boolean(document.querySelector('button[aria-label=${JSON.stringify(label)}]'))`), `button ${label}`)
    await js(`document.querySelector('button[aria-label=${JSON.stringify(label)}]').click()`)
    await wait(60)
  }
  const fill = async (label, value) => {
    await until(() => js(`Boolean(document.querySelector('input[aria-label=${JSON.stringify(label)}]'))`), `input ${label}`)
    await js(`(() => { const input = document.querySelector('input[aria-label=${JSON.stringify(label)}]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await wait(30)
  }
  const textContains = text => js(`document.body.innerText.includes(${JSON.stringify(text)})`)
  // 服务与账号的控件只在探测卡片切到该视图时才渲染（用户 2026-09-25 把配置从页面底部搬进卡片），
  // 所以碰这些控件前先切过去；返回服务器信息把那一步的探测读数还回去。
  const openAccount = async () => {
    if (await js(`Boolean(document.querySelector('.lobby-account-panel'))`)) return
    await js(`Array.from(document.querySelectorAll('.lobby-card button')).find(b => b.textContent.trim() === '服务与账号')?.click()`)
    await until(() => js(`Boolean(document.querySelector('.lobby-account-panel'))`), 'account panel in the probe card')
  }
  const closeAccount = async () => {
    if (!await js(`Boolean(document.querySelector('.lobby-account-panel'))`)) return
    await js(`document.querySelector('.lobby-card button[aria-label="返回服务器信息"]')?.click()`)
    await until(() => js(`Boolean(document.querySelector('.lobby-card .lobby-kv'))`), 'probe view back')
  }
  const status = () => invoke('musicPartyAudio', { input: { playerId, command: { action: 'status' } } })
  const playing = async label => {
    await until(async () => { if (!playerId) return false; const s = await status(); return s.loaded && !s.paused && s.position > .1 }, label)
    const a = await status(); await wait(350); assert.ok((await status()).position > a.position + .1, label)
  }
  try {
    const wav = pcm(90)
    let mediaOrigin
    const coverOrigin = await startCoverFixture({ dir, servers, listen })
    const provider = createServer((req, res) => {
      const url = new URL(req.url, mediaOrigin)
      if (url.pathname === '/cloudsearch' || url.pathname === '/song/detail' || url.pathname === '/song/url/v1' || url.pathname === '/lyric' || url.pathname === '/lyric/new') {
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
      if (url.pathname === '/lyric') {
        res.end(JSON.stringify({ lrc: { lyric: FIXTURE_LRC }, tlyric: { lyric: FIXTURE_TRANSLATION }, romalrc: { lyric: '' } }))
      } else if (url.pathname === '/lyric/new') {
        res.end(JSON.stringify({ lrc: { lyric: FIXTURE_LRC }, yrc: { lyric: FIXTURE_YRC }, ytlrc: { lyric: FIXTURE_TRANSLATION }, yromalrc: { lyric: '' } }))
      } else if (url.pathname === '/album') {
        // 专辑曲目（netease AlbumSongs 走 /album?id=，见 netease.go:134）——契约定死一次全量。
        const albumId = Number(url.searchParams.get('id') ?? 9000)
        res.end(JSON.stringify({ album: { picUrl: `${coverOrigin}/cover.jpg` }, songs: [1, 2, 3].map(index => ({ id: albumId * 10 + index, name: `Album ${albumId} track ${index}`, dt: 90000, ar: [{ name: 'Fixture Artist' }], al: { picUrl: `${coverOrigin}/cover.jpg` } })) }))
      } else if (url.pathname === '/cloudsearch') {
        // 搜索要能验分页：按 offset/limit 回多页（共 45 条，20/20/5），第一页第一条仍是 101，
        // 这样既有的封面/入队断言不受影响。type=10 是专辑搜索（§14 的那个端点的 provider 形态），
        // 先照网页字段回两个专辑，等桌面端点上线再断言。
        const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0))
        const limit = Math.max(1, Number(url.searchParams.get('limit') ?? 20))
        const isAlbum = url.searchParams.get('type') === '10'
        if (isAlbum) {
          // 25 张（20+5）用来看专辑翻页；albumCount 是 netease 报总数的那一项（§14.1 的 total 来源）。
          const albumTotal = 25
          const albums = []
          for (let index = offset; index < Math.min(offset + limit, albumTotal); index += 1) {
            albums.push({ id: 9000 + index, name: `Fixture Album ${index + 1}`, artist: { name: 'Fixture Artist' }, picUrl: `${coverOrigin}/cover.jpg`, size: 3 })
          }
          res.end(JSON.stringify({ result: { albums, albumCount: albumTotal } }))
        } else {
          const total = 45
          const songs = []
          for (let index = offset; index < Math.min(offset + limit, total); index += 1) {
            const songId = index === 0 ? 101 : 1000 + index
            songs.push({ id: songId, name: `Fixture track ${index + 1}`, dt: 90000, ar: [{ name: 'Fixture Artist' }], al: { picUrl: `${coverOrigin}/cover.jpg` } })
          }
          res.end(JSON.stringify({ result: { songs, total } }))
        }
      } else {
        res.end(JSON.stringify(url.pathname === '/song/detail' ? { songs: [{ id: Number(id), name: `Service track ${id}`, dt: 90000, ar: [], al: { picUrl: `${coverOrigin}/cover.jpg` } }] } : { data: [{ url: `${mediaOrigin}/tone.wav` }] }))
      }
    }); servers.push(provider); mediaOrigin = await listen(provider)
    for (const [label, track] of (stopAtWorkspace ? [['A', '101']] : [['A', '101'], ['B', '201']])) {
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
      console.log('SERVICE_INVITE ' + JSON.stringify({ service: label, code: invite.code }))
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
    if (stopAtWorkspace) {
      await until(() => js(`Boolean(Array.from(document.querySelectorAll('.desktop-service-nav button')).find(b => b.textContent.includes('Linkle')))`), 'Linkle navigation')
      await js(`Array.from(document.querySelectorAll('.desktop-service-nav button')).find(b => b.textContent.includes('Linkle')).click()`)
    } else await click('Linkle')
    for (const service of services) {
      await openAccount()
      await fill('Linkle 服务地址', service.origin); await clickLabel('保存服务')
      if (stopAtWorkspace) {
        // Saving the address now activates it immediately (the App guard only blocks a live room),
        // so no reload is needed — wait for the lobby card to point at THIS service.
        await closeAccount()
        await until(async () => {
          const server = await js(`document.querySelector('.lobby-kv dd')?.textContent ?? ''`)
          return server === service.origin
        }, 'lobby targeting the isolated service')
        const lobbyTarget = await js(`(() => ({ server: document.querySelector('.lobby-kv dd')?.textContent ?? null, note: document.querySelector('.lobby-note')?.textContent?.slice(0, 60) ?? null }))()`)
        console.log('LOBBY_TARGET ' + JSON.stringify(lobbyTarget))
        // 本机 ID（设置向导将来写进 linkleMember）→ 建号时写进服务端（用户 2026-09-25 方案 1）：
        // 先种一个本机 ID，再走大厅邀请码入口，看兑换请求与之后的账号名是不是它。
        await js(`(() => {
          const raw = JSON.parse(localStorage.getItem('watchparty.local-settings') ?? 'null') ?? {}
          raw.linkleMember = { id: 'm-acceptance', name: ${JSON.stringify('验收ID')} }
          localStorage.setItem('watchparty.local-settings', JSON.stringify(raw))
          return true
        })()`)
        // 方案 C 把邀请码提到大厅第一屏；走大厅那张卡，顺便覆盖新入口。
        await fill('邀请码', service.invite)
        await click('进入房间')
        // 真链路：现编的 Go 树必须回答 readiness。只断言形状，不回显 body（message 是本地化文案，也可能带部署细节）。
        const readinessProbe = await invoke('musicPartyRequest', { input: { origin: service.origin, method: 'GET', path: '/api/desktop/v1/readiness', clientVersion: '0.2.0' } })
        const readinessBody = (() => { try { return JSON.parse(readinessProbe?.body ?? '') } catch { return null } })()
        const readinessShape = {
          http: readinessProbe?.status ?? null,
          status: readinessBody?.status ?? null,
          version: readinessBody?.readinessVersion ?? null,
          serviceName: readinessBody?.service ?? null,
          core: readinessBody?.components?.core?.status ?? null,
          mediaSource: readinessBody?.components?.neteaseApi?.status ?? null,
          diagnosticCodes: Array.isArray(readinessBody?.diagnostics) ? readinessBody.diagnostics.map(entry => entry?.code).filter(code => typeof code === 'string') : null,
        }
        console.log('LINKLE_READINESS ' + JSON.stringify(readinessShape))
        assert.equal(readinessShape.http, 200, 'live Go readiness must answer 200')
        assert.ok(readinessShape.status === 'ready' || readinessShape.status === 'degraded', `unexpected readiness status: ${readinessShape.status}`)
        assert.equal(readinessShape.version, 1)
        assert.equal(readinessShape.serviceName, 'musicparty')
        assert.ok(readinessShape.core === 'up' || readinessShape.core === 'down')
        assert.ok(readinessShape.mediaSource === 'up' || readinessShape.mediaSource === 'down', 'neteaseApi must report up|down, never ready|degraded')
        await until(() => calls.some(call => call.path === '/api/desktop/v1/invites/redeem' && call.status === 200), 'native invite redemption')
        await until(() => calls.some(call => call.path === 'ws'), 'native room socket')
        await until(() => js(`Boolean(document.querySelector('.linkle-room .roomhead'))`), 'Linkle one-screen workspace after invite')
        console.log('LINKLE_INVITE_WS_AND_WORKSPACE_OK')
        if (onWorkspace) await onWorkspace({ js, until, wait, invoke, service, shot, shotRect, coverOrigin, fill, click, browserWindow: window, lastRedeemName: () => lastRedeemDisplayName })
        return
      }
      await fill('Linkle 邀请码', service.invite); await clickLabel('兑换并进入')
      await until(() => textContains('已进入'), 'React invite result')
      await until(() => textContains('已连接'), 'React MusicParty ready')
      await wait(250)
      // 首页那份重复的搜索面板已按用户要求删除（2026-09-25），"搜索并入队"改用房间的点歌面板覆盖。
      await until(() => js(`Boolean(document.querySelector('.linkle-room button[aria-label="点歌"]'))`), 'room 点歌 panel button')
      await js(`document.querySelector('.linkle-room button[aria-label="点歌"]').click()`)
      await fill('搜索曲目', `fixture ${service.track}`); await click('搜索')
      await until(() => textContains(`Service track ${service.track}`), 'room search result')
      await js(`(() => { const row = Array.from(document.querySelectorAll('.linkle-room .song')).find(item => item.textContent.includes(${JSON.stringify(`Service track ${service.track}`)})); row?.querySelector('.add-btn button')?.click() })()`)
      await until(() => textContains(`已加入队列：Service track ${service.track}`), 'room enqueue accepted')
      try { await playing(`React ${service.track} native playback`) }
      catch (error) {
        const diagnostics = await js(`({ text: document.body.innerText, playerId: ${JSON.stringify(playerId)} })`)
        const audio = playerId ? await status().catch(e => ({ error: String(e) })) : null
        throw new Error(`${error.message}; react=${JSON.stringify(diagnostics)}; audio=${JSON.stringify(audio)}; mediaAuth=${JSON.stringify(mediaAuth.map(({ path, hasSession }) => ({ path, hasSession })))}; provider=${JSON.stringify(providerCalls)}; commands=${JSON.stringify(calls.filter(c => c.audio || c.path?.includes('/resolve')))}`)
      }
    }
    await openAccount()
    await fill('Linkle 服务地址', a.origin); await clickLabel('保存服务'); await clickLabel('连接')
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
    await click('首页'); await clickLabel('连接'); await playing('private room reconnect after verification')
    await click('设置'); await click('安全与会话'); await click('注销 Linkle')
    await until(() => textContains('已从当前 Linkle 服务器注销'), 'React logout')
    assert.equal(calls.findLast(c => c.path === '/api/account/logout')?.origin, a.origin)
    const request = origin => invoke('musicPartyRequest', { input: { origin, method: 'GET', path: '/api/desktop/v1/search/netease?q=acceptance', clientVersion: '0.2.0' } })
    assert.equal((await request(a.origin)).status, 401, 'A credential survived logout')
    assert.notEqual((await request(b.origin)).status, 401, 'A logout cleared B credentials')
    await click('首页'); await openAccount(); await fill('Linkle 服务地址', b.origin); await clickLabel('连接')
    await until(() => textContains('Service track 201'), 'B session survives A logout'); await playing('B after A logout')
    const saved = await js(`JSON.parse(localStorage.getItem('watchparty.local-settings'))`)
    assert.equal(saved.services.length, 2)
    assert.equal(saved.services.find(s => s.id === saved.activeServiceId).origin, a.origin)
    await click('设置'); await click('安全与会话'); await click('注销 Linkle')
    await until(() => textContains('已从当前 Linkle 服务器注销'), 'B logout')
    await window.loadURL('watchparty-app://desktop/index.html')
    await click('Linkle')
    await openAccount()
    assert.equal(await js(`document.querySelector('input[aria-label="Linkle 服务地址"]').value`), a.origin)
    console.log('REACT_PRIVATE_ROOM_VERIFY_LOGOUT_ORIGIN_ISOLATION_AND_PROFILE_RELOAD_OK')
  } catch (error) {
    console.log(JSON.stringify({ check: 'service-acceptance-failure', message: error.message, lastRendererError: lastRendererError?.trim() || null, providerPaths: providerCalls.map(call => call.path), requests: calls.filter(call => call.path).map(({ origin, path, status, itemCount }) => ({ origin, path, status, itemCount })) }))
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
