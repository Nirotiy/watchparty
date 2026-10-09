// S4 cross-client acceptance on the live stack (18380) with two throwaway guest sessions in the
// shared `lounge`: what the desktop adapter does in one session must arrive in the other socket.
// No admin credentials, no .env, and no cookie value is ever printed. Anything this adds to the
// room is removed again before the script exits.
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const assert = require('node:assert/strict')

const repoRoot = path.resolve(__dirname, '../..')
const requireFromRoot = createRequire(path.join(repoRoot, 'package.json'))
const { WebSocket } = requireFromRoot('ws')
const ts = requireFromRoot('typescript')
const sharedRoot = path.join(repoRoot, 'desktop-shell/shared')

const moduleUrl = name => {
  const source = fs.readFileSync(path.join(sharedRoot, `${name}.ts`), 'utf8')
  const js = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
    .replace(/from "\.\/(musicparty-contract|retry|shared-room-state)"/g, (_, dependency) => `from "${moduleUrl(dependency)}"`)
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
}

const origin = process.env.LINKLE_STACK_ORIGIN ?? 'http://127.0.0.1:18380'
const wsUrl = origin.replace(/^http/, 'ws') + '/api/desktop/v1/ws?roomId=lounge'
const results = []
const check = (label, detail) => { results.push({ check: label, ...detail }); console.log(JSON.stringify({ check: label, ...detail })) }

