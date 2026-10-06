import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
const js = ts.transpile(readFileSync(new URL('../shared/local-schema.ts', import.meta.url), 'utf8'), { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
const { createDefaultLocalSettings, saveMusicPartyService, serviceForProduct, migrateLocalSettings, musicPartyOriginError, linkleDisplayName, linkleMemberOf } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('A to B to A preserves both profiles and restores selected origin after reload', () => {
  let settings = createDefaultLocalSettings()
  for (const origin of ['https://a.example', 'https://b.example', 'https://a.example/']) settings = saveMusicPartyService(settings, origin)
  const restored = migrateLocalSettings(JSON.parse(JSON.stringify(settings)))
  assert.equal(restored.services.length, 2)
  assert.equal(serviceForProduct(restored, 'musicparty').origin, 'https://a.example')
})

test('legacy service identity and unrelated product settings survive saving', () => {
  const settings = { ...createDefaultLocalSettings(), services: [
    { id: 'musicparty-default', product: 'musicparty', origin: 'https://a.example', label: 'A' },
    { id: 'wp', product: 'watchparty', origin: 'https://video.example', label: 'Video' },
  ] }
  const next = saveMusicPartyService(settings, 'https://a.example/')
  assert.equal(next.activeServiceId, 'musicparty-default')
  assert.deepEqual(next.services, settings.services)
  for (const origin of ['file:///a', 'https://user:password@a.example', 'https://a.example/path', 'https://a.example?q=1']) {
    assert.throws(() => saveMusicPartyService(settings, origin))
  }
  assert.equal(settings.services.length, 2)
})

test('plaintext http is only accepted for the local demo server', () => {
  const settings = createDefaultLocalSettings()
  for (const origin of ['http://127.0.0.1:18380', 'http://localhost:18380', 'http://[::1]:18380', 'https://music.example.com']) {
    assert.equal(musicPartyOriginError(origin), undefined, origin)
  }
  for (const origin of ['http://music.example.com', 'http://192.168.1.20:18380', 'http://[::2]:18380']) {
    assert.match(musicPartyOriginError(origin), /https/, origin)
    assert.throws(() => saveMusicPartyService(settings, origin), /https/)
  }
  for (const origin of ['', 'not a url', 'ftp://a.example']) assert.ok(musicPartyOriginError(origin), origin)
  assert.equal(saveMusicPartyService(saveMusicPartyService(settings, 'http://127.0.0.1:18380'), 'http://localhost:18380').services.length, 2)
})

test('the name reported to the server prefers the local ID, then the host nickname', () => {
  // 用户 2026-09-25：自定义 ID 写进服务端（之后以服务端为基准）；没有本机 ID 时退回本机昵称，最后才是桌面默认。
  assert.equal(linkleDisplayName({ id: 'm-1', name: '小明' }), '小明')
  assert.equal(linkleDisplayName({ id: 'm-1', name: '  小明  ' }), '小明', '本机 ID 要 trim')
  assert.equal(linkleDisplayName({ id: 'm-1', name: '小明' }, '本机昵称'), '小明', '本机 ID 优先于本机昵称')
  assert.equal(linkleDisplayName(null, '本机昵称'), '本机昵称')
  assert.equal(linkleDisplayName(null, '   '), '桌面用户')
  assert.equal(linkleDisplayName(undefined, undefined), '桌面用户')
  assert.equal(linkleDisplayName({ id: '', name: '小明' }, '本机昵称'), '本机昵称', 'ID 不完整时不算有效身份')
  const settings = createDefaultLocalSettings()
  assert.equal(linkleMemberOf(settings), null)
  assert.equal(linkleDisplayName(linkleMemberOf(migrateLocalSettings({ ...settings, linkleMember: { id: 'm-9', name: '阿九' } }))), '阿九')
})
