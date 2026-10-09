// Live-stack (18380) acceptance for `control.unlike` and the liked-list mirror, on a throwaway
// guest session. By default it only touches whatever lounge is already playing, so the room ends
// where it started. With --enqueue it seeds two tracks itself (the queue must be empty for that to
// be harmless) and walks past both, which is how the per-track like scope gets proven live.
// No admin credentials, no .env, no platform cookie or invite value is ever opened or printed.
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const path = require('node:path')
const { createRequire } = require('node:module')
const assert = require('node:assert/strict')

const repoRoot = path.resolve(__dirname, '../..')
const requireFromRoot = createRequire(path.join(repoRoot, 'package.json'))
const { WebSocket } = requireFromRoot('ws')

const origin = process.env.LINKLE_STACK_ORIGIN ?? 'http://127.0.0.1:18380'
const seedWithEnqueue = process.argv.includes('--enqueue')
const keyword = process.env.LINKLE_SEED_KEYWORD ?? '周杰伦'
const results = []
const check = (label, detail) => { results.push({ check: label, ...detail }); console.log(JSON.stringify({ check: label, ...detail })) }

async function call(method, urlPath, { cookie = '', csrf = '', body, desktop = true } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookie) headers.Cookie = cookie
  if (csrf) headers['X-CSRF-Token'] = csrf
  if (desktop) { headers['X-Desktop-API-Version'] = '2026-01'; headers['X-Desktop-Client-Version'] = '0.2.0' }
  const response = await fetch(origin + urlPath, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
  return {
    status: response.status,
    value: await response.json().catch(() => null),
    cookieHeader: response.headers.getSetCookie().filter(entry => /^(MP_SESSION|MP_CSRF)=/.test(entry)).map(entry => entry.split(';')[0]).join('; '),
  }
}

