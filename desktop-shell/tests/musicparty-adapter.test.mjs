import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'

function moduleUrl(name) {
  const source = readFileSync(new URL(`../shared/${name}.ts`, import.meta.url), 'utf8')
  const js = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
    .replace(/from "\.\/(musicparty-contract|retry|shared-room-state)"/g, (_, dependency) => `from "${moduleUrl(dependency)}"`)
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
}
const { MusicPartyAdapter } = await import(moduleUrl('musicparty-adapter'))

test('room summaries use the public list fields and respect existing access', async () => {
  const adapter = new MusicPartyAdapter({ origin: 'https://music.example/path', fetchImpl: async url => {
    assert.equal(url.pathname, '/api/rooms')
    return Response.json([{ roomId: 'r', name: 'Private', privateRoom: true, onlineCount: 3, accessGranted: true }])
  } })
  assert.deepEqual(await adapter.listRooms(), [{ service: 'musicparty', origin: 'https://music.example', roomId: 'r', name: 'Private', visibility: 'private', memberCount: 3, requiresPassword: false }])
})

test('room creation waits for acknowledgement and rejects explicit failure or disconnect', async () => {
  const { adapter, pending } = nativeSetup()
  await adapter.connect()
  const created = adapter.createRoom({ name: 'Test', isPrivate: false })
  await assert.rejects(adapter.createRoom({ name: 'Other', isPrivate: false }), { code: 'in-progress' })
  pending.shift()({ event: JSON.stringify({ type: 'rooms.created', payload: { roomId: 'new', name: 'Test', privateRoom: false } }) })
  assert.equal((await created).roomId, 'new')
  await new Promise(setImmediate)
  const rejected = adapter.createRoom({ name: 'Test', isPrivate: false })
  pending.shift()({ event: JSON.stringify({ type: 'player.events', payload: { code: 'ROOM_CREATE_FAILED', message: 'Denied', severity: 'error' } }) })
  await assert.rejects(rejected, { code: 'rejected' })
  const disconnected = adapter.createRoom({ name: 'Test', isPrivate: false })
  const assertion = assert.rejects(disconnected, { code: 'disconnected' })
  await adapter.disconnect()
  await assertion
})

test('create timeout blocks ambiguous retry until a new connection', async () => {
  const { adapter } = nativeSetup()
  await adapter.connect()
  await assert.rejects(adapter.createRoom({ name: 'Test', isPrivate: false }, 1), { code: 'timeout' })
  await assert.rejects(adapter.createRoom({ name: 'Test', isPrivate: false }), { code: 'in-progress' })
  await adapter.disconnect()
})

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
const sharedState = { ...state, isShuffle: false, isPauseLocked: true, isSkipLocked: false, isShuffleLocked: true, isLoading: false,
  nowPlaying: { ...state.nowPlaying, enqueuedById: 'u1', enqueuedByName: 'Alice', likedUserIds: ['u2'], positionUpdatedAt: 900, playEpoch: 3 } }

test('shared projection rejects missing fields while preserving legacy playback', async () => {
  const { adapter, sockets, events } = setup()
  await adapter.connect()
  const socket = sockets[0]
  for (const key of ['isShuffle', 'isPauseLocked', 'isSkipLocked', 'isShuffleLocked', 'isLoading']) {
    const incomplete = { ...sharedState }
    delete incomplete[key]
    socket.receive('player.state', incomplete)
  }
  for (const key of ['enqueuedById', 'enqueuedByName', 'likedUserIds', 'positionUpdatedAt']) {
    const incomplete = { ...sharedState, nowPlaying: { ...sharedState.nowPlaying } }
    delete incomplete.nowPlaying[key]
    socket.receive('player.state', incomplete)
  }
  assert.equal(events.filter(event => event.type === 'shared-room-state').length, 0)
  assert.equal(events.filter(event => event.type === 'playback').length, 9)
  socket.receive('player.state', sharedState)
  const projected = events.find(event => event.type === 'shared-room-state').state
  assert.equal(projected.pauseLocked, true)
  assert.equal(projected.shuffleLocked, true)
  assert.equal(projected.enqueuedByName, 'Alice')
  assert.deepEqual(projected.likedUserIds, ['u2'])
  assert.equal(projected.positionUpdatedAt, 900)
  await adapter.disconnect()
})

