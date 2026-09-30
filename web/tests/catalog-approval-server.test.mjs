import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes, scryptSync } from 'node:crypto'
import { approvalSettings, issueApproval } from '../lib/catalog-approval-server.ts'
import { openCatalogStore, structuralChanges, structuralCount } from '../../server/media/catalog-store.ts'

test('网页批准独立认证、只进不出、拒跨站/重定向、不向其它路由注入', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'approval-web-test-'))
  const previous = process.env.WATCHPARTY_APPROVAL_CONFIG_FILE
  const secret = randomBytes(24).toString('base64url')
  const password = randomBytes(24).toString('base64url')
  const salt = randomBytes(16)
  const file = path.join(root, 'approval.json')
  let calls = 0
  let redirect = false
  const server = createServer(async (req, res) => {
    calls++
    assert.equal(req.url, '/api/admin/media-libraries/lib_test/approval')
    assert.equal(req.method, 'POST')
    assert.ok(req.headers['x-watchparty-approval'] === secret, 'upstream header missing')
    assert.equal(req.headers.authorization, undefined)
    let text = ''
    for await (const chunk of req) text += chunk
    assert.equal(JSON.parse(text).approvedBy, '网页')
    res.writeHead(redirect ? 302 : 200, { 'Content-Type': 'application/json', ...(redirect ? { Location: 'http://127.0.0.1:1/leak' } : {}) })
    res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    process.env.WATCHPARTY_APPROVAL_CONFIG_FILE = file
    await writeFile(file, JSON.stringify({ backendOrigin: `http://127.0.0.1:${server.address().port}`, frontendOrigin: 'http://127.0.0.1:3011', username: 'human', passwordHash: `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`, secret }))
    const auth = 'Basic ' + Buffer.from(`human:${password}`).toString('base64')
    const request = (method = 'POST', headers = {}, body = {}) => new Request('http://localhost:3011/api/catalog-approval/settings', {
      method, headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3011', ...headers },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    })
    assert.equal((await issueApproval(request(), 'lib_test')).status, 401)
    assert.equal((await issueApproval(request('POST', { 'x-watchparty-admin': 'mcp-token', 'x-watchparty-approval': secret }), 'lib_test')).status, 401)
    assert.equal((await issueApproval(request('POST', { Authorization: 'Basic ' + Buffer.from('human:wrong').toString('base64') }), 'lib_test')).status, 401)
    assert.equal((await issueApproval(request('POST', { Authorization: auth, Origin: 'http://other.test' }), 'lib_test')).status, 403)
    assert.equal((await issueApproval(request('POST', { Authorization: auth, Origin: 'http://localhost:3011' }), 'lib_test')).status, 403, 'Request.url origin must not override configured frontendOrigin')
    assert.equal((await issueApproval(request('GET', { Authorization: auth }), 'lib_test')).status, 405)
    assert.equal(calls, 0)
    const readback = await approvalSettings(request('GET', { Authorization: auth }))
    assert.deepEqual(await readback.json(), { configured: true, mask: '••••••••' })
    assert.equal(readback.headers.get('cache-control'), 'no-store')
    assert.equal((await issueApproval(request('POST', { Authorization: auth }), '../scan')).status, 400)
    assert.equal((await issueApproval(request('POST', { Authorization: auth }), 'lib_test')).status, 200, 'configured frontendOrigin must work when Next Request.url has a different host')
    redirect = true
    assert.equal((await issueApproval(request('POST', { Authorization: auth }), 'lib_test')).status, 502)
    assert.equal(calls, 2)
    const replacement = randomBytes(24).toString('base64url')
    const saved = await approvalSettings(request('POST', { Authorization: auth }, { secret: replacement }))
    assert.equal(saved.status, 200)
    assert.ok(!(await saved.text()).includes(replacement), 'settings write leaked secret')
    assert.ok(JSON.parse(await readFile(file, 'utf8')).secret === replacement, 'settings did not persist replacement')
    assert.equal((await approvalSettings(request('POST', { Authorization: auth }, { secret: 'bad\r\nheader' }))).status, 400)
  } finally {
    if (previous === undefined) delete process.env.WATCHPARTY_APPROVAL_CONFIG_FILE
    else process.env.WATCHPARTY_APPROVAL_CONFIG_FILE = previous
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})

test('批准探针必须造出结构差，空草稿不能作为签发正例', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'approval-fixture-test-'))
  const store = openCatalogStore(':memory:', path.join(root, 'posters'))
  try {
    assert.equal(structuralCount(structuralChanges(store.draftDiff('fixture'))), 0)
    store.writeScan('fixture', [{ relativePath: '/Approval fixture/01.mkv', name: '01.mkv', mediaId: 'fixture-media' }])
    store.writeDraft('fixture', [{ itemKey: '/Approval fixture', query: 'Approval fixture', queries: ['Approval fixture'], rawName: 'Approval fixture', files: [{ relativePath: '/Approval fixture/01.mkv', name: '01.mkv', mediaId: 'fixture-media', season: null, episode: 1 }] }])
    const structural = structuralChanges(store.draftDiff('fixture'))
    assert.ok(structuralCount(structural) > 0, 'fixture must contain structural changes before approval')
    assert.equal(structural.added.length, 1)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
