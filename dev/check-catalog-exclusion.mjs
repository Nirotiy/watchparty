// Disposable secret fixture only. Never reads the real approval secret or writes the live catalog.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('temp-html/exclusion-iso-0930')
const origin = 'http://127.0.0.1:8099'
const secret = randomBytes(32).toString('base64url')
function databaseSummary(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    db.exec('BEGIN')
    const scan = db.prepare('SELECT library_id, COUNT(*) files, MAX(rev) rev FROM catalog_scan GROUP BY library_id ORDER BY library_id').all()
    const approvals = db.prepare('SELECT COUNT(*) n FROM catalog_approvals').get().n
    const cards = db.prepare('SELECT id, item_key, title, status, subtitle FROM catalog_items ORDER BY id').all()
    const children = db.prepare('SELECT item_id, media_id, rel_path, episode FROM catalog_children ORDER BY item_id, media_id').all()
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check
    db.exec('COMMIT')
    return { scan, approvals, integrity, digest: createHash('sha256').update(JSON.stringify({ scan, approvals, cards, children })).digest('hex') }
  } finally { db.close() }
}
const liveBefore = databaseSummary('data/watchparty-catalog.sqlite')
const copyBefore = databaseSummary(path.join(root, 'data/watchparty-catalog.sqlite'))
assert.equal(copyBefore.integrity, 'ok')
await writeFile(path.join(root, 'MANIFEST.txt'), `VACUUM INTO snapshot created by iso-catalog-instance.mjs\nBefore validation integrity_check=${copyBefore.integrity}\nLive baseline=${JSON.stringify(liveBefore)}\nCopy baseline=${JSON.stringify(copyBefore)}\n`)
const environment = { ...process.env, WATCHPARTY_CATALOG_APPROVAL_SECRET: secret, NO_PROXY: '127.0.0.1,localhost,::1', NODE_USE_ENV_PROXY: '1' }
delete environment.WATCHPARTY_APPROVAL_CONFIG_FILE
const child = spawn(process.execPath, ['dev/iso-catalog-instance.mjs', '--port=8099', `--root=${root}`], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let ready = false
child.stdout.on('data', chunk => { if (chunk.toString().includes('ISO_LISTENING')) ready = true })
child.stderr.resume()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function read(route) {
  const reply = await fetch(origin + route)
  assert.equal(reply.status, 200, 'read endpoint failed')
  return reply.json()
}
async function post(action, body = {}, approval = false) {
  const reply = await fetch(`${origin}/api/admin/media-libraries/lib_anime/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(approval ? { 'x-watchparty-approval': secret } : {}) }, body: JSON.stringify(body) })
  const data = await reply.json()
  assert.ok(reply.status === 200 || reply.status === 202, `${action} failed with HTTP ${reply.status}, code=${data.code ?? 'unknown'}`)
  return data
}
async function classify() {
  const before = await read('/api/admin/media-libraries/lib_anime/classify')
  await post('classify')
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await read('/api/admin/media-libraries/lib_anime/classify')
    if (!state.running && state.classifiedAt !== before.classifiedAt) return state
    await sleep(500)
  }
  throw new Error('classification did not advance')
}
async function apply() {
  const approval = await post('approval', { approvedBy: 'isolated-exclusion-fixture' }, true)
  assert.ok(typeof approval.approvalToken === 'string', 'fixture approval missing')
  return post('apply-approved', { approvalToken: approval.approvalToken, force: true })
}
try {
  for (let attempt = 0; !ready && attempt < 60; attempt++) {
    assert.equal(child.exitCode, null, 'isolated backend exited before readiness')
    await sleep(250)
  }
  assert.ok(ready, 'isolated backend readiness timeout')
  const caps = await read('/api/media/capabilities')
  assert.equal(caps.catalogApproval, 'secret')
  const denied = await fetch(`${origin}/api/admin/media-libraries/lib_anime/approval`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(denied.status, 401)
  const before = await read('/api/media/catalog/cat_BUbkFRqMH7w6')
  assert.equal(before.children.length, 54, 'sample must start with the known 54 files')
  const extras = before.children.filter(child => child.episode === null)
  assert.equal(extras.length, 4)
  const paths = extras.map(child => `${child.relDir}/${child.name}`)
  const scanBefore = await read('/api/admin/media-libraries/lib_anime/scan')
  await post('draft/exclude', { paths, reason: 'TV 卡混入剧场版与 SP，隔离验收' })
  const reduced = await classify()
  const drift = reduced.diff.confirmedDrift.find(row => row.id === before.id)
  assert.ok(drift, 'sample must appear in confirmed drift')
  assert.deepEqual(drift.files, { from: 54, to: 50 })
  const rejectedApply = await fetch(`${origin}/api/admin/media-libraries/lib_anime/apply?force=1`, { method: 'POST' })
  assert.equal(rejectedApply.status, 409)
  assert.equal((await rejectedApply.json()).code, 'CATALOG_APPROVAL_REQUIRED')
  assert.equal((await read('/api/media/catalog/cat_BUbkFRqMH7w6')).children.length, 54, 'intent cannot modify formal card')
  const reducedApply = await apply()
  const fifty = await read('/api/media/catalog/cat_BUbkFRqMH7w6')
  assert.equal(fifty.children.length, 50)
  assert.equal(fifty.children.filter(child => child.episode === null).length, 0)
  assert.ok(fifty.subtitle?.includes('50'), 'subtitle must reflect active files')
  assert.equal(fifty.externalId, before.externalId)
  const marked = await read('/api/admin/media-libraries/lib_anime/exclusions')
  assert.equal(marked.excluded, 4)
  await post('draft/unexclude', { paths })
  await classify()
  const restoredApply = await apply()
  const restored = await read('/api/media/catalog/cat_BUbkFRqMH7w6')
  assert.equal(restored.children.length, 54)
  assert.equal(restored.children.filter(child => child.episode === null).length, 4)
  assert.equal(restored.subtitle, before.subtitle)
  const scanAfter = await read('/api/admin/media-libraries/lib_anime/scan')
  assert.equal(scanAfter.rev, scanBefore.rev, 'restore must not require rescan')
  assert.equal(scanAfter.files, scanBefore.files)
  assert.equal(scanAfter.excluded, 0)
  const liveAfter = databaseSummary('data/watchparty-catalog.sqlite')
  assert.deepEqual(liveAfter, liveBefore, 'live catalog changed during isolated check')
  const copyAfter = databaseSummary(path.join(root, 'data/watchparty-catalog.sqlite'))
  assert.equal(copyAfter.integrity, 'ok')
  await writeFile(path.join(root, 'MANIFEST.txt'), `VACUUM INTO snapshot created by iso-catalog-instance.mjs\nBefore validation integrity_check=${copyBefore.integrity}\nAfter validation integrity_check=${copyAfter.integrity}\nLive unchanged=${JSON.stringify(liveAfter)}\nCopy before=${JSON.stringify(copyBefore)}\nCopy after=${JSON.stringify(copyAfter)}\nValidation copy is not a production rollback backup.\n`)
  console.log(JSON.stringify({ check: 'CATALOG_EXCLUSION_SAMPLE_OK', sample: before.title, files: [54, 50, 54], episodes: [50, 50, 50], subtitles: [before.subtitle, fifty.subtitle, restored.subtitle], scanRev: scanAfter.rev, scanFiles: scanAfter.files, excluded: [4, 0], noHeader: 401, noApprovalApply: 409, realUnchanged: true, copyApprovalsAdded: copyAfter.approvals - copyBefore.approvals, applyIds: [reducedApply.approvalId, restoredApply.approvalId], integrity: copyAfter.integrity }))
} finally {
  child.kill('SIGTERM')
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve) })
}
