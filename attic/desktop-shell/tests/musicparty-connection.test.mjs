import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { setTimeout as wait } from 'node:timers/promises'
const js = ts.transpile(readFileSync(new URL('../shared/musicparty-connection.ts', import.meta.url), 'utf8'), { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
const { MusicPartyConnection } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('A to B to A restores each origin room without sharing room IDs', async () => {
  const connection = new MusicPartyConnection((origin, roomId) => ({
    roomId, subscribe: () => () => {}, disconnect: async () => {},
  }), () => {})
  await connection.run('https://a.example', async a => { a.roomId = 'private-a' })
  await connection.run('https://b.example', async b => { assert.equal(b.roomId, undefined); b.roomId = 'private-b' })
  await connection.run('https://a.example', async a => assert.equal(a.roomId, 'private-a'))
  await connection.run('https://b.example', async b => assert.equal(b.roomId, 'private-b'))
  await connection.dispose()
})

test('logout finishes before switching and stale auth actions cannot affect the replacement', async () => {
  const order = []
  const connection = new MusicPartyConnection(origin => ({
    subscribe: () => () => {}, disconnect: async () => order.push(`disconnect:${origin}`),
  }), () => {})
  await connection.run('https://a.example', async () => {})
  const logout = connection.withCurrent('https://a.example', async adapter => {
    await wait(10); order.push('logout:A'); await adapter.disconnect()
  })
  const switching = connection.run('https://b.example', async () => order.push('connected:B'))
  const stale = connection.withCurrent('https://a.example', async () => assert.fail('stale action ran'))
  await Promise.all([logout, switching, assert.rejects(stale, /service_changed/)])
  assert.ok(order.indexOf('logout:A') < order.indexOf('connected:B'))
  await connection.dispose()
})

test('entry binds before the first room snapshot without any enqueue operation', async () => {
  const order = []
  const player = { applySnapshot: async state => order.push(state.playing ? 'playing' : 'paused') }
  let bound
  const connection = new MusicPartyConnection(() => ({
    subscribe: () => () => {},
    disconnect: async () => {},
    bindPlayer: p => { order.push('bind'); bound = p; return () => {} },
    connect: async () => { order.push('connect'); await bound.applySnapshot({ playing: true }) },
    enqueue: async () => assert.fail('entry must not change the room queue'),
  }), () => {})
  connection.bindPlayer(player, async () => true)
  await connection.run('https://music.example', adapter => adapter.connect())
  assert.deepEqual(order, ['bind', 'connect', 'playing'])
  await connection.dispose()
})

test('manual reconnect retains the bound adapter; service replacement retires and rebinds it', async () => {
  const calls = [], adapters = []
  const connection = new MusicPartyConnection(origin => {
    const adapter = {
      connect: async () => calls.push([origin, 'connect']),
      disconnect: async () => calls.push([origin, 'disconnect']),
      subscribe: () => () => calls.push([origin, 'unsubscribe']),
      bindPlayer: () => { calls.push([origin, 'bind']); return () => calls.push([origin, 'unbind']) },
    }
    adapters.push(adapter); return adapter
  }, () => {})
  await connection.run('https://a.example', a => a.connect())
  connection.bindPlayer({}, async () => true)
  await connection.run('https://a.example/', a => a.connect())
  assert.equal(adapters.length, 1)
  await connection.run('https://b.example', a => a.connect())
  assert.deepEqual(calls.slice(3), [
    ['https://a.example', 'unbind'], ['https://a.example', 'unsubscribe'], ['https://a.example', 'disconnect'],
    ['https://b.example', 'bind'], ['https://b.example', 'connect'],
  ])
  await connection.dispose()
  await assert.rejects(connection.run('https://b.example', a => a.connect()), /disposed/)
})