async function main() {
  const capabilities = await call('GET', '/api/desktop/v1/capabilities')
  assert.equal(capabilities.status, 200)
  const features = capabilities.value?.features ?? {}
  check('likes-capabilities', { unlike: features.unlike === true, likePlaylist: features.likePlaylist === true, likedSongsEdit: features.likedSongsEdit === true, roomHistory: features.roomHistory === true })
  assert.equal(features.unlike, true, 'an older container has no unlike, so this probe cannot pass without a rebuild')
  assert.equal(features.likePlaylist, true, 'an older container never mirrors likes into the personal list')
  assert.equal(features.likedSongsEdit, true, 'an older container keeps the liked list fully read-only over the WebSocket')

  const guest = await call('POST', '/api/account/guest', { body: { displayName: 'likes 探针' }, desktop: false })
  assert.equal(guest.status, 200, 'guest session failed')
  const cookie = guest.cookieHeader
  const me = await call('GET', '/api/account/me', { cookie, desktop: false })
  assert.equal(me.status, 200)
  const self = me.value.publicId
  assert.ok(typeof self === 'string' && self.length > 0, 'account/me must carry the caller public id')

  const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/api/desktop/v1/ws?roomId=lounge', { headers: { Cookie: cookie, Origin: origin }, handshakeTimeout: 8000 })
  socket.on('error', () => {})
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'client.hello', payload: { apiVersion: '2026-01', clientVersion: '0.2.0' } }))
  const frames = []
  socket.on('message', raw => frames.push(JSON.parse(String(raw))))
  const find = (start, wanted) => frames.slice(start).filter(frame => frame.type === wanted)
  const until = async (start, wanted) => {
    const end = Date.now() + 12000
    while (Date.now() < end) {
      const seen = find(start, wanted)
      if (seen.length > 0) return seen[seen.length - 1]
      await delay(50)
    }
    throw new Error(`timeout waiting for ${wanted}; saw ${[...new Set(frames.slice(start).map(frame => frame.type))].join(',')}`)
  }
  const state = () => {
    const seen = find(0, 'player.state')
    return seen.length > 0 ? seen[seen.length - 1].payload : null
  }
  const playing = () => state()?.nowPlaying ?? null
  const likedBy = () => playing()?.likedUserIds ?? []
  const send = frame => { const mark = frames.length; socket.send(JSON.stringify(frame)); return mark }
  const control = async (type, payload) => {
    const mark = send({ type, requestId: `${type}-${frames.length}`, payload: payload ?? {} })
    const ack = await until(mark, 'control.ack')
    return { ack: ack.payload, outcome: ack.payload?.outcome, code: ack.payload?.code, mark }
  }
  const awaitTrack = async () => {
    const end = Date.now() + 12000
    while (Date.now() < end) {
      if (playing()) return true
      await delay(50)
    }
    return false
  }
  const likedList = async () => {
    const mark = send({ type: 'playlist.list', payload: { scope: 'user' } })
    const listed = (await until(mark, 'playlist.data')).payload?.playlists ?? []
    const row = listed.find(item => item.systemKey === 'liked-songs')
    const tracks = row ? await (async () => {
      const getMark = send({ type: 'playlist.get', payload: { scope: 'user', playlistId: row.id, offset: 0, limit: 50 } })
      return ((await until(getMark, 'playlist.data')).payload?.tracks ?? []).map(item => `${item.music.platform}:${item.music.id}`)
    })() : null
    return { row, tracks }
  }
  const likedListRows = async playlistID => {
    const mark = send({ type: 'playlist.get', payload: { scope: 'user', playlistId: playlistID, offset: 0, limit: 50 } })
    return (await until(mark, 'playlist.data')).payload?.tracks ?? []
  }
  const removeLiked = async (playlistID, trackID, mutationID) => {
    const mark = send({ type: 'playlist.remove-items', payload: { scope: 'user', playlistId: playlistID, trackIds: [trackID], mutationId: mutationID } })
    const reply = await until(mark, 'playlist.ack').catch(() => null)
    if (reply) return { operation: reply.payload?.operation, removedCount: reply.payload?.removedCount }
    const nacked = await until(mark, 'playlist.nack')
    return { reason: nacked.payload?.reason }
  }

  let seeded = []
  if (!playing()) {
    if (!seedWithEnqueue) {
      check('likes-skipped', { reason: 'lounge has no current track; pass --enqueue to seed two (the queue must be empty)' })
      socket.terminate(); await once(socket, 'close').catch(() => {})
      console.log('STACK_LIKES_ACCEPTANCE_SKIPPED ' + JSON.stringify({ checks: results.map(item => item.check) }))
      return
    }
    assert.equal((state()?.queue ?? []).length, 0, '--enqueue only runs against an empty queue so nothing of yours gets pushed')
    const found = await call('GET', `/api/desktop/v1/search/netease?q=${encodeURIComponent(keyword)}&offset=0&limit=6`, { cookie })
    assert.equal(found.status, 200)
    seeded = (found.value?.items ?? []).slice(0, 2)
    assert.equal(seeded.length, 2, 'the per-track assertions need two tracks')
    for (const [index, music] of seeded.entries()) {
      const mark = send({ type: 'enqueue', requestId: `seed-${index}`, payload: { platform: 'netease', musicId: music.id, mutationId: `likes-probe-${Date.now()}-${index}` } })
      await until(mark, 'enqueue.ack')
    }
    assert.ok(await awaitTrack(), 'the first seeded track must start')
    check('likes-seeded', {
      keyword, queued: seeded.map(music => music.id), nowPlaying: `${playing()?.music?.platform}:${playing()?.music?.id}`,
      queueLeft: (state()?.queue ?? []).length, isPaused: state()?.isPaused,
    })
  }
  const trackKey = music => `${music.platform}:${music.id}`
  check('likes-self-identity', { selfKnown: true, nowPlaying: trackKey(playing().music), likedCount: likedBy().length, selfLiked: likedBy().includes(self) })

  const rejected = await control('control.unlike', { positionMs: 0 })
  check('likes-payload-validation', { outcome: rejected.outcome, code: rejected.code })
  assert.equal(rejected.code, 'PAYLOAD_INVALID', 'the control.* payload whitelist must cover the new kind too')

  const first = await control('control.like')
  await until(first.mark, 'player.state')
  check('like-first', { outcome: first.outcome, selfInLikedUserIds: likedBy().includes(self), likedCount: likedBy().length })
  assert.equal(first.outcome, 'applied')
  assert.ok(likedBy().includes(self), 'likedUserIds must carry the caller own id so the UI can say "I liked this"')
  const second = await control('control.like')
  check('like-repeat', { outcome: second.outcome })
  assert.equal(second.outcome, 'noop', 'a second like from the same member is a noop')

  const afterLike = await likedList()
  check('liked-playlist-after-like', {
    systemKey: afterLike.row?.systemKey, name: afterLike.row?.name, trackCount: afterLike.row?.trackCount,
    listedKeys: afterLike.tracks?.join(','), insertionOrderMatches: afterLike.tracks?.[0] === trackKey(playing().music),
  })
  assert.ok(afterLike.row, 'the personal liked list must come back from playlist.list with its systemKey')
  assert.equal(afterLike.row.name, '喜欢的歌曲')
  assert.equal(afterLike.row.trackCount, 1, 'the like must have created the list and added exactly this track')
  assert.equal(afterLike.tracks[0], trackKey(playing().music), 'the mirrored row must be the track that was playing')

  if (seeded.length === 2) {
    const advanced = await control('control.next')
    await until(advanced.mark, 'player.state')
    const switched = playing()
    check('like-scoped-to-track', {
      outcome: advanced.outcome, nowPlaying: trackKey(switched.music), changedTrack: trackKey(switched.music) !== trackKey(seeded[0]),
      likedCountOnNewTrack: likedBy().length, personalListKeepsPreviousLike: (await likedList()).row?.trackCount,
    })
    assert.notEqual(trackKey(switched.music), trackKey(seeded[0]), 'the walk forward must land on the second seeded track')
    assert.equal(likedBy().length, 0, 'a like describes the track that was playing, so the new track starts empty')
    assert.equal((await likedList()).row.trackCount, 1, 'withdrawing visibility on a new track must not delete the personal row')
    const secondLike = await control('control.like')
    await until(secondLike.mark, 'player.state')
    const both = await likedList()
    check('like-second-track', { outcome: secondLike.outcome, trackCount: both.row?.trackCount, listedKeys: both.tracks?.join(',') })
    assert.equal(secondLike.outcome, 'applied')
    assert.equal(both.row.trackCount, 2, 'liking a different track appends instead of replacing')
    assert.deepEqual(both.tracks, [`${seeded[0].platform}:${seeded[0].id}`, trackKey(switched.music)], 'insertion order is kept')
  }

  const unlike = await control('control.unlike')
  await until(unlike.mark, 'player.state')
  const afterUnlike = await likedList()
  check('unlike-first', {
    outcome: unlike.outcome, selfInLikedUserIds: likedBy().includes(self), likedCount: likedBy().length,
    trackCount: afterUnlike.row?.trackCount, listedKeys: afterUnlike.tracks?.join(','),
  })
  assert.equal(unlike.outcome, 'applied')
  assert.ok(!likedBy().includes(self), 'unlike must withdraw only the callers like')
  assert.equal(afterUnlike.row.trackCount, seeded.length === 2 ? 1 : 0, 'unlike must remove exactly the track that was playing')

  const after = await control('control.unlike')
  const final = await likedList()
  check('unlike-repeat-and-list', { repeatOutcome: after.outcome, trackCount: final.row?.trackCount, listSurvives: final.row !== undefined })
  assert.equal(after.outcome, 'noop', 'canceling twice is as safe as liking twice')
  assert.notEqual(final.row, undefined, 'the list itself survives even when it is empty')

  if (seeded.length === 2) {
    // features.likedSongsEdit: this leftover row belongs to a track that is no longer
    // playing, so `control.unlike` cannot reach it any more — the playlist is the exit.
    const rows = await likedListRows(final.row.id)
    const stranded = rows[0]
    const removed = await removeLiked(final.row.id, stranded?.id, `likes-probe-remove-${Date.now()}`)
    const afterRemove = await likedList()
    check('liked-songs-edit', {
      operation: removed.operation, removedCount: removed.removedCount, rowsBefore: rows.length,
      trackCount: afterRemove.row?.trackCount, strandedWasSeededTrack: stranded ? trackKey(stranded.music) === trackKey(seeded[0]) : false,
    })
    assert.equal(removed.operation, 'remove-items', 'removing a liked row must be an ack, not SYSTEM_READONLY')
    assert.equal(removed.removedCount, 1)
    assert.equal(afterRemove.row.trackCount, 0, 'the row that unlike could no longer reach must be removable from the list')
    const renameMark = send({ type: 'playlist.rename', payload: { scope: 'user', playlistId: final.row.id, name: '不该改得动', mutationId: `likes-probe-rename-${Date.now()}` } })
    const renameNack = await until(renameMark, 'playlist.nack')
    check('liked-songs-still-system', { reason: renameNack.payload?.reason })
    assert.equal(renameNack.payload?.reason, 'SYSTEM_READONLY', 'renaming or deleting the system list itself stays refused')
  }

  if (seeded.length === 2) {
    const last = await control('control.next')
    await until(last.mark, 'player.state')
    check('likes-cleanup', { outcome: last.outcome, nowPlaying: playing() ? trackKey(playing().music) : null, queueLeft: (state()?.queue ?? []).length, isPaused: state()?.isPaused })
    const historyMark = send({ type: 'history.list', requestId: 'history-after', payload: { offset: 0, limit: 1 } })
    const page = (await until(historyMark, 'history.page')).payload
    check('likes-history-residue', { total: page?.total, newest: page?.items?.[0] ? trackKey(page.items[0].music) : null })
  }
  socket.terminate(); await once(socket, 'close').catch(() => {})
  console.log('STACK_LIKES_ACCEPTANCE_OK ' + JSON.stringify({ seeded: seeded.length, checks: results.map(item => item.check) }))
}

main().catch(error => { console.error(`STACK_LIKES_ACCEPTANCE_FAILED ${String(error?.message ?? error).slice(0, 300)}`); process.exitCode = 1 })