async function mintSession(displayName) {
  const response = await fetch(`${origin}/api/account/guest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ displayName }),
  })
  assert.equal(response.status, 200, `a guest session must still be mintable, got ${response.status}`)
  return response.headers.getSetCookie().filter(entry => /^(MP_SESSION|MP_CSRF)=/.test(entry)).map(entry => entry.split(';')[0]).join('; ')
}

async function main() {
  const sweep = process.argv.includes('--sweep')
  const tag = randomBytes(3).toString('hex')
  const [cookieA, cookieB] = [await mintSession(`s4-A-${tag}`), await mintSession(`s4-B-${tag}`)]
  const csrfOf = cookie => /MP_CSRF=([^;]+)/.exec(cookie)?.[1] ?? ''

  // B is a plain second client: it only records what the server pushes to it.
  const frames = []
  const socketB = new WebSocket(wsUrl, { headers: { Cookie: cookieB, Origin: origin }, handshakeTimeout: 8000 })
  socketB.on('message', raw => { const frame = JSON.parse(String(raw)); frames.push(frame); if (frame.type === 'client.hello' || frame.type === 'server.hello') return })
  await once(socketB, 'open')
  socketB.send(JSON.stringify({ type: 'client.hello', payload: { apiVersion: '2026-01', clientVersion: '0.2.0' } }))

  // A drives the shipped adapter, i.e. the same code the desktop app runs.
  const { MusicPartyAdapter } = await import(moduleUrl('musicparty-adapter'))
  const adapter = new MusicPartyAdapter({
    origin, roomId: 'lounge',
    fetchImpl: (url, init = {}) => {
      const headers = new Headers(init.headers)
      headers.set('Cookie', cookieA)
      headers.set('Origin', origin)
      if ((init.method ?? 'GET').toUpperCase() !== 'GET') headers.set('X-CSRF-Token', csrfOf(cookieA))
      return fetch(String(url), { ...init, headers, redirect: 'manual' })
    },
    webSocketFactory: url => new WebSocket(url, { headers: { Cookie: cookieA, Origin: origin }, handshakeTimeout: 8000 }),
  })
  const events = []
  adapter.subscribe(event => events.push(event))
  const lastOf = type => [...events].reverse().find(event => event.type === type)
  const waitFor = async (predicate, label, ms = 20000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { if (await predicate()) return true; await delay(100) }
    // A timeout is only useful if it says what the wire actually carried.
    console.log(JSON.stringify({
      diagnostics: label,
      frames: frames.map(frame => `${frame.type}${frame.payload?.code ? `#${frame.payload.code}` : ''}${frame.payload?.queue ? `(${frame.payload.queue.length})` : ''}${frame.payload?.queueVersion ? `@v${frame.payload.queueVersion}` : ''}`),
      events: events.map(event => `${event.type}${event.items ? `(${event.items.length})` : ''}${event.status ? `#${event.status}` : ''}`),
    }))
    throw new Error(`timeout: ${label}`)
  }
  await adapter.connect()
  await waitFor(() => lastOf('queue-state'), 'first queue state in lounge')
  const framesBefore = frames.length
  // The adapter keeps the queue in its own projection: `room` fires on join, queue traffic
  // arrives as `queue-state` items plus a monotonic queueVersion. Items are `MediaItem`s whose
  // `id` carries the server's queueId (`normalizeQueueEntry`), which is what remove verbs take.
  const entries = () => lastOf('queue-state')?.items ?? []
  const queueIdOf = entry => entry.id ?? entry.queueId
  const version = () => lastOf('queue-state')?.queueVersion ?? 0
  const baseline = entries().map(queueIdOf)
  const baselineVersion = version()
  check('s4-two-sessions-in-lounge', { frameTypes: [...new Set(frames.slice(0, framesBefore).map(frame => frame.type))].sort().join(','), queueBefore: baseline.length, controlAck: adapter.desktopProbe?.features.controlAck === true })
  assert.ok(framesBefore > 0, 'the second session must already have been fed room state')

  if (sweep) {
    // One-off repair for a run that died mid-flight: drop only the song this script itself would
    // have added, so a leftover can never be confused with somebody else's queue item.
    const target = (await adapter.search('netease', '稻香'))[0]
    const doomed = entries().filter(entry => entry.musicId === target.sourceId).map(queueIdOf)
    for (const queueId of doomed) adapter.sendQueueMutation('queue.remove', queueId)
    await waitFor(() => doomed.length === 0 || entries().length === baseline.length - doomed.length, 'sweep applied')
    check('s4-sweep-leftovers', { removed: doomed.length, queueNow: entries().length })
    await adapter.disconnect()
    socketB.terminate()
    await once(socketB, 'close').catch(() => {})
    console.log('STACK_S4_SWEEP_OK')
    return
  }

  // 1. Search through the desktop route, then enqueue the first hit.
  const found = await adapter.search('netease', '稻香')
  assert.ok(Array.isArray(found) && found.length > 0, 'the live netease provider must return results')
  const picked = found[0]
  check('s4-search-returns-results', { platform: picked.platform, hits: found.length })
  const enqueued = await adapter.enqueue(picked.platform, picked.sourceId)
  assert.equal(enqueued, true, 'the enqueue command must be accepted')
  await waitFor(() => entries().length > baseline.length, 'queue grows for the actor')
  const mine = entries().map(queueIdOf).filter(queueId => !baseline.includes(queueId))
  // The other session must see the same room without being asked: a newer queueVersion on any
  // pushed frame is the fan-out proof, whatever envelope the server carried it in.
  await waitFor(() => frames.slice(framesBefore).some(frame => (frame.payload?.queueVersion ?? 0) > baselineVersion), 'queue version advances for the bystander')
  const carriers = [...new Set(frames.slice(framesBefore).filter(frame => (frame.payload?.queueVersion ?? 0) > baselineVersion).map(frame => frame.type))]
  check('s4-enqueue-fans-out', { added: mine.length, actorQueue: entries().length, versionFrom: baselineVersion, versionTo: frames.slice(framesBefore).map(frame => frame.payload?.queueVersion ?? 0).filter(value => value > baselineVersion).at(-1), bystanderFrames: carriers.sort().join(',') })

  // 2. The pause must reach the bystander as well: `player.state.isPaused` is the wire field, and
  // the control ack says the server applied it for this room.
  let pauseOutcome = null
  let bystanderPaused = false
  try {
    pauseOutcome = await adapter.sendControl('pause')
    bystanderPaused = await waitFor(() => frames.slice(framesBefore).some(frame => frame.type === 'player.state' && frame.payload?.isPaused === true), 'bystander sees the pause', 12000).then(() => true, () => false)
  } catch (error) {
    pauseOutcome = `threw:${error.message}`
  }
  check('s4-control-fans-out', { pauseOutcome, bystanderSawPaused: bystanderPaused })
  assert.equal(pauseOutcome, 'applied', 'the shared pause must be acknowledged')
  assert.equal(bystanderPaused, true, 'the other session must observe the same pause')

  // 3. Leave the room as found: remove exactly what this run added, then hang up both sessions.
  for (const queueId of mine) adapter.sendQueueMutation('queue.remove', queueId)
  await waitFor(() => entries().length === baseline.length, 'queue restored')
  await adapter.disconnect()
  socketB.terminate()
  await once(socketB, 'close').catch(() => {})
  check('s4-state-restored', { added: mine.length, queueAfter: entries().length, queueBefore: baseline.length })

  console.log('STACK_S4_ACCEPTANCE_OK ' + JSON.stringify({ checks: results.map(result => result.check) }))
}

main().catch(async error => {
  console.error(`STACK_S4_ACCEPTANCE_FAILED ${String(error?.message ?? error).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, '<module>').slice(0, 300)}`)
  process.exitCode = 1
}).finally(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref() })
