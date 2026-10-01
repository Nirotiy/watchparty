import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import https from 'node:https'
import { randomUUID } from 'node:crypto'
import { io } from 'socket.io-client'

const directory = 'D:/WatchParty-Diagnostics'
const operator = JSON.parse(await fs.readFile(directory + '/vps-config-20261001/operator-input.json', 'utf8'))
const ca = await fs.readFile(directory + '/watchparty-vps-root-ca.crt')
const web = 'https://watchparty.nirotiy.top'
const ip = 'https://39.108.227.53:8443'
const authorization = 'Basic ' + Buffer.from(operator.siteUsername + ':' + operator.sitePassword).toString('base64')
const checks = {}
const observations = {}
const sockets = []
let completed = false
let phase = 'public-entry'
let failureCode = null
const check = (name, value) => { checks[name] = Boolean(value); assert.ok(value, name) }
const request = async (origin, route, { method = 'GET', body, token, range, anonymous = false, admin = false } = {}, redirects = 0) => {
  const url = new URL(route, origin)
  const sameOrigin = url.origin === origin
  const selectedAuthorization = admin ? 'Basic ' + Buffer.from(operator.approvalUsername + ':' + operator.approvalPassword).toString('base64') : authorization
  const headers = sameOrigin ? { Origin: origin, ...(anonymous ? {} : { Authorization: selectedAuthorization }), ...(token ? { 'X-WatchParty-Token': token } : {}) } : {}
  if (range) headers.Range = range
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, ...(url.origin === ip ? { ca } : {}), timeout: 45000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume()
        resolve(request(origin, new URL(res.headers.location, url).href, { method, body, range, anonymous }, redirects + 1))
        return
      }
      const chunks = []
      let length = 0
      const finish = () => {
        const data = Buffer.concat(chunks)
        const payload = res.headers['content-type']?.includes('application/json') ? JSON.parse(data.toString()) : data
        resolve({ status: res.statusCode, payload, headers: res.headers })
      }
      res.on('data', chunk => {
        const limit = range ? 1024 : 2 * 1024 * 1024
        chunks.push(chunk.subarray(0, limit - length))
        length += Math.min(chunk.length, limit - length)
        if (length >= limit) { finish(); res.destroy() }
      })
      res.on('end', finish)
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('public_request_timeout')))
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
const connect = async (auth, transport = 'websocket') => {
  const socket = io(web, { autoConnect: false, transports: [transport], reconnection: false, extraHeaders: { Authorization: authorization, Origin: web }, auth, timeout: 15000 })
  sockets.push(socket)
  const snapshot = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('public_socket_timeout')), 20000)
    socket.once('REC:snapshot', value => { clearTimeout(timer); resolve(value) })
    socket.once('connect_error', () => { clearTimeout(timer); reject(new Error('public_socket_connection_failed')) })
  })
  socket.connect()
  return { socket, snapshot: await snapshot }
}
try {
  if (process.argv.includes('--approval-only')) {
    const settings = await request(web, '/api/catalog-approval/settings', { admin: true })
    observations.approvalStatus = settings.status
    check('tunnelApprovalAdminRoute', settings.status === 200 && settings.payload.configured === true)
    const missing = await request(web, '/api/catalog-approval/libraries/deployment_missing_library/approval', { method: 'POST', body: {}, admin: true })
    observations.approvalPostStatus = missing.status
    check('tunnelApprovalPostReachesBackend', missing.status === 404 && missing.payload.code === 'MEDIA_NOT_FOUND')
    completed = true
  } else {
  check('tunnelAnonymousDenied', (await request(web, '/api/media/libraries', { anonymous: true })).status === 401)
  const libraries = await request(web, '/api/media/libraries')
  check('tunnelLibraries', libraries.status === 200 && libraries.payload.libraries.length === 3)
  check('tunnelHomepage', (await request(web, '/')).status === 200)
  const cards = (await request(web, '/api/media/catalog?libraryId=lib_anime')).payload.items
  let child
  for (const card of cards) {
    const detail = await request(web, `/api/media/catalog/${card.id}?episodeTitles=0`)
    child = detail.payload.children.find(entry => /\.(mp4|webm)$/i.test(entry.name))
    if (child) break
  }
  assert.ok(child, 'browser_compatible_catalog_sample_required')
  const clientId = randomUUID()
  const room = await request(web, '/api/rooms', { method: 'POST', body: { clientId, nickname: 'Tunnel validation' } })
  check('publicRoomCreate', room.status === 200)
  phase = 'dual-origin-range'
  for (const [name, origin] of [['web', web], ['ip', ip]]) {
    const resolved = await request(origin, `/api/rooms/${room.payload.roomId}/media/resolve`, { method: 'POST', token: room.payload.accessToken, body: { mediaId: child.mediaId } })
    check(name + 'BrowserResolve', resolved.status === 200)
    const target = new URL(resolved.payload.url)
    check(name + 'MediaSameOrigin', target.origin === origin && target.pathname.startsWith('/p/'))
    const media = await request(origin, target.href, { range: 'bytes=0-1023' })
    check(name + 'MediaRange', media.status === 206 && media.payload.length === 1024 && Boolean(media.headers['content-range']))
    observations[name + 'RangeStatus'] = media.status
  }
  phase = 'tunnel-realtime'
  const auth = { clientProtocol: 2, roomId: room.payload.roomId, clientId, accessToken: room.payload.accessToken, ownerToken: room.payload.ownerToken }
  const first = await connect(auth)
  check('tunnelWebSocket', first.socket.io.engine.transport.name === 'websocket')
  const secondId = randomUUID()
  const access = await request(web, `/api/rooms/${room.payload.roomId}/access`, { method: 'POST', body: { clientId: secondId, nickname: 'Tunnel peer' } })
  const second = await connect({ clientProtocol: 2, roomId: room.payload.roomId, clientId: secondId, accessToken: access.payload.accessToken })
  const changed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('tunnel_sync_timeout')), 10000)
    second.socket.once('REC:snapshot', value => { clearTimeout(timer); resolve(value) })
  })
  const ack = await first.socket.timeout(10000).emitWithAck('CMD:seek', { expectedRevision: first.snapshot.revision, positionSeconds: 60 })
  check('tunnelCommandAck', ack.ok === true)
  check('tunnelTwoClientSync', (await changed).positionSeconds === 60)
  first.socket.disconnect()
  const restored = await connect(auth, 'polling')
  check('tunnelReconnectAndPolling', restored.snapshot.positionSeconds === 60 && restored.socket.connected)
  completed = true
  }
} catch (error) {
  failureCode = error?.code ?? error?.message ?? 'PUBLIC_VALIDATION_FAILED'
} finally {
  for (const socket of sockets) socket.disconnect()
  const report = { checks, observations, phase, failureCode, completed, passed: completed && Object.values(checks).every(Boolean), scope: 'actual Cloudflare web and IP origins; HTTPS, Range, Socket.IO sync and reconnect; no catalog mutation' }
  await fs.writeFile(directory + (process.argv.includes('--approval-only') ? '/vps-public-approval-route-20261001.json' : '/vps-public-validation-20261001.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  process.exitCode = report.passed ? 0 : 1
}
