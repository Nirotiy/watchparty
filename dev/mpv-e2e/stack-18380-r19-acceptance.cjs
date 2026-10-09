// Live-stack (18380) acceptance for R18 + R19 using only a throwaway guest session: no admin
// credentials, no .env, and no cookie/invite value is ever printed. Proves the deployed image
// carries the derived `isAdmin`, refuses guest room creation with a code, keeps CSRF and the
// desktop version gate in front of it, and still lets a guest listen and reach management verbs.
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const { createRequire } = require('node:module')
const path = require('node:path')
const assert = require('node:assert/strict')

const repoRoot = path.resolve(__dirname, '../..')
const requireFromRoot = createRequire(path.join(repoRoot, 'package.json'))
const { WebSocket } = requireFromRoot('ws')

const origin = process.env.LINKLE_STACK_ORIGIN ?? 'http://127.0.0.1:18380'
const results = []
const check = (label, detail) => { results.push({ check: label, ...detail }); console.log(JSON.stringify({ check: label, ...detail })) }

async function call(method, urlPath, { cookie = '', csrf = '', body, desktop = false } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookie) headers.Cookie = cookie
  if (csrf) headers['X-CSRF-Token'] = csrf
  if (desktop) { headers['X-Desktop-API-Version'] = '2026-01'; headers['X-Desktop-Client-Version'] = '0.2.0' }
  const response = await fetch(origin + urlPath, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
  const value = await response.json().catch(() => null)
  return { status: response.status, value, cookieHeader: response.headers.getSetCookie().map(entry => entry.split(';')[0]).join('; ') }
}

async function main() {
  // 1. What the deployed build advertises is the only proof a feature is in it: desktopGuard
  // answers 403 for unknown paths too, so status codes prove nothing.
  const capabilities = await call('GET', '/api/desktop/v1/capabilities', { desktop: true })
  assert.equal(capabilities.status, 200)
  check('stack-capabilities', {
    apiVersion: capabilities.value.apiVersion, serverVersion: capabilities.value.serverVersion,
    roomCreate: capabilities.value.features?.roomCreate === true, roomManage: capabilities.value.features?.roomManage === true,
  })
  assert.equal(capabilities.value.features.roomCreate, true, 'the desktop create endpoint must still be advertised')
  assert.equal(capabilities.value.features.roomManage, true, 'the R16 build must be in this image')

  // 2. A guest session is free to mint (CSRF-exempt exact path) and is the only identity used here.
  const guest = await call('POST', '/api/account/guest', { body: { displayName: 'r19 探针' } })
  assert.equal(guest.status, 200, 'guest session must still be obtainable')
  const cookie = guest.cookieHeader
  const csrf = /MP_CSRF=([^;]+)/.exec(cookie)?.[1] ?? ''
  assert.ok(csrf.length > 0, 'the guest session must carry a CSRF pair value')

  // 3. R18: /api/account/me publishes the derived boolean, and it agrees with role for a guest.
  const me = await call('GET', '/api/account/me', { cookie })
  assert.equal(me.status, 200)
  check('stack-account-me-shape', { keys: Object.keys(me.value ?? {}).sort().join(','), role: me.value?.role, guest: me.value?.guest === true, isAdminPresent: 'isAdmin' in (me.value ?? {}), isAdmin: me.value?.isAdmin })
  assert.equal(me.value.isAdmin, false, 'a guest must read as a non-admin through the server-published boolean')

  // 4. R19: the create endpoint refuses this session with a code instead of prose.
  const roomName = `r19-guest-${Date.now()}`
  const refused = await call('POST', '/api/desktop/v1/rooms', { cookie, csrf, body: { name: roomName }, desktop: true })
  assert.equal(refused.status, 403, `a guest must be refused, got ${refused.status}`)
  assert.equal(refused.value?.code, 'guest-not-allowed')
  check('stack-guest-create-refused', { status: refused.status, code: refused.value?.code, message: refused.value?.message })

  // 5. Gate order is untouched: the version check still runs before the account check, and the
  // CSRF double submit still runs before both.
  const noVersion = await call('POST', '/api/desktop/v1/rooms', { cookie, csrf, body: { name: roomName } })
  assert.equal(noVersion.status, 426, `the version gate must still answer first, got ${noVersion.status}`)
  const noCsrf = await call('POST', '/api/desktop/v1/rooms', { cookie, body: { name: roomName }, desktop: true })
  assert.equal(noCsrf.status, 403)
  assert.equal(JSON.stringify(noCsrf.value ?? {}).includes('guest-not-allowed'), false, 'CSRF must refuse before the account is even read')
  check('stack-gate-order', { withoutVersionHeader: noVersion.status, withoutCsrfHeader: noCsrf.status, csrfBodyCarriedGuestCode: false })

  // 6. Anonymous still gets the 401 with its code, and the refused attempts left nothing behind.
  // The CSRF pair is a synthetic double submit (cookie == header), which is all the middleware
  // compares; without it the refusal is a 403 from CSRF and the account is never read.
  const anonymous = await call('POST', '/api/desktop/v1/rooms', { cookie: 'MP_CSRF=r19-anon', csrf: 'r19-anon', body: { name: roomName }, desktop: true })
  assert.equal(anonymous.status, 401, `an anonymous create with a CSRF pair must reach the account check, got ${anonymous.status}`)
  assert.equal(anonymous.value?.code, 'unauthorized')
  const listed = await call('GET', '/api/rooms')
  assert.equal(listed.status, 200, 'the public room list must stay readable without a session')
  assert.equal((listed.value ?? []).some(item => item.name === roomName), false, 'a refused create must leave no room behind')
  check('stack-anonymous-and-list', { anonymous: anonymous.status, anonymousCode: anonymous.value?.code, roomsListed: (listed.value ?? []).length, leakedRoom: false })

  // 7. The tightening is scoped to creation: a guest still reaches the management verb (and is
  // refused there for a different reason — the system room is never editable), and still listens.
  const systemRoom = await call('PUT', '/api/rooms/lounge', { cookie, csrf, body: { name: 'r19-hijack', isPrivate: false } })
  assert.equal(systemRoom.status, 403, `the system room must refuse a guest rename, got ${systemRoom.status}`)
  const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/api/desktop/v1/ws?roomId=lounge', { headers: { Cookie: cookie, Origin: origin }, handshakeTimeout: 8000 })
  let welcomed = false
  socket.on('message', raw => { if (String(raw).includes('server.hello')) welcomed = true })
  socket.on('close', () => {})
  socket.on('error', () => {})
  const handshake = new Promise(resolve => {
    socket.once('open', () => socket.send(JSON.stringify({ type: 'client.hello', payload: { apiVersion: '2026-01', clientVersion: '0.2.0' } })))
    const poll = async () => { for (let i = 0; i < 100; i++) { if (welcomed) return resolve('welcomed'); await delay(100) } return resolve('timeout') }
    void poll()
  })
  const outcome = await handshake
  socket.terminate()
  await once(socket, 'close').catch(() => {})
  assert.equal(outcome, 'welcomed', 'a guest must still be able to listen in a room')
  check('stack-guest-still-listens', { systemRoomRename: systemRoom.status, wsHandshake: outcome })

  console.log('STACK_R19_ACCEPTANCE_OK ' + JSON.stringify({ checks: results.map(result => result.check) }))
}

main().catch(error => { console.error(`STACK_R19_ACCEPTANCE_FAILED ${String(error?.message ?? error).slice(0, 300)}`); process.exitCode = 1 })
