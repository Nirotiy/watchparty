import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'

function moduleUrl(name) {
  const source = readFileSync(new URL(`../shared/${name}.ts`, import.meta.url), 'utf8')
  const js = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
    .replace(/from "\.\/(musicparty-contract|retry)"/g, (_, dependency) => `from "${moduleUrl(dependency)}"`)
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
}
const { MusicPartyAdapter } = await import(moduleUrl('musicparty-adapter'))

test('native HTTP and clear IPC never require renderer credentials or browser fetch', async () => {
  const calls = []
  const adapter = new MusicPartyAdapter({ origin: 'https://music.example', nativeInvoke: async (command, args) => {
    calls.push({ command, args })
    return { status: 200, body: 'native lyrics' }
  } })
  assert.equal(await adapter.lyrics('netease', 'song'), 'native lyrics')
  assert.deepEqual(calls[0], { command: 'musicPartyRequest', args: { input: {
    origin: 'https://music.example', path: '/api/desktop/v1/music/netease/song/lyrics', method: 'GET', body: null, clientVersion: '0.2.0',
  } } })
  await adapter.clearSession()
  assert.deepEqual(calls[1], { command: 'clearMusicPartySession', args: { origin: 'https://music.example' } })
})
const music = { id: 'song', name: 'Song', artists: ['A', 'B'], duration: 210000, platform: 'netease', coverUrl: 'https://cdn.example/cover' }
const state = { nowPlaying: { music, currentPosition: 12000 }, isPaused: false, stateVersion: 8, queueVersion: 4, playEpoch: 3, serverTimestamp: 1000, queue: [{ queueId: 'q1', music }] }
function nativeSetup(helloPayload = { apiVersion: '2026-01', minimumClientVersion: '0.2.0' }) {
  const calls = [], pending = [], events = []
  const adapter = new MusicPartyAdapter({ origin: 'https://music.example', roomId: 'lounge', fetchImpl: async () => Response.json({ apiVersion: '2026-01' }), nativeInvoke: async (command, args) => {
    calls.push({ command, args })
    if (command === 'musicPartyWsConnect') return { event: JSON.stringify({ type: 'server.hello', payload: helloPayload }) }
    if (command === 'musicPartyWsReceive') return new Promise(resolve => pending.push(resolve))
  } })
  adapter.subscribe(event => events.push(event))
  return { adapter, calls, pending, events }
}

test('native hello gates commands and receives playback with native history and resync sends', async () => {
  const { adapter, calls, pending, events } = nativeSetup()
  assert.equal(adapter.sendChat('before'), false)
  await adapter.connect()
  assert.ok(events.some(event => event.status === 'ready'))
  assert.equal(adapter.sendChat('after'), true)
  assert.equal(adapter.sendChatHistoryFetch(), true)
  pending.shift()({ event: JSON.stringify({ type: 'player.state', payload: state }) })
  await new Promise(setImmediate)
  assert.ok(events.some(event => event.type === 'playback'))
  pending.shift()({ event: JSON.stringify({ type: 'queue.patch', payload: { queueVersion: 9, operation: 'clear' } }) })
  await new Promise(setImmediate)
  assert.deepEqual(calls.filter(call => call.command === 'musicPartyWsSend').map(call => JSON.parse(call.args.event).type), ['chat.message', 'chat.history.fetch', 'player.resync'])
  await adapter.disconnect()
})

test('native incompatible hello blocks commands without scheduling reconnect', async () => {
  const { adapter, calls, events } = nativeSetup({ apiVersion: '2099-01', minimumClientVersion: '0.2.0' })
  await adapter.connect()
  assert.equal(adapter.sendChat('blocked'), false)
  assert.ok(events.some(event => event.code === 'version-incompatible'))
  assert.equal(events.some(event => event.status === 'reconnecting'), false)
  assert.equal(calls.filter(call => call.command === 'musicPartyWsConnect').length, 1)
  await adapter.disconnect()
})

