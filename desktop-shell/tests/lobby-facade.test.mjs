import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
const source = readFileSync(new URL('../src/hooks/use-lobby-facade.ts', import.meta.url), 'utf8')
const js = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }).replace(/import .* from "react";/, 'const useCallback = fn => fn; const useMemo = fn => fn();')
const { useLobbyFacade } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
test('listing does not switch the active connection; joins use the transaction', async () => {
  const calls = []
  const origin = 'http://localhost:18081'
  const facade = useLobbyFacade({ origin, connection: { withCurrent: async (_, fn) => fn({ createRoom: async input => input }) }, createAdapter: () => ({ origin, listRooms: async () => ['room'] }), switchTo: async target => calls.push(target) })
  assert.deepEqual(await facade.listRooms(), ['room'])
  const identity = { service: 'musicparty', origin, roomId: 'r' }
  await facade.joinRoom(identity, 'fixture-only')
  assert.deepEqual(calls, [{ identity, password: 'fixture-only' }])
  await assert.rejects(facade.joinRoom({ ...identity, origin: 'http://localhost:18082' }), /origin_mismatch/)
  assert.equal(calls.length, 1)
  assert.deepEqual(await facade.createRoom({ name: 'test', isPrivate: false }), { name: 'test', isPrivate: false })
})
test('creation fails without an existing authorized connection', async () => {
  const facade = useLobbyFacade({ origin: 'http://localhost:18081', connection: { withCurrent: async (_, fn) => fn(null) }, createAdapter: () => {}, switchTo: async () => {} })
  await assert.rejects(facade.createRoom({ name: 'test', isPrivate: false }), /lobby_not_connected/)
})
