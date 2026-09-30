// Provision a Next-only administrator file. Never place these values in shell/session environment.
import { emitKeypressEvents } from 'node:readline'
import { randomBytes, scryptSync } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const args = process.argv.slice(2)
const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const target = path.resolve(option('file') ?? 'web/data/catalog-approval.json')
const username = option('username')
const backendOrigin = option('origin')
const frontendOrigin = option('web-origin')
if (!username || username.includes(':') || !backendOrigin || !frontendOrigin || !process.stdin.isTTY) {
  console.error('Use an interactive terminal: node dev/configure-web-approval.mjs --username=<admin> --origin=<backend-origin> --web-origin=<web-origin> [--file=<server-file>]')
  process.exit(1)
}
let validOrigins = false
try {
  validOrigins = [backendOrigin, frontendOrigin].every(address => {
    const origin = new URL(address)
    return origin.origin === address && !origin.username && !origin.password && (origin.protocol === 'https:' || (origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))
  })
} catch {}
if (!validOrigins) {
  console.error('Invalid backend origin')
  process.exit(1)
}
emitKeypressEvents(process.stdin)
async function hidden(prompt) {
  process.stdout.write(prompt)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  try {
    return await new Promise((resolve, reject) => {
      let value = ''
      const keypress = (text, key) => {
        if (key?.ctrl && key.name === 'c') { process.stdin.off('keypress', keypress); reject(new Error('cancelled')); return }
        if (key?.name === 'return') { process.stdin.off('keypress', keypress); resolve(value); return }
        if (key?.name === 'backspace') value = value.slice(0, -1)
        else if (text && !key?.ctrl && !/[\r\n\x00-\x1f\x7f]/.test(text)) value += text
      }
      process.stdin.on('keypress', keypress)
    })
  } finally { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n') }
}
try {
  const password = await hidden('Approval administrator password (hidden): ')
  const repeated = await hidden('Repeat password (hidden): ')
  if (password.length < 12 || password !== repeated) throw new Error('invalid input')
  const secret = await hidden('Backend approval secret (hidden; blank to configure later): ')
  if (secret && !/^[\x21-\x7e]{1,4096}$/.test(secret)) throw new Error('invalid input')
  const salt = randomBytes(16)
  const passwordHash = `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`
  await mkdir(path.dirname(target), { recursive: true })
  // Refuse to overwrite an existing administrator identity.
  await writeFile(target, JSON.stringify({ backendOrigin, frontendOrigin, username, passwordHash, secret }), { flag: 'wx', mode: 0o600 })
  console.log('Approval administrator file created; secret values were not printed.')
} catch {
  console.error('Provisioning failed or cancelled. Check input and whether the target already exists.')
  process.exitCode = 1
}