test('shared projection rejects regressed versions and same-version older state frames', async () => {
  const { adapter, sockets, events } = setup()
  await adapter.connect()
  const socket = sockets[0]
  socket.receive('player.state', sharedState)
  socket.receive('player.progress', { currentPosition: 15000, stateVersion: 8, playEpoch: 3, serverTimestamp: 2000 })
  const count = events.filter(event => event.type === 'shared-room-state').length
  for (const payload of [{ ...sharedState, stateVersion: 7 }, { ...sharedState, queueVersion: 3 }, sharedState]) socket.receive('player.state', payload)
  assert.equal(events.filter(event => event.type === 'shared-room-state').length, count)
  assert.equal(events.filter(event => event.type === 'shared-room-state').at(-1).state.positionAnchorMs, 15000)
  await adapter.disconnect()
})

test('shared projection rejects mismatched progress and nested play epochs', async () => {
  const { adapter, sockets, events } = setup()
  await adapter.connect()
  const socket = sockets[0]
  socket.receive('player.state', sharedState)
  socket.receive('player.progress', { currentPosition: 99000, stateVersion: 8, playEpoch: 4, serverTimestamp: 2000 })
  socket.receive('player.state', { ...sharedState, nowPlaying: { ...sharedState.nowPlaying, playEpoch: 4 } })
  assert.equal(events.filter(event => event.type === 'shared-room-state').length, 1)
  await adapter.disconnect()
})

test('shared position freezes without a fresh trusted clock or position frame', async () => {
  const { emptySharedRoomState, applyPlayerState, addClockSample, sharedPositionMs } = await import(moduleUrl('shared-room-state'))
  const projected = applyPlayerState(emptySharedRoomState('lounge'), sharedState, 1000)
  assert.equal(sharedPositionMs(projected, 2000), 12000)
  const trusted = addClockSample(projected, { pingId: 'p', clientSendTime: 1000, serverReceiveTime: 1000, serverSendTime: 1000 }, 1000)
  assert.equal(sharedPositionMs(trusted, 2000), 13000)
  assert.equal(sharedPositionMs(trusted, 16000), 12000)
  const freshClock = addClockSample(trusted, { pingId: 'p2', clientSendTime: 16000, serverReceiveTime: 16000, serverSendTime: 16000 }, 16000)
  assert.equal(sharedPositionMs(freshClock, 16000), 12000)
})

test('clock samples use NTP math, drop unusable rtt and take the median of the best half', async () => {
  const { emptySharedRoomState, addClockSample, clockOffsetMs, clockTrusted } = await import(moduleUrl('shared-room-state'))
  let state = emptySharedRoomState('lounge')
  state = addClockSample(state, { pingId: 'a', clientSendTime: 0, serverReceiveTime: 100, serverSendTime: 200 }, 1100)
  assert.equal(state.clockSamples[0].rttMs, 1000)
  assert.equal(clockOffsetMs(state.clockSamples), -400)
  state = addClockSample(state, { pingId: 'b', clientSendTime: 0, serverReceiveTime: 0, serverSendTime: 0 }, 2000)
  state = addClockSample(state, { pingId: 'c', clientSendTime: 3000, serverReceiveTime: 3100, serverSendTime: 3050 }, 3100)
  assert.equal(state.clockSamples.length, 1)
  state = addClockSample(state, { pingId: 'd', clientSendTime: 2000, serverReceiveTime: 7100, serverSendTime: 7100 }, 2200)
  state = addClockSample(state, { pingId: 'e', clientSendTime: 3000, serverReceiveTime: 8250, serverSendTime: 8250 }, 3300)
  state = addClockSample(state, { pingId: 'f', clientSendTime: 4000, serverReceiveTime: 13600, serverSendTime: 13600 }, 5200)
  state = addClockSample(state, { pingId: 'g', clientSendTime: 5000, serverReceiveTime: 14750, serverSendTime: 14750 }, 6300)
  assert.equal(state.clockSamples.length, 5)
  assert.equal(clockOffsetMs(state.clockSamples), 5000)
  assert.equal(clockTrusted(state, 6300), true)
  assert.equal(clockTrusted(state, 21300), false)
})

