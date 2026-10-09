// S3 evidence: drives the shared desktop adapter (the real join/reconnect state machine) against
// a freshly built MusicParty server in a temporary directory. No repository database, .env,
// platform cookie or credential file is opened, and no cookie or invite value is ever printed.
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')

const repoRoot = path.resolve(__dirname, '../..')
const requireFromRoot = createRequire(path.join(repoRoot, 'package.json'))
const { WebSocket } = requireFromRoot('ws')
const ts = requireFromRoot('typescript')
const sharedRoot = path.join(repoRoot, 'desktop-shell/shared')

function moduleUrl(name) {
  const source = fs.readFileSync(path.join(sharedRoot, `${name}.ts`), 'utf8')
  const js = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
    .replace(/from "\.\/(musicparty-contract|retry|shared-room-state)"/g, (_, dependency) => `from "${moduleUrl(dependency)}"`)
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
}

async function hookModuleUrl(relativePath) {
  // Hook modules are only loadable outside React; stub the two imports they need so the
  // real gating code path runs unchanged inside this script.
  const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
  const js = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
    .replace(/import\s*\{[^}]*\}\s*from\s*"react";?/, 'const useCallback = fn => fn; const useMemo = fn => fn();')
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
}

async function main() {
  assert.equal(process.platform, 'win32', 'mirrors the shipped desktop transport on Windows')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchparty-mp-join-'))
  const children = []
  const start = (exe, args, options) => { const child = spawn(exe, args, { windowsHide: true, ...options }); children.push(child); return child }
  const results = []
  const check = (label, detail) => { results.push({ check: label, ...detail }); console.log(JSON.stringify({ check: label, ...detail })) }
  try {
    const goRoot = path.resolve(repoRoot, '../musicparty/MusicParty/backend-go')
    const exe = path.join(dir, 'musicparty-join-e2e.exe')
    assert.equal((await once(start('go', ['build', '-o', exe, './cmd/musicparty'], { cwd: goRoot, stdio: 'inherit' }), 'exit'))[0], 0, 'Go build failed')
    const reservation = net.createServer()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const port = reservation.address().port
    await new Promise(resolve => reservation.close(resolve))
    const origin = `http://127.0.0.1:${port}`
    const wsOrigin = origin.replace(/^http/, 'ws')
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(systemroot|windir|path|temp|tmp)$/i.test(name)))
    const password = randomUUID()
    const server = start(exe, [], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...env, SERVER_PORT: String(port), BASE_URL: origin, ALLOWED_ORIGINS: origin,
      DB_PATH: path.join(dir, 'test.db'), DB_INIT_SCHEMA: 'true', DB_ENABLED: 'true',
      BOOTSTRAP_ADMIN_USERNAME: 'e2e-join-admin', BOOTSTRAP_ADMIN_PASSWORD: password,
      AUTH_SECURE_COOKIES: 'false', ROOM_ACCESS_TOKEN_SECRET: randomUUID(),
      LOCAL_LIBRARY_PATH: path.join(dir, 'empty-library'), LOCAL_LIBRARY_ENABLED: 'true',
      YOUTUBE_ENABLED: 'false', NAVIDROME_ENABLED: 'false', SQUIDIFY_ENABLED: 'false',
      NETEASE_API_URL: 'http://127.0.0.1:1', STATIC_PATH: path.join(dir, 'empty-static'),
    } })
    let listening = false
    server.stdout.on('data', chunk => { if (chunk.toString().includes('musicparty Go backend listening')) listening = true })
    server.stderr.resume()
    for (let i = 0; !listening && i < 200; i++) {
      assert.equal(server.exitCode, null, 'test server exited during startup')
      await delay(100)
    }
    assert.ok(listening, 'actual Go server readiness log missing')
    assert.equal((await fetch(`${origin}/api/desktop/v1/health`)).status, 200)

    const sessionRequest = async (method, urlPath, { cookie = '', csrf = '', body } = {}) => {
      const headers = { Accept: 'application/json' }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      if (cookie) headers.Cookie = cookie
      if (csrf) headers['X-CSRF-Token'] = csrf
      if (urlPath.startsWith('/api/dev/')) headers.Origin = origin
      // The desktop routes sit behind a version gate that runs before routing.
      if (urlPath.startsWith('/api/desktop/')) { headers['X-Desktop-API-Version'] = '2026-01'; headers['X-Desktop-Client-Version'] = '0.2.0' }
      const response = await fetch(origin + urlPath, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
      const value = await response.json().catch(() => null)
      return { status: response.status, value, setCookies: response.headers.getSetCookie(), cookieHeader: response.headers.getSetCookie().map(entry => entry.split(';')[0]).join('; ') }
    }
    const login = await sessionRequest('POST', '/api/account/login', { body: { username: 'e2e-join-admin', password } })
    assert.equal(login.status, 200, 'bootstrap admin login failed')
    const adminCookie = login.cookieHeader
    // The dev room routes are not on the CSRF exemption list, which matches exact paths only.
    const adminCsrf = /MP_CSRF=([^;]+)/.exec(adminCookie)?.[1] ?? ''
    assert.ok(adminCsrf.length > 0, 'no CSRF token issued')
    const admin = (await sessionRequest('GET', '/api/account/me', { cookie: adminCookie })).value
    assert.ok(typeof admin?.publicId === 'string' && admin.publicId.length > 0)
    const guest = await sessionRequest('POST', '/api/account/guest', { body: { displayName: 'e2e 第二成员' } })
    assert.equal(guest.status, 200, 'guest session failed')
    const invite = await sessionRequest('POST', '/api/dev/rooms/lounge/invites', { cookie: adminCookie, csrf: adminCsrf, body: { label: 'join e2e' } })
    assert.equal(invite.status, 200, 'invite mint failed')
    assert.ok(typeof invite.value?.code === 'string' && invite.value.code.length > 0)

    const { MusicPartyAdapter } = await import(moduleUrl('musicparty-adapter'))
    const sockets = []
    const events = []
    const adapter = new MusicPartyAdapter({
      origin, roomId: undefined,
      fetchImpl: (url, init = {}) => {
        const headers = new Headers(init.headers)
        headers.set('Cookie', adminCookie)
        headers.set('Origin', origin)
        return fetch(String(url), { ...init, headers, redirect: 'manual' })
      },
      webSocketFactory: url => {
        const socket = new WebSocket(url, { headers: { Cookie: adminCookie, Origin: origin }, handshakeTimeout: 8000 })
        sockets.push(socket)
        return socket
      },
    })
    adapter.subscribe(event => events.push(event))
    const lastOf = type => [...events].reverse().find(event => event.type === type)
    const waitFor = async (predicate, label, ms = 20000) => {
      const end = Date.now() + ms
      while (Date.now() < end) { if (await predicate()) return; await delay(50) }
      throw new Error(`timeout: ${label}`)
    }

    // A. invite redemption commits only once the room's first snapshot is applied.
    const joined = await adapter.redeemInvite(invite.value.code)
    assert.equal(joined.roomId, 'lounge')
    assert.equal(adapter.roomId, 'lounge')
    assert.ok(lastOf('playback'), 'no snapshot committed by the join')
    assert.equal(lastOf('room').room.id, 'lounge')
    check('join-commits-on-first-snapshot', { sockets: sockets.length, connectionStatus: lastOf('connection').status, queueLength: lastOf('room').room.queue.length })

    // B. presence: a second distinct session shows up in the member list and disappears again.
    const peer = new WebSocket(`${wsOrigin}/api/desktop/v1/ws?roomId=lounge`, { headers: { Cookie: guest.cookieHeader, Origin: origin } })
    const peerHello = new Promise(resolve => peer.once('message', resolve))
    await once(peer, 'open')
    peer.send(JSON.stringify({ type: 'client.hello', payload: { apiVersion: '2026-01', clientVersion: '0.2.0' } }))
    await peerHello
    peer.on('message', () => {})
    await waitFor(() => lastOf('members')?.members.length === 2, 'two members')
    const names = lastOf('members').members.map(member => member.id).sort()
    assert.ok(names.includes(admin.publicId), 'the signed-in account must appear in its own room')
    assert.ok(names.includes(guest.value.publicId), 'the guest account must appear in the member list')
    peer.close()
    await waitFor(() => lastOf('members')?.members.length === 1, 'member list shrinks on leave')
    check('member-list-presence', { members: names.length, selfIncluded: names.includes(admin.publicId), restored: lastOf('members').members.length })

    // C. abrupt transport loss recovers: reconnect, re-welcome, fresh snapshot, fresh presence.
    const mark = events.length
    sockets.at(-1).terminate()
    await waitFor(() => events.slice(mark).some(event => event.type === 'connection' && event.status === 'reconnecting'), 'reconnect starts')
    await waitFor(() => events.slice(mark).some(event => event.type === 'connection' && event.status === 'ready'), 'reconnect welcomes')
    await waitFor(() => events.slice(mark).some(event => event.type === 'room'), 'snapshot after reconnect')
    await waitFor(() => events.slice(mark).some(event => event.type === 'members'), 'presence after reconnect')
    assert.ok(sockets.length >= 2, 'a replacement socket must be opened')
    assert.equal(adapter.roomId, 'lounge', 'recovery stays in the same room')
    check('reconnect-recovers-room-state', { sockets: sockets.length, reconnectEvents: events.slice(mark).filter(event => event.type === 'connection').map(event => event.status), members: lastOf('members').members.length })

    // D. a join that never commits rolls the room back, then the previous room is restorable.
    const markD = events.length
    const ghost = `ghost-${randomUUID().slice(0, 8)}`
    const rejected = await adapter.joinRoom(ghost).then(() => null, error => error)
    assert.ok(rejected instanceof Error, 'joining a non-existent room must fail')
    assert.equal(adapter.roomId, 'lounge', 'a failed join must leave no room behind for a later switch to re-enter')
    assert.equal(events.slice(markD).some(event => event.type === 'room' && event.room.id === ghost), false, 'an uncommitted room must not report state')
    await adapter.connect()
    await waitFor(() => events.slice(markD).some(event => event.type === 'room' && event.room.id === 'lounge'), 'previous room restorable')
    check('failed-join-rolls-back', { error: rejected.message, roomAfterRollback: adapter.roomId })

    // E. desktop room creation. The HTTP endpoint takes a registered account rather than any
    // session (R5-1 裁决 ②), while the socket command stays administrator-gated, so an
    // invite-redeemed member opens a private room over HTTP and enters it from the access proof
    // that response placed in its own cookie jar; a guest session is refused with a code. Only
    // booleans and counts are reported; no cookie or invite value is ever printed.
    const makeJar = setCookies => {
      const cookies = new Map()
      const absorb = entries => {
        for (const entry of entries ?? []) {
          const [pair, ...attributes] = entry.split(';')
          const [name, ...valueParts] = pair.split('=')
          const key = name.trim()
          if (!['MP_SESSION', 'MP_CSRF', 'MP_ROOM_ACCESS'].includes(key)) continue
          const deleted = attributes.some(attribute => /^max-age\s*=\s*0$/i.test(attribute.trim()))
          const value = valueParts.join('=')
          if (deleted || !value) cookies.delete(key); else cookies.set(key, value)
        }
      }
      absorb(setCookies)
      return {
        header: () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
        has: key => cookies.has(key),
        csrf: () => cookies.get('MP_CSRF') ?? '',
        absorb,
        dropRoomAccess: () => cookies.delete('MP_ROOM_ACCESS'),
      }
    }
    const jarTransport = (jar, sockets) => ({
      fetchImpl: (url, init = {}) => {
        const headers = new Headers(init.headers)
        headers.set('Cookie', jar.header())
        headers.set('Origin', origin)
        if ((init.method ?? 'GET').toUpperCase() !== 'GET') headers.set('X-CSRF-Token', jar.csrf())
        return fetch(String(url), { ...init, headers, redirect: 'manual' }).then(response => {
          jar.absorb(response.headers.getSetCookie())
          if (new URL(String(url), origin).pathname === '/api/desktop/v1/invites/redeem') jar.dropRoomAccess()
          return response
        })
      },
      webSocketFactory: url => {
        const socket = new WebSocket(url, { headers: { Cookie: jar.header(), Origin: origin }, handshakeTimeout: 8000 })
        sockets.push(socket)
        return socket
      },
    })
    const memberSockets = []
    const memberJar = makeJar([])
    const memberAdapter = new MusicPartyAdapter({ origin, roomId: undefined, ...jarTransport(memberJar, memberSockets) })
    const memberEvents = []
    memberAdapter.subscribe(event => memberEvents.push(event))
    const memberLastOf = type => [...memberEvents].reverse().find(event => event.type === type)
    const memberInvite = await sessionRequest('POST', '/api/dev/rooms/lounge/invites', { cookie: adminCookie, csrf: adminCsrf, body: { label: 'join e2e member' } })
    assert.equal(memberInvite.status, 200, 'a second invite must be mintable')
    const redeemed = await memberAdapter.redeemInvite(memberInvite.value.code)
    assert.equal(redeemed.roomId, 'lounge', 'the invite places its member in the room that issued it')
    assert.equal(memberAdapter.desktopProbe?.account?.isGuest, false, 'an invite-redeemed session must read as a registered account')
    assert.ok(memberAdapter.desktopProbe?.account?.publicId, 'the probe must carry the account the lobby gates on')
    assert.equal(memberAdapter.desktopProbe?.features.roomCreate, true, 'the server must advertise the desktop room endpoint')
    const createdRoomName = `member-room-${randomUUID().slice(0, 8)}`
    const httpCreated = await memberAdapter.createRoom({ name: createdRoomName, isPrivate: true, password: 'a-private-pin' })
    assert.equal(httpCreated.name, createdRoomName)
    assert.equal(httpCreated.visibility, 'private')
    assert.equal(httpCreated.requiresPassword, false, 'the create response must grant this room access')
    assert.ok(httpCreated.roomId.startsWith('room-'))
    assert.equal(httpCreated.creatorPublicId, memberAdapter.desktopProbe?.account?.publicId, 'the response must name the owner the lobby gates management on')
    check('private-room-created-by-member-over-http', { advertised: memberAdapter.desktopProbe.features.roomCreate === true, registered: memberAdapter.desktopProbe.account.isGuest === false, accessCookieStored: memberJar.has('MP_ROOM_ACCESS'), visibility: httpCreated.visibility })

    const guestSockets = []
    const guestJar = makeJar(guest.setCookies)
    const guestAdapter = new MusicPartyAdapter({ origin, roomId: 'lounge', ...jarTransport(guestJar, guestSockets) })
    await guestAdapter.connect()
    const refusedName = `guest-room-${randomUUID().slice(0, 8)}`
    const guestCreate = await guestAdapter.createRoom({ name: refusedName, isPrivate: false }).then(() => null, error => error)
    assert.equal(guestCreate?.code, 'rejected', 'a guest session must be refused at the endpoint')
    const guestRefusal = await sessionRequest('POST', '/api/desktop/v1/rooms', { cookie: guestJar.header(), csrf: guestJar.csrf(), body: { name: refusedName } })
    assert.equal(guestRefusal.status, 403, `a guest must be refused, got ${guestRefusal.status}`)
    assert.equal(guestRefusal.value?.code, 'guest-not-allowed', 'the refusal has to carry a code, not just prose')
    assert.equal((await sessionRequest('GET', '/api/rooms')).value.some(item => item.name === refusedName), false, 'a refused create must leave no room behind')
    check('guest-session-cannot-create-room', { adapterCode: guestCreate?.code, status: guestRefusal.status, code: guestRefusal.value?.code })

    await memberAdapter.joinRoom(httpCreated.roomId)
    assert.equal(memberAdapter.roomId, httpCreated.roomId, 'a creator enters the room it just made without a password prompt')
    assert.equal(memberLastOf('room')?.room.id, httpCreated.roomId)
    check('creator-enters-own-private-room', { snapshotEvents: memberEvents.filter(event => event.type === 'room' && event.room.id === httpCreated.roomId).length })

    const denied = []
    const deniedSocket = new WebSocket(`${wsOrigin}/api/desktop/v1/ws?roomId=lounge`, { headers: { Cookie: memberJar.header(), Origin: origin }, handshakeTimeout: 8000 })
    memberSockets.push(deniedSocket)
    deniedSocket.on('message', raw => denied.push(JSON.parse(String(raw))))
    await once(deniedSocket, 'open')
    deniedSocket.send(JSON.stringify({ type: 'client.hello', payload: { apiVersion: '2026-01', clientVersion: '0.2.0' } }))
    await waitFor(() => denied.some(message => message.type === 'player.state'), 'guest socket welcomed')
    deniedSocket.send(JSON.stringify({ type: 'rooms.create', payload: { name: `ws-room-${randomUUID().slice(0, 8)}`, isPrivate: false, password: '' } }))
    await waitFor(() => denied.some(message => message.payload?.code === 'CONTROL_DENIED'), 'non-admin room creation denied over the socket')
    assert.equal(denied.some(message => message.type === 'rooms.created'), false)
    check('ws-room-create-still-admin-only', { deniedCode: denied.find(message => message.payload?.code === 'CONTROL_DENIED').payload.code, createdFrames: denied.filter(message => message.type === 'rooms.created').length })

    // F. the lobby facade is the seam the app actually calls. Its create entry depends on the
    // probe living on the connected adapter instance, so a real server must confirm both halves:
    // no connection means no entry, and a connected one can create, list and join in one hop.
    const { MusicPartyConnection } = await import(moduleUrl('musicparty-connection'))
    const { useLobbyFacade } = await import(await hookModuleUrl('desktop-shell/src/hooks/use-lobby-facade.ts'))
    const lobbySockets = []
    const lobbyTransport = jarTransport(memberJar, lobbySockets)
    const connection = new MusicPartyConnection((nextOrigin, roomId) => new MusicPartyAdapter({ origin: nextOrigin, roomId, ...lobbyTransport }), () => {})
    const lobby = () => useLobbyFacade({
      origin,
      connection,
      createAdapter: () => new MusicPartyAdapter({ origin, ...lobbyTransport }),
      switchTo: async target => { await connection.run(origin, current => current.joinRoom(target.identity.roomId)) },
    })
    assert.equal(lobby().canCreateRoom, false, 'a facade over an unconnected origin must not offer creation')
    await connection.run(origin, current => current.joinRoom('lounge'))
    const entryAfterConnect = lobby().canCreateRoom
    assert.equal(entryAfterConnect, true, 'the connected adapter must carry the probe the entry reads')
    const lobbyRoomName = `lobby-room-${randomUUID().slice(0, 8)}`
    const lobbyRoom = await lobby().createRoom({ name: lobbyRoomName, isPrivate: false })
    assert.equal(lobbyRoom.visibility, 'public')
    assert.ok((await lobby().listRooms()).some(item => item.roomId === lobbyRoom.roomId), 'the lobby must list the room it just created')
    await lobby().joinRoom({ service: 'musicparty', origin, roomId: lobbyRoom.roomId })
    assert.equal(connection.current?.roomId, lobbyRoom.roomId, 'the facade join lands in the new room')
    check('lobby-facade-entry-and-roundtrip', {
      entryBeforeConnect: false, entryAfterConnect, created: lobbyRoom.visibility,
      listedAndJoined: connection.current?.roomId === lobbyRoom.roomId,
    })

    // G. browsing alone must raise the create entry. The old facade listed rooms through a
    // throwaway adapter, so the probe never reached the instance the gate reads and desktop
    // room creation was unreachable in the app however capable the server was.
    const socketsBeforeBrowse = lobbySockets.length
    const browseConnection = new MusicPartyConnection((nextOrigin, roomId) => new MusicPartyAdapter({ origin: nextOrigin, roomId, ...lobbyTransport }), () => {})
    const browseFacade = () => useLobbyFacade({ origin, connection: browseConnection, switchTo: async () => {} })
    assert.equal(browseFacade().canCreateRoom, false, 'a lobby that has not listed yet offers nothing')
    const browsed = await browseFacade().listRooms()
    assert.ok(Array.isArray(browsed) && browsed.length > 0, 'the real server must list rooms')
    assert.equal(browseFacade().canCreateRoom, true, 'listing must surface the advertised create entry')
    assert.equal(lobbySockets.length, socketsBeforeBrowse, 'browsing must not open a room socket')
    await browseConnection.dispose()
    check('lobby-browsing-enables-create-entry', { rooms: browsed.length, socketsOpened: lobbySockets.length - socketsBeforeBrowse })

    // H. the sequence the app actually performs when the user presses 连接 without a room and
    // then tries to join from the lobby: the socket has nothing to enter, so the server refuses
    // the upgrade and the adapter falls into its retry loop. The later join must still land.
    // H. the app's 连接 button opens a socket with no room, and the native path sends the query
    // parameter even when it is empty (`?roomId=`), which is not the same request as omitting it.
    // Record what the real server makes of each form, then prove a later join still lands.
    const handshake = query => new Promise(resolve => {
      const socket = new WebSocket(`${wsOrigin}/api/desktop/v1/ws${query}`, { headers: { Cookie: memberJar.header(), Origin: origin }, handshakeTimeout: 6000 })
      const done = value => { try { socket.terminate() } catch {} resolve(value) }
      const timer = setTimeout(() => done('timeout'), 7000)
      socket.on('open', () => socket.send(JSON.stringify({ type: 'client.hello', payload: { apiVersion: '2026-01', clientVersion: '0.2.0' } })))
      socket.on('message', raw => { clearTimeout(timer); done(String(raw).slice(0, 24).includes('server.hello') ? 'welcomed' : 'other-frame') })
      socket.on('unexpected-response', (_request, response) => { clearTimeout(timer); done('http_' + response.statusCode) })
      socket.on('close', code => { clearTimeout(timer); done('closed_' + code) })
      socket.on('error', () => { clearTimeout(timer); done('error') })
    })
    const emptyParam = await handshake('?roomId=')
    const omitted = await handshake('')
    const anonymous = await new Promise(resolve => {
      const socket = new WebSocket(`${wsOrigin}/api/desktop/v1/ws?roomId=lounge`, { headers: { Origin: origin }, handshakeTimeout: 6000 })
      let opened = false
      const done = value => { try { socket.terminate() } catch {} resolve({ upgraded: opened, outcome: value }) }
      const timer = setTimeout(() => done('timeout'), 7000)
      socket.on('open', () => { opened = true; socket.send(JSON.stringify({ type: 'client.hello', payload: { apiVersion: '2026-01', clientVersion: '0.2.0' } })) })
      socket.on('close', code => { clearTimeout(timer); done('closed_' + code) })
      socket.on('unexpected-response', (_r, response) => { clearTimeout(timer); done('http_' + response.statusCode) })
      socket.on('error', () => { clearTimeout(timer); done('error') })
    })
    check('ws-handshake-needs-a-session', { withSession: [emptyParam, omitted], anonymous })
    assert.equal(anonymous.outcome, 'closed_1008', 'a sessionless machine is refused after the upgrade, which is what the retry loop reports as 重连中')
    const socketsBeforeIdle = lobbySockets.length
    const idleEvents = []
    const idleAdapter = new MusicPartyAdapter({ origin, fetchImpl: lobbyTransport.fetchImpl, webSocketFactory: lobbyTransport.webSocketFactory })
    idleAdapter.subscribe(event => idleEvents.push(event))
    await idleAdapter.connect()
    await delay(1200)
    check('connect-without-room-stays-off-socket', {
      sockets: lobbySockets.length - socketsBeforeIdle,
      statuses: idleEvents.filter(event => event.type === 'connection').map(event => event.status),
    })
    assert.equal(lobbySockets.length, socketsBeforeIdle, 'the desktop must not land in the server default room')
    await idleAdapter.joinRoom('lounge')
    assert.equal(idleAdapter.roomId, 'lounge', 'a join must still recover from the idle state')
    await idleAdapter.disconnect()

    // I. management belongs to the creator: the owner renames and deletes their room, a second
    // registered member is refused both, and the deleted room leaves the public list. The
    // outsider redeems its own invite, so its refusal is about ownership rather than identity.
    const renamedName = `renamed-${randomUUID().slice(0, 8)}`
    const rename = await sessionRequest('PUT', `/api/rooms/${encodeURIComponent(httpCreated.roomId)}`, {
      cookie: memberJar.header(), csrf: memberJar.csrf(), body: { name: renamedName, isPrivate: true, keepExistingPassword: true },
    })
    assert.equal(rename.status, 200, `the creator must be able to rename their room, got ${rename.status}`)
    assert.equal(rename.value?.name, renamedName)
    assert.equal(rename.value?.privateRoom, true, 'keeping the existing password must keep the room private')
    const outsiderInvite = await sessionRequest('POST', '/api/dev/rooms/lounge/invites', { cookie: adminCookie, csrf: adminCsrf, body: { label: 'join e2e outsider' } })
    assert.equal(outsiderInvite.status, 200, 'a third invite must be mintable')
    const outsiderRedeem = await sessionRequest('POST', '/api/desktop/v1/invites/redeem', { body: { code: outsiderInvite.value.code, displayName: 'e2e 第三者' } })
    assert.equal(outsiderRedeem.status, 200, 'the outsider must reach the room through the same invite path')
    const outsiderJar = makeJar(outsiderRedeem.setCookies)
    const outsiderRoomName = `outsider-room-${randomUUID().slice(0, 8)}`
    const outsiderCreate = await sessionRequest('POST', '/api/desktop/v1/rooms', { cookie: outsiderJar.header(), csrf: outsiderJar.csrf(), body: { name: outsiderRoomName } })
    assert.equal(outsiderCreate.status, 200, `the tightening must not cost a registered member its create right, got ${outsiderCreate.status}`)
    const stolen = await sessionRequest('PUT', `/api/rooms/${encodeURIComponent(httpCreated.roomId)}`, { cookie: outsiderJar.header(), csrf: outsiderJar.csrf(), body: { name: 'hijacked', isPrivate: false } })
    const outsiderDelete = await sessionRequest('DELETE', `/api/rooms/${encodeURIComponent(httpCreated.roomId)}`, { cookie: outsiderJar.header(), csrf: outsiderJar.csrf() })
    assert.equal(stolen.status, 403, 'a non-owner member may not rename it')
    assert.equal(outsiderDelete.status, 403, 'a non-owner member may not delete it')
    const removed = await sessionRequest('DELETE', `/api/rooms/${encodeURIComponent(httpCreated.roomId)}`, { cookie: memberJar.header(), csrf: memberJar.csrf() })
    assert.equal(removed.status, 200, 'the creator may delete the room they opened')
    const listedAfter = (await sessionRequest('GET', '/api/rooms')).value ?? []
    check('creator-manages-own-room', {
      outsiderIsMember: outsiderCreate.status === 200,
      renamed: rename.value?.name === renamedName && rename.value?.privateRoom === true,
      outsiderRename: stolen.status, outsiderDelete: outsiderDelete.status,
      stillListed: listedAfter.some(item => item.roomId === httpCreated.roomId),
    })
    assert.equal(listedAfter.some(item => item.roomId === httpCreated.roomId), false, 'a deleted room must leave the list')

    for (const socket of [...memberSockets, ...guestSockets, ...lobbySockets]) socket.terminate()
    await connection.dispose()
    await adapter.disconnect()

    assert.ok(events.some(event => event.type === 'connection' && event.status === 'idle'), 'explicit leave reported')
    console.log(`MP_JOIN_EVENTS_OK types=${[...new Set(events.map(event => event.type))].sort().join(',')}`)
    console.log('MP_JOIN_S3_E2E_OK ' + JSON.stringify({ checks: results.map(result => result.check) }))
  } finally {
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'exit'); child.kill(); await closed }
    }
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()))
    assert.ok(path.basename(dir).startsWith('watchparty-mp-join-'))
    const removeFiles = folder => {
      for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, item.name)
        if (item.isDirectory()) { removeFiles(file); fs.rmdirSync(file) } else fs.unlinkSync(file)
      }
    }
    removeFiles(dir)
    fs.rmdirSync(dir)
    console.log('MP_JOIN_PROCESS_AND_TEMP_CLEANUP_OK')
  }
}
main().catch(error => { console.error(`MP_JOIN_E2E_FAILED ${String(error?.message ?? error).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, '<module>').slice(0, 400)}`); process.exitCode = 1 })
