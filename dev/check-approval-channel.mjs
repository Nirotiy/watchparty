// End-to-end checks against the disposable :8099 backend and :3011 Next routes. No credentials are printed.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { openCatalogStore, structuralChanges, structuralCount } from '../server/media/catalog-store.ts'

const root = path.join(os.tmpdir(), 'watchparty-approval-channel-0930')
const { username, password } = JSON.parse(await readFile(path.join(root, 'test-login.json'), 'utf8'))
const { secret } = JSON.parse(await readFile(path.join(root, 'web-approval.json'), 'utf8'))
const origin = 'http://127.0.0.1:3011'
const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
const post = (url, headers = {}, body = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) })
const caps = await (await fetch('http://127.0.0.1:8099/api/media/capabilities')).json()
assert.equal(caps.catalogApproval, 'secret')
assert.ok(!JSON.stringify(caps).includes(secret), 'capabilities leaked secret')
assert.equal((await post('http://127.0.0.1:8099/api/admin/media-libraries/lib_anime/approval')).status, 401)
const webRoute = `${origin}/api/catalog-approval/libraries/lib_anime/approval`
assert.equal((await post(webRoute)).status, 401)
assert.equal((await post(webRoute, { 'x-watchparty-admin': 'mcp-token' })).status, 401)
assert.equal((await post(webRoute, { Authorization: auth, Origin: 'http://other.test' })).status, 403)
const readback = await fetch(`${origin}/api/catalog-approval/settings`, { headers: { Authorization: auth } })
assert.equal(readback.status, 200)
assert.deepEqual(await readback.json(), { configured: true, mask: '••••••••' })
// The real-library clone has no structural changes. Create a dedicated fixture instead.
const envFile = await readFile('.env', 'utf8')
const envValue = name => envFile.split(/\r?\n/).find(line => line.startsWith(`${name}=`))?.slice(name.length + 1).trim() ?? ''
const sourceReply = await post('http://127.0.0.1:8099/api/admin/media-sources', {}, {
  name: 'Web approval isolated check', internalBaseUrl: 'http://127.0.0.1:5349', publicBaseUrl: 'http://127.0.0.1:5349',
  username: envValue('OPENLIST_USERNAME'), password: envValue('OPENLIST_PASSWORD'),
  libraries: [{ name: 'Web approval fixture', kind: 'anime', path: '/media/openlist-bdyun/Multimedia/Anime' }],
})
assert.equal(sourceReply.status, 201)
const source = await sourceReply.json()
const libraryId = source.libraries[0].id
try {
  const store = openCatalogStore(path.join(root, 'iso/data/watchparty-catalog.sqlite'), path.join(root, 'iso/data/poster-cache'))
  try {
    store.writeScan(libraryId, [{ relativePath: '/Approval fixture/01.mkv', name: '01.mkv', mediaId: 'fixture-media' }])
    store.writeDraft(libraryId, [{ itemKey: '/Approval fixture', query: 'Approval fixture', queries: ['Approval fixture'], rawName: 'Approval fixture', files: [{ relativePath: '/Approval fixture/01.mkv', name: '01.mkv', mediaId: 'fixture-media', season: null, episode: 1 }] }])
    const structural = structuralChanges(store.draftDiff(libraryId))
    assert.ok(structuralCount(structural) > 0, 'approval probe requires actual structural changes')
    assert.equal(structural.added.length, 1, 'approval fixture must add exactly one item')
  } finally { store.close() }
  const approved = await post(`${origin}/api/catalog-approval/libraries/${libraryId}/approval`, { Authorization: auth })
  assert.equal(approved.status, 200)
  const body = await approved.json()
  assert.ok(typeof body.approvalToken === 'string', 'web did not issue an approval')
  assert.equal((await post(`http://127.0.0.1:8099/api/admin/media-libraries/${libraryId}/approval/revoke`, {}, { approvalToken: body.approvalToken })).status, 200)
} finally {
  assert.equal((await fetch(`http://127.0.0.1:8099/api/admin/media-sources/${source.id}`, { method: 'DELETE' })).status, 204)
}
const environment = { ...process.env, WATCHPARTY_API_BASE: 'http://127.0.0.1:8099', NO_PROXY: '127.0.0.1,localhost,::1' }
delete environment.WATCHPARTY_CATALOG_APPROVAL_SECRET
delete environment.WATCHPARTY_APPROVAL_CONFIG_FILE
const messages = [
  { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'catalog_approval', arguments: { libraryId: 'lib_anime' } } },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'import_apply_approved', arguments: { libraryId: 'lib_anime', approvalToken: 'invalid-test-token' } } },
]
const child = spawn(process.execPath, ['server/mcp/catalog-mcp.ts'], { env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
let output = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => { output += chunk })
const timer = setTimeout(() => child.kill(), 15_000)
child.stdin.end(messages.map(message => JSON.stringify(message)).join('\n') + '\n')
await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('MCP check process failed'))) }).finally(() => clearTimeout(timer))
assert.ok(!output.includes(secret), 'MCP output leaked secret')
const answers = output.trim().split('\n').map(line => JSON.parse(line))
assert.ok(answers[0].result.tools.every(tool => !/approval$/.test(tool.name)), 'MCP exposes approval signing')
assert.ok(answers[1].error || answers[1].result?.isError, 'MCP signing call unexpectedly succeeded')
assert.ok(answers[2].result?.isError, 'MCP applied without an approval')
console.log('APPROVAL_CHANNEL_CHECK_OK ' + JSON.stringify({ mode: caps.catalogApproval, backendWithoutHeader: 401, webWithoutHumanAuth: 401, webMcpAdminOnly: 401, crossOrigin: 403, maskedReadback: true, webApproval: 200, mcpSigning: 'denied', mcpApplyWithoutApproval: 'denied' }))