test('control commands send contract literals, stay single in-flight and never resend on timeout', async () => {
  const { adapter, sockets, events } = setup()
  await adapter.connect()
  globalThis.WebSocket ??= { OPEN: 1 }
  const socket = sockets[0]
  socket.receive('server.hello', { apiVersion: '2026-01' })
  socket.receive('player.state', sharedState)
  let settled = false
  const seek = adapter.sendControl('seek', { positionMs: 12345.6 }).then(value => { settled = true; return value })
  await new Promise(setImmediate)
  const seekWire = socket.sent.at(-1)
  assert.equal(seekWire.type, 'control.seek')
  assert.equal(seekWire.payload.positionMs, 12346)
  assert.equal(seekWire.roomId, 'lounge')
  assert.ok(typeof seekWire.requestId === 'string' && seekWire.requestId.length > 0)
  assert.equal('mutationId' in seekWire.payload, false)
  await assert.rejects(adapter.sendControl('pause'), { code: 'in-progress' })
  assert.equal(settled, false)
  assert.equal(await seek, 'unknown')
  assert.equal(socket.sent.filter(message => message.type.startsWith('control.')).length, 1)
  assert.ok(socket.sent.some(message => message.type === 'player.resync'))
  const seekPending = events.filter(event => event.type === 'command-pending' && event.kind === 'seek')
  assert.deepEqual(seekPending.map(event => event.pending), [true, false])
  assert.equal(seekPending[0].requestId, seekWire.requestId)
  const pauseAt = socket.sent.length
  assert.equal(await adapter.sendControl('pause', {}, 20), 'unknown')
  assert.equal(socket.sent[pauseAt].type, 'control.toggle-pause')
  assert.deepEqual(socket.sent[pauseAt].payload, {})
  await adapter.disconnect()
})

test('control kinds map to wire types, seek clamps to known duration and like requires a track', async () => {
  const { adapter, sockets } = setup()
  await assert.rejects(adapter.sendControl('next'), { code: 'not-connected' })
  await adapter.connect()
  globalThis.WebSocket ??= { OPEN: 1 }
  const socket = sockets[0]
  socket.receive('server.hello', { apiVersion: '2026-01' })
  socket.receive('player.state', sharedState)
  await assert.rejects(adapter.sendControl('seek', { positionMs: Number.NaN }), { code: 'invalid-input' })
  for (const [kind, type] of [['play', 'control.toggle-pause'], ['pause', 'control.toggle-pause'], ['next', 'control.next'], ['shuffle', 'control.toggle-shuffle'], ['like', 'control.like']]) {
    const sentAt = socket.sent.length
    const command = adapter.sendControl(kind, {}, 100)
    assert.equal(socket.sent[sentAt].type, type)
    socket.receive('control.ack', { requestId: socket.sent[sentAt].requestId, outcome: 'noop', committed: { stateVersion: 8, queueVersion: 4, playEpoch: 3 } })
    assert.equal(await command, 'noop')
    assert.deepEqual(socket.sent[sentAt].payload, kind === 'like' ? { expectedPlayEpoch: 3 } : {})
    assert.ok(socket.sent[sentAt].requestId)
  }
  const lowAt = socket.sent.length
  const low = adapter.sendControl('seek', { positionMs: -50 }, 100)
  socket.receive('control.ack', { requestId: socket.sent[lowAt].requestId, outcome: 'noop', committed: { stateVersion: 8, queueVersion: 4, playEpoch: 3 } })
  await low
  assert.equal(socket.sent[lowAt].payload.positionMs, 0)
  const highAt = socket.sent.length
  const high = adapter.sendControl('seek', { positionMs: 999999 }, 100)
  socket.receive('control.ack', { requestId: socket.sent[highAt].requestId, outcome: 'noop', committed: { stateVersion: 8, queueVersion: 4, playEpoch: 3 } })
  await high
  assert.equal(socket.sent[highAt].payload.positionMs, 210000)
  socket.receive('player.state', { ...sharedState, nowPlaying: null })
  await assert.rejects(adapter.sendControl('like'), { code: 'invalid-input' })
  await adapter.disconnect()
})

