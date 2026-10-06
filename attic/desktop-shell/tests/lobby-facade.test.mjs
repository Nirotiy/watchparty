import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
const source = readFileSync(new URL('../src/hooks/use-lobby-facade.ts', import.meta.url), 'utf8')
const js = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }).replace(/import .* from "react";/, 'const useCallback = fn => fn; const useMemo = fn => fn();')
const { useLobbyFacade } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
test('listing runs over the connection and joins use the switch transaction', async () => {
  const calls = [], ran = []
  const origin = 'http://localhost:18081'
  const adapter = { createRoom: async input => input, ensureProbe: async () => { ran.push('probe') }, listRooms: async () => { ran.push('list'); return ['room'] } }
  const connection = {
    current: adapter,
    withCurrent: async (_, fn) => fn(adapter),
    run: async (requested, fn) => { ran.push(`run:${requested}`); return fn(adapter) },
  }
  const facade = useLobbyFacade({ origin, connection, switchTo: async target => calls.push(target) })
  assert.deepEqual(await facade.listRooms(), ['room'])
  assert.deepEqual(ran, [`run:${origin}`, 'probe', 'list'], 'the listing must land on the connected instance')
  const identity = { service: 'musicparty', origin, roomId: 'r' }
  await facade.joinRoom(identity, 'fixture-only')
  assert.deepEqual(calls, [{ identity, password: 'fixture-only' }])
  await assert.rejects(facade.joinRoom({ ...identity, origin: 'http://localhost:18082' }), /origin_mismatch/)
  assert.equal(calls.length, 1)
  assert.deepEqual(await facade.createRoom({ name: 'test', isPrivate: false }), { name: 'test', isPrivate: false })
})
test('browsing the lobby is what makes the create entry available', async () => {
  const origin = 'http://localhost:18081'
  const adapter = {
    origin, desktopProbe: null,
    ensureProbe: async force => { adapter.desktopProbe = { features: { roomCreate: true }, account: force ? { publicId: 'u1' } : null }; return adapter.desktopProbe },
    listRooms: async () => ['room'],
  }
  const connection = { current: null, withCurrent: async (_, fn) => fn(connection.current), run: async (_, fn) => { connection.current = adapter; return fn(adapter) } }
  const facade = () => useLobbyFacade({ origin, connection, switchTo: async () => {} })
  assert.equal(facade().canCreateRoom, false, 'nothing has been probed yet')
  assert.deepEqual(await facade().listRooms(), ['room'])
  assert.equal(facade().canCreateRoom, true, 'the probe must be readable on the instance the entry checks')
})
test('creation fails without an existing authorized connection', async () => {
  const facade = useLobbyFacade({ origin: 'http://localhost:18081', connection: { current: null, withCurrent: async (_, fn) => fn(null), run: async () => {} }, switchTo: async () => {} })
  await assert.rejects(facade.createRoom({ name: 'test', isPrivate: false }), /lobby_not_connected/)
})
test('the create entry needs a connected server that advertises roomCreate', () => {
  const origin = 'http://localhost:18081'
  const probe = (features, account = { publicId: 'u1' }) => ({ origin, desktopProbe: { features, account } })
  const canCreate = current => useLobbyFacade({ origin, connection: { current, withCurrent: async () => {} }, switchTo: async () => {} }).canCreateRoom
  assert.equal(canCreate(probe({ roomCreate: true })), true)
  // Guests may listen but not create; the server enforces the same rule, so the entry stays closed.
  assert.equal(canCreate(probe({ roomCreate: true }, { publicId: 'u1', isGuest: true })), false, 'guest session')
  for (const [label, current] of [['unadvertised', probe({})], ['disabled', probe({ roomCreate: false })], ['never probed', { origin }], ['no session yet', probe({ roomCreate: true }, null)], ['another origin', { ...probe({ roomCreate: true }), origin: 'http://localhost:18082' }], ['disconnected', null]])
    assert.equal(canCreate(current), false, label)
})

test('management is offered only for rooms this account created, on a server that offers it', () => {
  const origin = 'http://localhost:18081'
  const room = creator => ({ service: 'musicparty', origin, roomId: 'r', name: 'R', visibility: 'public', memberCount: null, requiresPassword: false, ...(creator ? { creatorPublicId: creator } : {}) })
  const facade = (probe, currentOrigin = origin) => useLobbyFacade({ origin, connection: { current: probe ? { origin: currentOrigin, desktopProbe: probe } : null, withCurrent: async () => {}, run: async () => {} }, switchTo: async () => {} })
  const offered = { features: { roomManage: true }, account: { publicId: 'u1' } }
  assert.equal(facade(offered).canManageRoom(room('u1')), true)
  for (const [label, value] of [
    ['someone else created it', facade(offered).canManageRoom(room('u2'))],
    ['the server names no creator', facade(offered).canManageRoom(room(null))],
    ['server without the feature', facade({ features: {}, account: { publicId: 'u1' } }).canManageRoom(room('u1'))],
    ['no local session', facade({ features: { roomManage: true }, account: null }).canManageRoom(room('u1'))],
    ['another origin', facade(offered, 'http://localhost:18082').canManageRoom(room('u1'))],
    ['nothing connected', facade(null).canManageRoom(room('u1'))],
  ]) assert.equal(value, false, label)
})
test('a management call refuses a room the gate did not offer', async () => {
  const origin = 'http://localhost:18081'
  const room = { service: 'musicparty', origin, roomId: 'r', name: 'R', visibility: 'public', memberCount: null, requiresPassword: false, creatorPublicId: 'someone-else' }
  const facade = useLobbyFacade({ origin, connection: { current: { origin, desktopProbe: { features: { roomManage: true }, account: { publicId: 'u1' } } }, withCurrent: async () => { throw new Error('must not be reached') }, run: async () => {} }, switchTo: async () => {} })
  await assert.rejects(facade.renameRoom(room, 'New'), /lobby_not_manageable/)
  await assert.rejects(facade.deleteRoom(room), /lobby_not_manageable/)
})

test('an unconfigured server reads as unavailable instead of throwing', async () => {
  const connection = { current: null, withCurrent: async () => { throw new Error('must not be reached') }, run: async () => { throw new Error('must not be reached') } }
  const facade = useLobbyFacade({ origin: '', connection, switchTo: async () => {} })
  assert.equal(facade.canCreateRoom, false)
  assert.equal(facade.canManageRoom({ service: 'musicparty', origin: '', roomId: 'r', name: 'R', visibility: 'public', memberCount: null, requiresPassword: false }), false)
  await assert.rejects(facade.listRooms(), /lobby_unavailable/)
})
