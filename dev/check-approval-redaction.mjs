// Search only this task's logs and public bundles. Never print the match or credential value.
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const temp = os.tmpdir()
const root = path.join(temp, 'watchparty-approval-channel-0930')
const { secret } = JSON.parse(await readFile(path.join(root, 'web-approval.json'), 'utf8'))
const { password } = JSON.parse(await readFile(path.join(root, 'test-login.json'), 'utf8'))
let files = 0
async function check(file) {
  const bytes = await readFile(file)
  assert.ok(!bytes.includes(Buffer.from(secret)) && !bytes.includes(Buffer.from(password)), 'credential appeared in a log or public bundle')
  files++
}
async function tree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) await tree(file)
    else if (/\.(js|css|html|json)$/.test(entry.name)) await check(file)
  }
}
await tree('desktop-shell/dist-electron')
await tree('web/.next/static')
for (const name of ['backend.log', 'backend-error.log']) await check(path.join(root, name))
for (const name of ['watchparty-approval-media-round1.log', 'watchparty-approval-media-round2.log', 'watchparty-approval-media-round3.log', 'watchparty-approval-media-round4.log']) await check(path.join(temp, name))
assert.ok(process.env.WATCHPARTY_CATALOG_APPROVAL_SECRET !== secret, 'test approval secret escaped the backend environment')
console.log(`APPROVAL_REDACTION_CHECK_OK files=${files} credentials-in-logs-or-public-bundles=0`)