test('controlIdempotency requires validated snapshot scope and sends both fields', async () => {
  const { adapter, sockets } = setup(async url => String(url).includes('/capabilities')
    ? Response.json({ apiVersion: '2026-01', features: { controlIdempotency: true, controlPreconditions: true } })
    : Response.json({ apiVersion: '2026-01' }))
  await adapter.connect()
  globalThis.WebSocket ??= { OPEN: 1 }
  const socket = sockets[0]
  socket.receive('server.hello', { apiVersion: '2026-01' })
  socket.receive('player.state', { ...sharedState, idempotencyScopeId: 'scope-one', idempotencyTtlMs: 60000 })
  const sentAt = socket.sent.length
  assert.equal(await adapter.sendControl('next', {}, 5), 'unknown')
  const wire = socket.sent[sentAt]
  assert.equal(wire.type, 'control.next')
  assert.ok(typeof wire.payload.mutationId === 'string' && wire.payload.mutationId.length > 0)
  assert.equal(wire.payload.idempotencyScopeId, 'scope-one')
  await adapter.disconnect()
  await adapter.connect()
  const reconnected = sockets.at(-1)
  reconnected.receive('server.hello', { apiVersion: '2026-01' })
  const beforeSnapshot = reconnected.sent.length
  await assert.rejects(adapter.sendControl('next'), { code: 'not-ready' })
  assert.equal(reconnected.sent.length, beforeSnapshot)
  reconnected.receive('player.state', { ...sharedState, idempotencyScopeId: 'scope-two', idempotencyTtlMs: 60000 })
  for (const metadata of [{}, { idempotencyScopeId: 'bad', idempotencyTtlMs: 0 }, { idempotencyScopeId: '', idempotencyTtlMs: 60000 }]) {
    reconnected.receive('player.state', { ...sharedState, ...metadata })
    const before = reconnected.sent.length
    await assert.rejects(adapter.sendControl('next'), { code: 'not-ready' })
    assert.equal(reconnected.sent.length, before)
  }
  await adapter.disconnect()
})

test('control ACK resolves only the matching request and preserves the outcome', async () => {
  const { adapter, sockets } = setup()
  await adapter.connect()
  const socket = sockets[0]
  socket.receive('server.hello', { apiVersion: '2026-01' })
  socket.receive('player.state', sharedState)
  const pending = adapter.sendControl('next', {}, 1000)
  await new Promise(setImmediate)
  const requestId = socket.sent.at(-1).requestId
  socket.receive('control.ack', { requestId: 'other', outcome: 'applied', committed: { stateVersion: 8, queueVersion: 4, playEpoch: 3 } })
  await new Promise(setImmediate)
  socket.receive('control.ack', { requestId, outcome: 'noop', committed: { stateVersion: 8, queueVersion: 4, playEpoch: 3 } })
  assert.equal(await pending, 'noop')
  await adapter.disconnect()
})
test('ACK first waits for all committed watermarks and unobserved state times out without resend', async () => {
  const { adapter, sockets, events } = setup()
  await adapter.connect()
  const socket = sockets[0]
  socket.receive('server.hello', { apiVersion: '2026-01' })
  socket.receive('player.state', sharedState)
  const pending = adapter.sendControl('next', {}, 100)
  const requestId = socket.sent.at(-1).requestId
  const ack = { requestId, outcome: 'applied', committed: { stateVersion: 9, queueVersion: 5, playEpoch: 3 } }
  socket.receive('control.ack', ack, { roomId: 'other' })
  socket.receive('control.ack', ack)
  await assert.rejects(adapter.sendControl('next'), { code: 'in-progress' })
  socket.receive('player.state', { ...sharedState, stateVersion: 9 })
  await assert.rejects(adapter.sendControl('next'), { code: 'in-progress' })
  socket.receive('player.state', { ...sharedState, stateVersion: 9, queueVersion: 5 })
  assert.equal(await pending, 'applied')
  const uncertain = adapter.sendControl('next', {}, 15)
  socket.receive('control.ack', { requestId: socket.sent.at(-1).requestId, outcome: 'noop', committed: { stateVersion: 20, queueVersion: 5, playEpoch: 3 } })
  assert.equal(await uncertain, 'unknown')
  assert.equal(socket.sent.filter(frame => frame.type === 'control.next').length, 2)
  assert.equal(socket.sent.filter(frame => frame.type === 'player.resync').length, 1)
  assert.equal(events.filter(event => event.type === 'command-pending' && event.pending).length, 2)
  await adapter.disconnect()
})

