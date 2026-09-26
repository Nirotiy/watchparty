import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { readFile } from 'node:fs/promises'

const js = ts.transpile(await readFile(new URL('../shared/local-schema.ts', import.meta.url), 'utf8'), { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
const { linkleIdentity, linkleMemberOf, migrateLocalSettings, createDefaultLocalSettings } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('本机身份：启动时指定的本地 ID 优先，没指定才用服务端账号', () => {
  const account = { publicId: 'acc-1', displayName: '桌面用户' }
  assert.deepEqual(linkleIdentity({ id: 'desk-02', name: '阿岚的台式机' }, account), { id: 'desk-02', name: '阿岚的台式机', source: 'local' })
  assert.deepEqual(linkleIdentity(null, account), { id: 'acc-1', name: '桌面用户', source: 'server' })
  // 服务端没给显示名时回落 publicId，不留空名字
  assert.deepEqual(linkleIdentity(null, { publicId: 'acc-2', displayName: '' }), { id: 'acc-2', name: 'acc-2', source: 'server' })
  // 两边都没有就是没有身份：界面不猜
  assert.equal(linkleIdentity(null, null), null)
  // 半截的本地身份（名字只有空白）当作没指定，回落服务端
  assert.deepEqual(linkleIdentity({ id: 'x', name: '   ' }, account), { id: 'acc-1', name: '桌面用户', source: 'server' })
})

test('本机身份：坏值不炸，迁移保留合法值、丢弃坏值', () => {
  const base = createDefaultLocalSettings()
  assert.deepEqual(linkleMemberOf({ ...base, linkleMember: { id: 'a', name: 'b' } }), { id: 'a', name: 'b' })
  assert.equal(linkleMemberOf({ ...base, linkleMember: { id: 42, name: 'b' } }), null)
  assert.equal(linkleMemberOf({ ...base, linkleMember: { id: '  ', name: 'b' } }), null)
  assert.equal(linkleMemberOf({ ...base, linkleMember: null }), null)
  assert.deepEqual(migrateLocalSettings({ ...base, linkleMember: { id: 'desk-02', name: '阿岚的台式机' } }).linkleMember, { id: 'desk-02', name: '阿岚的台式机' })
  assert.equal(migrateLocalSettings({ ...base, linkleMember: { id: '', name: '' } }).linkleMember, undefined)
})
