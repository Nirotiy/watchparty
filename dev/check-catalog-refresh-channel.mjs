// Real async backend + frontend polling helper, with a fake OpenList and memory databases.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createBackend } from '../server/app.ts'
import { loadConfig } from '../server/config.ts'
import { WATCHPARTY_ROOTS } from '../server/media/watchparty-media.ts'
import { refreshCatalog } from '../desktop-shell/shared/catalog-refresh.ts'

const directory = await mkdtemp(path.join(os.tmpdir(), 'catalog-refresh-channel-'))
let fail = false
const list = async dir => {
  await new Promise(resolve => setTimeout(resolve, 60))
  if (fail) throw new Error('controlled enumeration failure')
  return { code: 200, data: { content: dir === WATCHPARTY_ROOTS.Anime
    ? [{ name: 'Fixture Show', is_dir: true, size: 0 }]
    : [{ name: 'Fixture Show - 01.mkv', is_dir: false, size: 10 }] } }
}
const backend = createBackend({ host: '127.0.0.1', port: 0, pruneIntervalMs: 0, serveStatic: false,
  config: loadConfig({ NODE_ENV: 'test', OPENLIST_PASSWORD: 'fixture-only' }), libraryDbPath: ':memory:', catalogDbPath: ':memory:',
  posterDir: directory, catalogSidecarDir: path.join(directory, 'sidecars'), syncGraceMs: 1,
  libraryClientFactory: () => ({ list, listShallow: list, ping: async () => ({ ok: true }), search: async () => ({ code: 200, data: { content: [] } }),
    getDownloadInfo: async () => { throw new Error('unexpected download') }, getLinkInfo: async () => null, fetchOriginText: async () => undefined }),
})
try {
  await backend.start()
  const base = `http://127.0.0.1:${backend.port}/api/admin/media-libraries/lib_anime`
  const read = async suffix => {
    const response = await fetch(`${base}/${suffix}`)
    assert.equal(response.status, 200)
    return response.json()
  }
  let posts = 0
  const statuses = []
  const post = async suffix => {
    posts++
    const response = await fetch(`${base}/${suffix}`, { method: 'POST' })
    statuses.push(response.status)
    assert.ok(response.ok)
    return response.json()
  }
  const options = { wait: () => new Promise(resolve => setTimeout(resolve, 10)), timeoutMs: 5000 }
  const scan = () => refreshCatalog(() => read('scan'), () => post('scan'), (current, before) => current.rev > before.rev, options)
  const first = await scan()
  assert.equal(first.rev, 1)
  const second = await scan()
  assert.equal(second.rev, 2)
  assert.equal(second.running, false)
  assert.equal(posts, 2)
  assert.deepEqual(statuses, [202, 202])
  const before = await read('classify')
  const classified = await refreshCatalog(() => read('classify'), () => post('classify'), (current, previous) => current.classifiedAt !== null && current.classifiedAt !== previous.classifiedAt, options)
  assert.ok(classified.classifiedAt !== before.classifiedAt)
  fail = true
  await assert.rejects(scan(), error => error.code === 'CATALOG_REFRESH_NOT_LANDED')
  assert.equal(posts, 4)
  assert.equal((await read('scan')).rev, 2)
  console.log('CATALOG_REFRESH_CHANNEL_OK ' + JSON.stringify({ existingRev: '1->2', scanStatuses: statuses.slice(0, 2), stoppedFailure: 'rejected', classifyAdvanced: true, duplicatePosts: 0 }))
} finally { await backend.close(); await rm(directory, { recursive: true, force: true }) }
