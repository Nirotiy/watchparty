import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { readFileSync } from 'node:fs'

const js = ts.transpile(readFileSync(new URL('../shared/lobby-contract.ts', import.meta.url), 'utf8'), { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
const { LobbyError, ServiceSwitchTransaction, applyRoomEvent, detailsFromSummary, roomKey } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

const summary = { service: 'musicparty', origin: 'https://music.example/', roomId: 'room-a', name: 'A', visibility: 'private', memberCount: 0, requiresPassword: true }

test('details are derived from summary and authoritative events', () => {
  const details = detailsFromSummary(summary)
  assert.equal(roomKey(details), 'musicparty:https://music.example:room-a')
  const next = applyRoomEvent(details, summary, { type: 'playback', snapshot: { item: null, positionSeconds: 0, playing: true, revision: 1 } })
  assert.equal(next.playback.playing, true)
  const stale = applyRoomEvent(next, { ...summary, origin: 'https://other.example' }, { type: 'connection', status: 'failed' })
  assert.equal(stale.connection, 'idle')
})

test('switch commits only after snapshot and rolls back on join failure', async () => {
  const calls = []
  const driver = {
    checkpointCurrent: async () => ({ id: 'native-checkpoint-1' }),
    suspendCurrent: async () => calls.push('suspend'),
    join: async () => { calls.push('join'); throw new Error('bad password') },
    waitForAuthoritativeSnapshot: async () => calls.push('snapshot'),
    commit: async () => calls.push('commit'),
    rollback: async checkpoint => calls.push(`rollback:${checkpoint.id}`),
    enterOffline: async () => calls.push('offline'),
  }
  await assert.rejects(new ServiceSwitchTransaction(driver).switchTo({ identity: summary }), error => error instanceof LobbyError && error.code === 'switch-failed')
  assert.deepEqual(calls, ['suspend', 'join', 'rollback:native-checkpoint-1'])
})

test('rollback failure enters offline state', async () => {
  const calls = []
  const driver = {
    checkpointCurrent: async () => ({ id: 'checkpoint' }), suspendCurrent: async () => {}, join: async () => {},
    waitForAuthoritativeSnapshot: async () => { throw new Error('no snapshot') }, commit: async () => {},
    rollback: async () => { throw new Error('restore failed') }, enterOffline: async () => calls.push('offline'),
  }
  await assert.rejects(new ServiceSwitchTransaction(driver).switchTo({ identity: summary }), error => error instanceof LobbyError && error.code === 'rollback-failed')
  assert.deepEqual(calls, ['offline'])
})
