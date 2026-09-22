import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
const js = ts.transpile(readFileSync(new URL('../shared/local-schema.ts', import.meta.url), 'utf8'), { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
const { createDefaultLocalSettings, saveMusicPartyService, serviceForProduct, migrateLocalSettings } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

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