test('legacy capabilities disable epoch-sensitive controls and rejected ACK preserves code once', async () => {
  const { adapter, sockets, events } = setup(async () => Response.json({ apiVersion: '2026-01' }))
  await adapter.connect()
  const socket = sockets[0]
  socket.receive('server.hello', { apiVersion: '2026-01' })
  socket.receive('player.state', sharedState)
  await assert.rejects(adapter.sendControl('seek', { positionMs: 0 }), { code: 'unsupported' })
  await assert.rejects(adapter.sendControl('like'), { code: 'unsupported' })
  const pending = adapter.sendControl('pause')
  const requestId = socket.sent.at(-1).requestId
  const ack = { requestId, outcome: 'rejected', code: 'PAUSE_LOCKED' }
  socket.receive('control.ack', ack)
  socket.receive('control.ack', ack)
  socket.receive('player.events', { code: 'CONTROL_DENIED', severity: 'warning', message: 'Denied' })
  assert.equal(await pending, 'rejected')
  assert.deepEqual(events.filter(event => event.type === 'denied'), [{ type: 'denied', requestId, roomId: 'lounge', code: 'PAUSE_LOCKED', message: 'PAUSE_LOCKED' }])
  await adapter.disconnect()
})

test('scope replacement invalidates pending watermarks and accepts a reset runtime state', async () => {
  const { adapter, sockets, events } = setup(async () => Response.json({ apiVersion: '2026-01', features: { controlIdempotency: true } }))
  await adapter.connect()
  const socket = sockets[0]
  socket.receive('server.hello', { apiVersion: '2026-01' })
  socket.receive('player.state', { ...sharedState, idempotencyScopeId: 'first', idempotencyTtlMs: 60000 })
  const old = adapter.sendControl('next')
  const oldId = socket.sent.at(-1).requestId
  socket.receive('control.ack', { requestId: oldId, outcome: 'applied', committed: { stateVersion: 99, queueVersion: 99, playEpoch: 99 } })
  socket.receive('player.state', { ...sharedState, stateVersion: 1, queueVersion: 1, playEpoch: 1, nowPlaying: null, idempotencyScopeId: 'second', idempotencyTtlMs: 60000 })
  assert.equal(await old, 'unknown')
  assert.equal(events.filter(event => event.type === 'shared-room-state').at(-1).state.stateVersion, 1)
  const current = adapter.sendControl('next')
  socket.receive('control.ack', { requestId: oldId, outcome: 'rejected' })
  await assert.rejects(adapter.sendControl('next'), { code: 'in-progress' })
  await adapter.disconnect()
  assert.equal(await current, 'unknown')
  await adapter.connect()
  const replacement = sockets.at(-1)
  replacement.receive('server.hello', { apiVersion: '2026-01' })
  replacement.receive('player.state', { ...sharedState, idempotencyScopeId: 'third', idempotencyTtlMs: 60000 })
  const next = adapter.sendControl('next')
  const nextId = replacement.sent.at(-1).requestId
  socket.receive('control.ack', { requestId: nextId, outcome: 'rejected' })
  await assert.rejects(adapter.sendControl('next'), { code: 'in-progress' })
  replacement.receive('control.ack', { requestId: nextId, outcome: 'rejected' })
  assert.equal(await next, 'rejected')
  await adapter.disconnect()
})

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
  receive(type, payload, envelope = {}) { this.onmessage?.({ data: JSON.stringify({ type, roomId: 'lounge', requestId: type === 'control.ack' ? payload.requestId : undefined, payload, ...envelope }) }) }
}
function setup(fetchImpl) {
  const sockets = [], events = []
  const adapter = new MusicPartyAdapter({ origin: 'https://music.example', roomId: 'lounge', fetchImpl: fetchImpl ?? (async url => String(url).includes('/capabilities') ? Response.json({ apiVersion: '2026-01', features: { controlPreconditions: true } }) : Response.json({ apiVersion: '2026-01' })), webSocketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket } })
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
  assert.deepEqual(JSON.parse(requests.find(r => r.init.method === 'POST').init.body), { code: 'invite', displayName: '桌面用户' })
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

