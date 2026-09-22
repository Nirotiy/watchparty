import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import policy from '../electron/policy.cjs'

test('preload exposes only allowed commands and strips Electron event objects', async () => {
  let bridge, listener
  const calls = []
  const source = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8')
    .replace('/* COMMANDS */ []', JSON.stringify(policy.commands)).replace('/* EVENTS */ []', JSON.stringify(policy.events))
  vm.runInNewContext(source, { require(name) {
    assert.equal(name, 'electron')
    return { contextBridge: { exposeInMainWorld(_name, api) { bridge = api } }, ipcRenderer: {
      invoke: async (...args) => { calls.push(args); return { result: { status: 200 } } },
      on: (_event, fn) => { listener = fn }, removeListener: (_event, fn) => assert.equal(fn, listener),
    } }
  } })
  assert.equal(bridge.runtime, 'electron')
  await assert.rejects(bridge.invoke('readFile', {}), /invalid_desktop_command/)
  await assert.rejects(bridge.invoke('__shutdown', {}), /invalid_desktop_command/)
  await bridge.invoke('getDesktopSettings')
  assert.equal(calls[0][0], 'watchparty:request')
  const stop = bridge.listen('desktop://state', event => {
    assert.deepEqual(Object.keys(event), ['payload'])
    assert.equal(event.payload, 'safe')
  })
  listener({ sender: 'privileged' }, 'safe'); stop()
})
test('main policy rejects unknown commands, invalid args and oversized frames', () => {
  assert.equal(policy.validRequest('getDesktopSettings', {}), true)
  assert.equal(policy.validRequest('updateDesktopWindowChrome', { title: 'Banguru', theme: 'dark', windowMaterial: 'auto' }), true)
  assert.equal(policy.validRequest('updateDesktopWindowChrome', { title: 'Banguru', theme: 'dark', windowMaterial: 'mica' }), false)
  assert.equal(policy.validRequest('listAudioOutputDevices', {}), true)
  assert.equal(policy.validRequest('listAudioOutputDevices', { origin: 'http://127.0.0.1:18081' }), false)
  assert.equal(policy.validRequest('updateDesktopWindowChrome', { title: 'WatchParty', theme: 'dark', windowMaterial: 'auto' }), false)
  for (const args of [null, [], 'bad', { text: 'x'.repeat(1024 * 1024) }]) assert.equal(policy.validRequest('getDesktopSettings', args), false)
  assert.equal(policy.validRequest('__launch', {}), false)
})