test('native stale receive cannot emit into a replacement connection', async () => {
  const { adapter, pending, events } = nativeSetup()
  await adapter.connect()
  const oldReceive = pending.shift()
  await adapter.disconnect()
  await adapter.joinRoom('other')
  oldReceive({ event: JSON.stringify({ type: 'chat.message', payload: { id: 'stale', content: 'old room' } }) })
  await new Promise(setImmediate)
  assert.equal(events.some(event => event.id === 'stale'), false)
  await adapter.disconnect()
})
class Socket {
  readyState = 1
  sent = []
  send(data) { this.sent.push(JSON.parse(data)) }
  close() { this.onclose?.() }
  receive(type, payload) { this.onmessage?.({ data: JSON.stringify({ type, roomId: 'lounge', payload }) }) }
}
function setup(fetchImpl) {
  const sockets = [], events = []
  const adapter = new MusicPartyAdapter({ origin: 'https://music.example', roomId: 'lounge', fetchImpl: fetchImpl ?? (async () => Response.json({ apiVersion: '2026-01' })), webSocketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket } })
  adapter.subscribe(event => events.push(event))
  return { adapter, sockets, events }
}
test('headers, lyrics path, resolve metadata and player load', async () => {
  const requests = []
  const { adapter } = setup(async (url, init) => {
    requests.push({ url: String(url), init })
    if (String(url).endsWith('/lyrics')) return new Response('lyrics')
    if (String(url).endsWith('/resolve')) return Response.json({ url: 'https://cdn.example/audio', expiresAt: null, contentType: null, resolvedAt: 1710000000000, music })
    return Response.json({ roomId: 'lounge', apiVersion: '2026-01' })
  })
  assert.equal(await adapter.lyrics('netease', 'a/b'), 'lyrics')
  assert.equal(requests[0].url, 'https://music.example/api/desktop/v1/music/netease/a%2Fb/lyrics')
  const resolved = await adapter.resolveMedia('netease', 'song')
  assert.deepEqual(resolved.music, music)
  assert.equal(resolved.expiresAt, null)
  let loaded
  await adapter.loadForPlayer({ load: async (item, url) => { loaded = { item, url } } }, { platform: 'netease', sourceId: 'song' })
  assert.equal(loaded.item.durationSeconds, 210)
  assert.equal(loaded.item.artist, 'A, B')
  await adapter.redeemInvite('invite')
  for (const { init } of requests) {
    assert.equal(init.headers.get('X-Desktop-API-Version'), '2026-01')
    assert.equal(init.headers.get('X-Desktop-Client-Version'), '0.2.0')
    assert.equal(init.headers.get('Cookie'), null)
  }
  assert.equal(requests.find(r => r.init.method === 'POST').init.headers.get('X-CSRF-Token'), null)
  await adapter.disconnect()
})
test('capabilities providers and search field variants', async () => {
  const { adapter } = setup(async (url) => {
    if (String(url).includes('/capabilities')) return Response.json({ providers: { netease: true, youtube: false } })
    return Response.json({ items: [{ id: '1', title: 'T', artists: ['A', 'B'], coverUrl: 'https://c/1' }, { songId: '2', name: 'N', artist: 'Solo', picUrl: 'https://c/2' }] })
  })
  assert.deepEqual(await adapter.listPlatforms(), [{ id: 'netease', name: 'netease' }, { id: 'youtube', name: 'youtube' }])
  const results = await adapter.search('netease', 'x')
  assert.equal(results[0].artist, 'A, B'); assert.equal(results[0].artworkUrl, 'https://c/1')
  assert.equal(results[1].sourceId, '2'); assert.equal(results[1].artist, 'Solo')
  await adapter.disconnect()
})
test('capabilities providers array shape', async () => {
  const { adapter } = setup(async () => Response.json({ providers: ['netease', 'bilibili'] }))
  assert.deepEqual(await adapter.listPlatforms(), [{ id: 'netease', name: 'netease' }, { id: 'bilibili', name: 'bilibili' }])
  await adapter.disconnect()
})
for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [502, 'media-failed'], [426, 'version-incompatible']]) {
  test(`HTTP ${status} maps to ${code}`, async () => {
    const { adapter, events } = setup(async () => new Response(status === 403 ? 'upstream denied' : '', { status, headers: status === 403 ? { 'content-type': 'text/html' } : undefined }))
    await assert.rejects(adapter.resolveMedia('netease', 'song'), error => error.code === code && error.status === status)
    assert.equal(events.at(-1).code, code)
    await adapter.connect()
    assert.equal(events.at(-1).status, 'failed')
  })
}
test('socket normalization, queue gaps, and replacement after reconnect', async () => {
  const { adapter, sockets, events } = setup()
  await adapter.connect()
  const socket = sockets[0]
  socket.onopen()
  assert.deepEqual(socket.sent[0], { type: 'client.hello', payload: { apiVersion: '2026-01', clientVersion: '0.2.0' } })
  socket.receive('server.hello', { apiVersion: '2026-01' })
  assert.equal(events.at(-1).type, 'connection')
  socket.receive('player.state', state)
  assert.equal(events.find(e => e.type === 'playback').snapshot.positionSeconds, 12)
  socket.receive('queue.patch', { operation: 'append', queueVersion: 5, items: [{ queueId: 'q2', music }] })
  assert.equal(events.at(-1).items.length, 2)
  socket.receive('queue.patch', { operation: 'clear', queueVersion: 7 })
  assert.equal(socket.sent.at(-1).type, 'player.resync')
  socket.receive('player.progress', { currentPosition: 13000, stateVersion: 8, playEpoch: 3, serverTimestamp: 2000 })
  assert.equal(events.at(-1).snapshot.positionSeconds, 13)
  assert.equal(events.at(-1).snapshot.queueVersion, 5)
  socket.receive('users.online', { users: [{ publicId: 'u1', name: 'User' }] })
  assert.deepEqual(events.at(-1).members, [{ id: 'u1', name: 'User', online: true }])
  assert.equal(events.find(e => e.type === 'server-ready').apiVersion, '2026-01')
  socket.receive('sync.pong', { pingId: 'p', clientSendTime: 1, serverReceiveTime: 2, serverSendTime: 3 })
  assert.equal(events.at(-1).type, 'clock-sync')
  socket.receive('player.events', { code: 'MEDIA_FAILED', severity: 'error', message: 'failed' })
  assert.equal(events.at(-1).code, 'media-failed')
  await adapter.connect()
  sockets[1].onopen()
  sockets[1].receive('server.hello', { apiVersion: '2026-01' })
  sockets[1].receive('player.state', { ...state, nowPlaying: null, queue: [], stateVersion: 1, queueVersion: 1, playEpoch: 1 })
  assert.equal(events.at(-1).items.length, 0)
  const snapshot = events.filter(e => e.type === 'playback').at(-1).snapshot
  assert.equal(snapshot.stateVersion, 1)
  assert.equal(snapshot.playEpoch, 1)
  assert.equal(snapshot.item, null)
  const count = events.length
  socket.receive('player.state', state)
  assert.equal(events.length, count)
  await adapter.disconnect()
})
