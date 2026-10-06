import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
function moduleUrl(name) {
  const source = readFileSync(new URL(`../shared/${name}.ts`, import.meta.url), 'utf8')
  const js = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
    .replace(/from "\.\/lobby-contract"/g, `from "${name === 'lobby-contract' ? '' : moduleUrl('lobby-contract')}"`)
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
}
const { createLobbySwitchTransaction } = await import(moduleUrl('lobby-switch-driver'))
test('MusicParty join waits for a snapshot before focus and commit', async () => {
  let listener, current = null
  const calls = []
  const adapter = { subscribe(fn) { listener = fn; return () => { listener = undefined } }, async joinRoom() { calls.push('join') }, async disconnect() {} }
  const tx = createLobbySwitchTransaction({ music: { current: adapter, run: async (_, action) => action(adapter) }, watch: {}, current: () => current, nickname: () => 'test', focus: async service => calls.push(service), committed: room => { current = room } })
  const switching = tx.switchTo({ identity: { service: 'musicparty', origin: 'http://localhost:18081', roomId: 'r' } })
  await new Promise(setImmediate)
  assert.equal(current, null)
  assert.deepEqual(calls, [null, 'join'])
  listener({ type: 'room' })
  await switching
  assert.equal(current.roomId, 'r')
  assert.equal(calls.at(-1), 'musicparty')
})
test('failed target join restores native WatchParty checkpoint and awaits its snapshot', async () => {
  const previous = { service: 'watchparty', origin: 'http://localhost:18082', roomId: 'old' }
  let current = previous
  const calls = []
  const adapter = { subscribe() { return () => {} }, async joinRoom() { throw new Error('failed') }, async disconnect() {} }
  const watch = { checkpointDesktopSession: async () => ({ id: 'opaque' }), suspendDesktopSession: async () => {}, rollbackDesktopSession: async id => calls.push(id), withAuthoritativeSnapshot: async (room, action) => { calls.push(room); await action(); calls.push('snapshot') } }
  const tx = createLobbySwitchTransaction({ music: { current: adapter, run: async (_, action) => action(adapter) }, watch, current: () => current, nickname: () => 'test', focus: async service => calls.push(service), committed: room => { current = room } })
  await assert.rejects(tx.switchTo({ identity: { service: 'musicparty', origin: 'http://localhost:18081', roomId: 'new' } }), { code: 'switch-failed' })
  assert.equal(current, previous)
  assert.deepEqual(calls.slice(-4), ['old', 'opaque', 'snapshot', 'watchparty'])
})