test('D3 provider matrix and protocol events remain isolated', async () => {
  const matrix = {
    netease: { status: 200, url: 'https://fixture.example/netease/101' },
    youtube: { status: 200, url: 'https://fixture.example/youtube/202' },
    bilibili: { status: 502, url: '' },
  }
  const requests = []
  const { adapter, sockets, events } = setup(async (url) => {
    const value = String(url)
    requests.push(value)
    if (value.includes('/capabilities')) return Response.json({ apiVersion: '2026-01', providers: ['netease', 'youtube', 'bilibili'] })
    const match = value.match(/\/media\/([^/]+)\/([^/]+)\/resolve$/)
    if (match) {
      const result = matrix[match[1]]
      if (!result || result.status !== 200) return new Response('provider unavailable', { status: result?.status ?? 404 })
      return Response.json({ url: result.url, expiresAt: null, contentType: 'audio/mpeg', resolvedAt: 1710000000000, music })
    }
    if (value.endsWith('/lyrics')) return new Response('fixture lyrics')
    if (value.includes('/cover')) return new Response('cover', { status: 200, headers: { 'content-type': 'image/jpeg' } })
    return Response.json({ items: [{ id: '101', title: 'Fixture', artists: ['A'], coverUrl: 'https://fixture.example/cover' }] })
  })
  assert.deepEqual(await adapter.listPlatforms(), [{ id: 'netease', name: 'netease' }, { id: 'youtube', name: 'youtube' }, { id: 'bilibili', name: 'bilibili' }])
  assert.equal((await adapter.resolveMedia('netease', '101')).url, matrix.netease.url)
  assert.equal((await adapter.resolveMedia('youtube', '202')).url, matrix.youtube.url)
  await assert.rejects(adapter.resolveMedia('bilibili', '303'), error => error.status === 502 && error.code === 'media-failed')
  assert.equal(await adapter.lyrics('netease', '101'), 'fixture lyrics')
  assert.equal((await adapter.search('netease', 'fixture'))[0].artworkUrl, 'https://fixture.example/cover')
  await adapter.connect()
  sockets[0].receive('server.hello', { apiVersion: '2026-01' })
  sockets[0].receive('users.online', { users: [{ publicId: 'u1', name: 'Alice' }] })
  sockets[0].receive('chat.history', [{ id: 'c1', content: 'hello', author: { name: 'Alice' } }])
  sockets[0].receive('chat.message', { id: 'c2', content: 'world', author: { name: 'Bob' } })
  assert.deepEqual(events.filter(event => event.type === 'members').at(-1).members, [{ id: 'u1', name: 'Alice', online: true }])
  assert.deepEqual(events.filter(event => event.type === 'chat').map(event => event.content), ['hello', 'world'])
  sockets[0].receive('server.hello', { apiVersion: '2099-01' })
  assert.ok(events.some(event => event.code === 'version-incompatible'))
  await adapter.disconnect()
  assert.ok(requests.some(url => url.includes('/media/netease/101/resolve')))
})

