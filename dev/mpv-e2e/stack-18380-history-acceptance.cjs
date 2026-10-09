// Live-stack (18380) acceptance for `history.list` / `history.page` with a throwaway guest
// session only: no admin credentials, no .env, no cookie or invite value ever printed. It reads
// whatever the room already played; if the room is empty it says so instead of mutating the room.
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const path = require('node:path')
const { createRequire } = require('node:module')
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
  return { status: response.status, value: await response.json().catch(() => null), cookieHeader: response.headers.getSetCookie().filter(entry => /^(MP_SESSION|MP_CSRF)=/.test(entry)).map(entry => entry.split(';')[0]).join('; ') }
}

async function main() {
  const capabilities = await call('GET', '/api/desktop/v1/capabilities', { desktop: true })
  assert.equal(capabilities.status, 200)
  check('history-capabilities', {
    roomHistory: capabilities.value.features?.roomHistory === true,
    roomCreate: capabilities.value.features?.roomCreate === true,
    roomManage: capabilities.value.features?.roomManage === true,
  })
  assert.equal(capabilities.value.features.roomHistory, true, 'the deployed build must advertise the history command')

  const guest = await call('POST', '/api/account/guest', { body: { displayName: 'history 探针' } })
  assert.equal(guest.status, 200, 'guest session failed')
  const cookie = guest.cookieHeader
  assert.ok(/MP_CSRF=/.test(cookie), 'no CSRF pair issued')

  const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/api/desktop/v1/ws?roomId=lounge', { headers: { Cookie: cookie, Origin: origin }, handshakeTimeout: 8000 })
  socket.on('error', () => {})
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'client.hello', payload: { apiVersion: '2026-01', clientVersion: '0.2.0' } }))

  const frames = []
  socket.on('message', raw => frames.push(JSON.parse(String(raw))))
  const until = async wanted => {
    const end = Date.now() + 10000
    while (Date.now() < end) {
      const found = frames.find(frame => frame.type === wanted)
      if (found) return found
      await delay(50)
    }
    throw new Error(`timeout waiting for ${wanted}; saw ${[...new Set(frames.map(frame => frame.type))].join(',')}`)
  }
  const state = await until('player.state')
  const cursor = state.payload?.historyCursor ?? null
  check('history-handshake', { welcomed: true, historyCursor: cursor, frameTypes: [...new Set(frames.map(frame => frame.type))].sort().join(',') })

  const request = payload => { socket.send(JSON.stringify({ type: 'history.list', payload })); }
  const expectPage = async () => {
    const end = Date.now() + 10000
    while (Date.now() < end) {
      const page = frames.find(frame => frame.type === 'history.page')
      if (page) { frames.splice(frames.indexOf(page), 1); return page }
      await delay(50)
    }
    throw new Error('timeout waiting for history.page')
  }

  // A request id is echoed on the page (like control.ack), and a request without one keeps the
  // field null; clients may then correlate pages instead of matching by response type.
  socket.send(JSON.stringify({ type: 'history.list', requestId: 'live-42', payload: { offset: 0, limit: 1 } }))
  const correlated = await expectPage()
  assert.equal(correlated.requestId, 'live-42', 'the deployed build must echo requestId')
  request({ offset: 0, limit: 1 })
  const plain = await expectPage()
  check('history-request-id', { echoed: correlated.requestId, plainIsNull: plain.requestId === undefined || plain.requestId === null })
  assert.equal(plain.requestId ?? null, null, 'a request without an id must not invent one')

  request({ offset: 0, limit: 5 })
  const first = (await expectPage()).payload
  assert.equal(first.roomId, 'lounge')
  assert.equal(first.offset, 0)
  assert.ok(Number.isInteger(first.total), 'total must be a number')
  assert.ok(Array.isArray(first.items), 'items must be an array')
  check('history-first-page', {
    total: first.total, returned: first.items.length, offset: first.offset,
    keys: first.items.length > 0 ? Object.keys(first.items[0]).sort().join(',') : '',
    newestFirst: first.items.length < 2 ? true : first.items.every((item, index) => index === 0 || first.items[index - 1].playedAt >= item.playedAt),
    named: first.items.filter(item => typeof item.enqueuerName === 'string' && item.enqueuerName.length > 0).length,
    nullNamed: first.items.filter(item => item.enqueuerName === null).length,
  })

  request({ offset: 0, limit: 3 })
  const tiny = (await expectPage()).payload
  request({ offset: 3, limit: 3 })
  const next = (await expectPage()).payload
  const overlap = tiny.items.map(item => item.id).filter(id => next.items.map(item => item.id).includes(id))
  request({ offset: Math.max(first.total, 1) + 500, limit: 10 })
  const overflow = (await expectPage()).payload
  check('history-paging', {
    pageOneSize: tiny.items.length, pageTwoSize: next.items.length, overlappingIds: overlap.length,
    reachesPastTheMemoryWindow: first.total > 100 ? 'total > 100 on this room' : `total is ${first.total}; the >100 case is covered by the Go integration test`,
    overflowItems: overflow.items.length, overflowTotal: overflow.total,
    overflowIsArrayNotMissing: Array.isArray(overflow.items),
  })
  assert.equal(overlap.length, 0, 'offset paging must not repeat or skip entries')
  assert.equal(overflow.items.length, 0, 'reading past the end is an empty array')
  assert.equal(overflow.total, first.total, 'total stays the whole session regardless of offset')
  assert.equal(next.items.length > 0, first.total > 3, 'a second page exists exactly when there is more to show')

  socket.terminate()
  await once(socket, 'close').catch(() => {})
  console.log('STACK_HISTORY_ACCEPTANCE_OK ' + JSON.stringify({ checks: results.map(result => result.check) }))
}

main().catch(error => { console.error(`STACK_HISTORY_ACCEPTANCE_FAILED ${String(error?.message ?? error).slice(0, 300)}`); process.exitCode = 1 })
