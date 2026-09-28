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

test('saveTextFile takes name/extension/text only — the renderer never picks a path', () => {
  assert.equal(policy.validRequest('saveTextFile', { suggestedName: 'Linkle 队列 2026-09-25', extension: 'csv', text: 'a,b\n' }), true)
  // 路径、多出来的键、非法后缀、超长正文、含路径分隔符的名字都必须被拒。
  assert.equal(policy.validRequest('saveTextFile', { suggestedName: 'x', extension: 'txt', text: '', path: 'C:/Windows/System32/x.txt' }), false)
  assert.equal(policy.validRequest('saveTextFile', { suggestedName: 'x', extension: 'exe', text: '' }), false)
  assert.equal(policy.validRequest('saveTextFile', { suggestedName: '../escape', extension: 'txt', text: '' }), false)
  assert.equal(policy.validRequest('saveTextFile', { suggestedName: 'a/b', extension: 'txt', text: '' }), false)
  assert.equal(policy.validRequest('saveTextFile', { suggestedName: '', extension: 'txt', text: '' }), false)
  assert.equal(policy.validRequest('saveTextFile', { suggestedName: 'x'.repeat(200), extension: 'txt', text: '' }), false)
  assert.equal(policy.validRequest('saveTextFile', { suggestedName: 'x', extension: 'txt', text: 'y'.repeat(4 * 1024 * 1024 + 1) }), false)
})

test('mediaRequest take a whitelisted shape and nothing else', () => {
  const call = (method, path, query = null, body = null) => policy.validRequest('mediaRequest', { method, path, query, body })
  assert.equal(call('GET', '/api/media/capabilities'), true)
  assert.equal(call('GET', '/api/media/list', 'libraryId=lib_anime&path=%2F'), true)
  assert.equal(call('POST', '/api/admin/media-sources', null, { name: 'Second' }), true)
  assert.equal(call('PATCH', '/api/admin/media-sources/7', null, { password: '' }), true)
  assert.equal(call('DELETE', '/api/admin/media-sources/7'), true)
  // 动词、路径前缀、长度与正文形状都要挡住（权威白名单在 Rust 侧，这里是第一道）。
  for (const [method, path] of [['PUT', '/api/media/list'], ['HEAD', '/api/media/list'], ['GET', 'api/media/list'], ['GET', '/media/list'], ['GET', '/api/media/' + 'x'.repeat(600)]]) {
    assert.equal(call(method, path), false, `${method} ${path}`)
  }
  assert.equal(call('GET', '/api/media/list', 'q=' + 'x'.repeat(3000)), false)
  assert.equal(call('GET', '/api/media/list', null, ['array']), false)
  assert.equal(policy.validRequest('mediaRequest', { method: 'GET', path: '/api/media/list' }), false)
  assert.equal(policy.validRequest('mediaRequest', { method: 'GET', path: '/api/media/list', query: null, body: null, extra: 1 }), false)
})

test('mediaImage takes a known kind and one opaque id', () => {
  assert.equal(policy.validRequest('mediaImage', { kind: 'media', id: 'v2.c3JjX2RlZmF1bHQ.signature' }), true)
  assert.equal(policy.validRequest('mediaImage', { kind: 'poster', id: 'cat_menMrsMfZBlr' }), true)
  for (const args of [
    {},
    { kind: 'media' },
    { id: 'cat_1' },
    { kind: 'catalog', id: 'cat_1' },
    { kind: 'posters', id: 'cat_1' },
    { kind: 'media', id: '' },
    { kind: 'media', id: 'v'.repeat(513) },
    { kind: 'media', id: 7 },
    { kind: 'media', id: 'cat_1', extra: 1 },
    { kind: 'media', id: 'cat_1', path: '/api/media/posters/cat_1' },
  ]) {
    assert.equal(policy.validRequest('mediaImage', args), false, JSON.stringify(args))
  }
})

test('main policy confines plaintext http to loopback for every MusicParty origin', () => {
  const request = origin => policy.validRequest('musicPartyRequest', { input: { origin, path: '/api/desktop/v1/health', method: 'GET', body: null, clientVersion: '0.2.0' } })
  for (const origin of ['http://127.0.0.1:18081', 'http://localhost:18081', 'http://[::1]:18081', 'https://music.example.com']) assert.equal(request(origin), true, origin)
  for (const origin of ['http://music.example.com', 'http://192.168.1.20:18081', 'http://LOCALHOST.attacker.example', '127.0.0.1:18081', 'file:///etc/passwd', null]) assert.equal(request(origin), false, String(origin))
  assert.equal(policy.validRequest('musicPartyRequest', { input: { path: '/api/desktop/v1/health' } }), false)
  assert.equal(policy.validRequest('musicPartyWsConnect', { input: { origin: 'https://music.example', roomId: 'lounge', clientVersion: '0.2.0' } }), true)
  assert.equal(policy.validRequest('musicPartyWsConnect', { input: { origin: 'http://192.168.1.20:18081', roomId: 'lounge', clientVersion: '0.2.0' } }), false)
  assert.equal(policy.validRequest('clearMusicPartySession', { origin: 'https://music.example' }), true)
  assert.equal(policy.validRequest('clearMusicPartySession', { origin: 'http://10.0.0.5:18081' }), false)
})
