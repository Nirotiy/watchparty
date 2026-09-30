import assert from 'node:assert/strict'
import { test } from 'node:test'
import { refreshCatalog } from '../shared/catalog-refresh.ts'

test('已有 rev 的 202 必须等基线前进且 running false，POST 只发一次', async () => {
  const snapshots = [{ rev: 4, running: false }, { rev: 4, running: true }, { rev: 5, running: true }, { rev: 5, running: false }]
  let posts = 0
  const result = await refreshCatalog(async () => snapshots.shift(), async () => { posts++; return { status: 'accepted', running: true } },
    (current, before) => current.rev > before.rev, { wait: async () => {} })
  assert.equal(result.rev, 5)
  assert.equal(posts, 1)
  assert.equal(snapshots.length, 0)
})

test('后台结束而 rev 未变化必须失败，不能把旧结果报绿', async () => {
  await assert.rejects(refreshCatalog(async () => ({ rev: 4, running: false }), async () => ({ status: 'accepted' }),
    (current, before) => current.rev > before.rev), /结果未更新/)
})

test('POST 超时仍轮询，classify 必须看 classifiedAt 变化', async () => {
  const snapshots = [{ classifiedAt: 'before', running: false }, { classifiedAt: 'before', running: true }, { classifiedAt: 'after', running: false }]
  let posts = 0
  const result = await refreshCatalog(async () => snapshots.shift(), async () => { posts++; throw Object.assign(new Error('transport'), { code: 'NETWORK_ERROR' }) },
    (current, before) => current.classifiedAt !== before.classifiedAt, { wait: async () => {} })
  assert.equal(result.classifiedAt, 'after')
  assert.equal(posts, 1)
})

test('200 快路径仍读回核基线；404 不发 POST；running 不停必须超时', async () => {
  const snapshots = [{ rev: 4, running: false }, { rev: 5, running: false }]
  assert.equal((await refreshCatalog(async () => snapshots.shift(), async () => ({ status: 'done' }), (a, b) => a.rev > b.rev)).rev, 5)
  let posts = 0
  await assert.rejects(refreshCatalog(async () => { throw Object.assign(new Error('missing'), { status: 404 }) }, async () => { posts++ }, () => true), /missing/)
  assert.equal(posts, 0)
  let time = 0
  await assert.rejects(refreshCatalog(async () => ({ rev: 4, running: true }), async () => {}, (a, b) => a.rev > b.rev,
    { now: () => time, wait: async () => { time += 10 }, timeoutMs: 20 }), /超时/)
})
