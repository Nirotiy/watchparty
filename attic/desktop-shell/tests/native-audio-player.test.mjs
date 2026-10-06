import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
const source = readFileSync(new URL('../shared/native-audio-player.ts', import.meta.url), 'utf8')
const js = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
const { NativeAudioPlayer } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const item = { id: 'local:song', title: 'Fixture', kind: 'audio', source: 'local' }

test('empty snapshot from before load cannot stop the newly loaded track', async () => {
  const calls = []
  const player = new NativeAudioPlayer(async (_, args) => calls.push(args.input.command))
  await player.applySnapshot({ item: null, playing: false, positionSeconds: 0 })
  await player.load(item, 'https://music.example/song')
  await player.applySnapshot({ item, playing: true, positionSeconds: 2 })
  assert.deepEqual(calls.map(c => [c.action, c.itemId]), [['load', item.id], ['snapshot', item.id]])
})

test('snapshot arriving during load remains authoritative, including an empty room', async () => {
  for (const nextItem of [item, null]) {
    const calls = []; let finish
    const player = new NativeAudioPlayer(async (_, args) => {
      calls.push(args.input.command)
      if (args.input.command.action === 'load') await new Promise(resolve => { finish = resolve })
    })
    const loading = player.load(item, 'https://music.example/song')
    await Promise.resolve()
    await player.applySnapshot({ item: nextItem, playing: Boolean(nextItem), positionSeconds: 7 })
    finish(); await loading
    assert.equal(calls[1].itemId, nextItem?.id ?? null)
    assert.equal(calls[1].position, 7)
  }
})

test('stop during load prevents its completion from reviving snapshot delivery', async () => {
  const calls = []; let finish
  const player = new NativeAudioPlayer(async (_, args) => {
    calls.push(args.input.command.action)
    if (args.input.command.action === 'load') await new Promise(resolve => { finish = resolve })
  })
  const loading = player.load(item, 'https://music.example/song')
  await Promise.resolve()
  const stopping = player.stop()
  finish(); await Promise.all([loading, stopping])
  await player.applySnapshot({ item, playing: true, positionSeconds: 4 })
  assert.deepEqual(calls, ['load', 'stop'])
})

test('native load settles before resume and snapshot includes the seek position', async () => {
  const calls = []
  let loaded
  const player = new NativeAudioPlayer(async (name, args) => {
    assert.equal(name, 'musicPartyAudio')
    calls.push(args.input)
    if (args.input.command.action === 'load') await new Promise(resolve => { loaded = resolve })
  })
  const loading = player.load(item, 'https://music.example/song')
  const playing = player.resume()
  await Promise.resolve()
  assert.equal(calls.length, 1)
  loaded()
  await Promise.all([loading, playing])
  await player.applySnapshot({ item, positionSeconds: 12.5, playing: false, revision: 3 })
  assert.deepEqual(calls.map(c => c.command), [
    { action: 'load', url: 'https://music.example/song', itemId: item.id },
    { action: 'resume' }, { action: 'snapshot', itemId: item.id, position: 12.5, playing: false },
  ])
  assert.ok(calls.every(c => c.playerId === player.id))
  assert.equal(player.kind, 'libmpv')
})

test('load failures propagate, retry works, and disposal is terminal and idempotent', async () => {
  const calls = []
  let fail = true
  const player = new NativeAudioPlayer(async (_, args) => {
    calls.push(args.input.command.action)
    if (fail) { fail = false; throw new Error('musicparty_playback_failed') }
  })
  await assert.rejects(player.load(item, 'https://music.example/bad'), /playback_failed/)
  await player.load(item, 'https://music.example/good')
  await player.setAudioFocus(false)
  await player.dispose()
  await player.dispose()
  await assert.rejects(player.resume(), /player_disposed/)
  assert.deepEqual(calls, ['load', 'load', 'focus', 'dispose'])
})

test('empty-room focus waits until a track is loaded', async () => {
  const calls = []
  const player = new NativeAudioPlayer(async (_, args) => {
    const action = args.input.command.action
    if (action === 'focus' && !calls.includes('load')) throw new Error('musicparty_player_not_active')
    calls.push(action)
  })
  await player.setAudioFocus(true)
  assert.deepEqual(calls, [])
  await player.load(item, 'https://music.example/song')
  await player.setAudioFocus(true)
  assert.deepEqual(calls, ['load', 'focus'])
})