test('D3 media failure stops native player and suppresses the failed play epoch', async () => {
  const { adapter, sockets } = setup(async (url) => {
    if (String(url).endsWith('/resolve')) return Response.json({ url: 'https://fixture.example/audio', expiresAt: null, contentType: 'audio/mpeg', resolvedAt: 1710000000000, music })
    return Response.json({ apiVersion: '2026-01' })
  })
  const calls = []
  const unsubscribe = adapter.bindPlayer({
    async load() { calls.push('load') },
    async stop() { calls.push('stop') },
    async applySnapshot() { calls.push('snapshot') },
  })
  await adapter.connect()
  sockets[0].receive('server.hello', { apiVersion: '2026-01' })
  sockets[0].receive('player.state', state)
  await new Promise(resolve => setImmediate(resolve))
  sockets[0].receive('player.events', { code: 'MEDIA_FAILED', severity: 'error', message: 'fixture failure' })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(calls.includes('stop'))
  const loads = calls.filter(call => call === 'load').length
  sockets[0].receive('player.progress', { currentPosition: 13000, stateVersion: 8, playEpoch: 3, serverTimestamp: 2000 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.filter(call => call === 'load').length, loads)
  unsubscribe()
  await adapter.disconnect()
})

test('enqueue waits for matching ACK and rejects on NACK or disconnect', async () => {
  const { adapter, sockets } = setup()
  await adapter.connect()
  globalThis.WebSocket ??= { OPEN: 1 }
  const socket = sockets[0]
  socket.receive('server.hello', { apiVersion: '2026-01' })
  let settled = false
  const first = adapter.enqueue('netease', 'song').then(value => { settled = true; return value })
  await new Promise(setImmediate)
  assert.equal(settled, false)
  socket.receive('enqueue.ack', { mutationId: socket.sent.at(-1).payload.mutationId })
  assert.equal(await first, true)
  const rejected = adapter.enqueue('netease', 'song')
  socket.receive('enqueue.nack', { mutationId: socket.sent.at(-1).payload.mutationId, reason: 'forbidden' })
  assert.equal(await rejected, false)
  const disconnected = adapter.enqueue('netease', 'song')
  await adapter.disconnect()
  assert.equal(await disconnected, false)
})

test('binding restores latest state, switches media and applies same-song progress', async () => {
  const { adapter, sockets } = setup(async url => String(url).endsWith('/resolve')
    ? Response.json({ music, url: '/audio.wav' }) : Response.json({ apiVersion: '2026-01' }))
  await adapter.connect()
  const socket = sockets[0]
  socket.receive('player.state', state)
  const loads = [], snapshots = []
  const unbind = adapter.bindPlayer({ stop: async () => {}, load: async (item, url) => loads.push({ item, url }), applySnapshot: async s => snapshots.push(s) })
  await new Promise(setImmediate)
  assert.equal(loads[0].item.id, 'song')
  assert.equal(loads[0].url, 'https://music.example/audio.wav')
  socket.receive('player.progress', { currentPosition: 15000, stateVersion: 8, playEpoch: 3, serverTimestamp: 2000 })
  await new Promise(setImmediate)
  assert.equal(snapshots.at(-1).positionSeconds, 15)
  assert.equal(loads.length, 1)
  socket.receive('player.state', { ...state, playEpoch: 4, nowPlaying: { music: { ...music, id: 'next' }, currentPosition: 0 } })
  await new Promise(setImmediate)
  assert.equal(loads.at(-1).item.id, 'next')
  unbind()
  await adapter.disconnect()
})

test('unbind during asynchronous focus cannot resume or reapply an obsolete snapshot', async () => {
  const { adapter, sockets } = setup(async url => String(url).endsWith('/resolve')
    ? Response.json({ music, url: '/audio.wav' }) : Response.json({ apiVersion: '2026-01' }))
  await adapter.connect()
  sockets[0].receive('player.state', state)
  let releaseFocus
  const snapshots = []
  const unbind = adapter.bindPlayer({ stop: async () => {}, load: async () => {},
    applySnapshot: async snapshot => snapshots.push(snapshot), resume: async () => assert.fail('stale resume'),
  }, () => new Promise(resolve => { releaseFocus = resolve }))
  await new Promise(setImmediate)
  assert.equal(typeof releaseFocus, 'function')
  unbind()
  const count = snapshots.length
  releaseFocus()
  await new Promise(setImmediate)
  assert.equal(snapshots.length, count)
  await adapter.disconnect()
})
