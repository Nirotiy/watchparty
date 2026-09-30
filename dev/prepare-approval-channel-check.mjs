// Creates credentials for a disposable isolated backend and Next instance; prints paths only.
import { randomBytes, scryptSync } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = path.join(os.tmpdir(), 'watchparty-approval-channel-0930')
await mkdir(root, { recursive: true })
const secret = randomBytes(32).toString('base64url')
const password = randomBytes(32).toString('base64url')
const salt = randomBytes(16)
await writeFile(path.join(root, 'backend.env'), `WATCHPARTY_CATALOG_APPROVAL_SECRET=${secret}\n`, { mode: 0o600, flag: 'wx' })
await writeFile(path.join(root, 'web-approval.json'), JSON.stringify({ backendOrigin: 'http://127.0.0.1:8099', frontendOrigin: 'http://127.0.0.1:3011', username: 'isolated-approval-admin', passwordHash: `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`, secret }), { mode: 0o600, flag: 'wx' })
await writeFile(path.join(root, 'test-login.json'), JSON.stringify({ username: 'isolated-approval-admin', password }), { mode: 0o600, flag: 'wx' })
console.log(`APPROVAL_CHECK_PREPARED ${root}`)
