// Live-stack (18380) acceptance for the desktop album routes with a throwaway guest session only:
// no admin credentials, no .env, no cookie value is ever printed. It reads the real netease
// upstream, so the totals and the paging offsets it reports are measured, not asserted from memory.
const { setTimeout: delay } = require('node:timers/promises')
const assert = require('node:assert/strict')

const origin = process.env.LINKLE_STACK_ORIGIN ?? 'http://127.0.0.1:18380'
const results = []
const check = (label, detail) => { results.push({ check: label, ...detail }); console.log(JSON.stringify({ check: label, ...detail })) }

async function call(path, { cookie = '', desktop = true } = {}) {
  const headers = { Accept: 'application/json' }
  if (desktop) { headers['X-Desktop-API-Version'] = '2026-01'; headers['X-Desktop-Client-Version'] = '0.2.0' }
  if (cookie) headers.Cookie = cookie
  const response = await fetch(origin + path, { headers, redirect: 'manual' })
  return { status: response.status, value: await response.json().catch(() => null) }
}

async function main() {
  const capabilities = await call('/api/desktop/v1/capabilities')
  assert.equal(capabilities.status, 200)
  check('album-capabilities', {
    feature: capabilities.value.features?.albumSearch === true,
    providers: capabilities.value.albumSearchProviders ?? null,
    configured: capabilities.value.providers,
  })
  assert.equal(capabilities.value.features.albumSearch, true, 'the deployed build must advertise the album endpoints')
  assert.equal(capabilities.value.albumSearchProviders.netease, true, 'netease must answer album queries')
  assert.equal(capabilities.value.albumSearchProviders.bilibili, false, 'bilibili has no albums and must say so')

  const guest = await fetch(`${origin}/api/account/guest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: 'album 探针' }),
  })
  assert.equal(guest.status, 200)
  const cookie = (await guest.headers.getSetCookie()).filter(entry => /^(MP_SESSION|MP_CSRF)=/.test(entry)).map(entry => entry.split(';')[0]).join('; ')
  assert.ok(/MP_SESSION=/.test(cookie), 'no session cookie issued')

  // Gate order and argument validation run before any upstream call.
  assert.equal((await call('/api/desktop/v1/albums/netease?q=zhou', { desktop: false })).status, 426)
  assert.equal((await call('/api/desktop/v1/albums/netease?q=zhou')).status, 401, 'anonymous must be refused')
  assert.equal((await call('/api/desktop/v1/albums/netease', { cookie })).status, 400, 'an empty keyword never reaches a provider')
  assert.equal((await call('/api/desktop/v1/albums/netease?q=zhou&limit=0', { cookie })).status, 400)
  check('album-guards', { withoutVersionHeader: 426, anonymous: 401, emptyKeyword: 400, zeroLimit: 400 })

  const first = await call(`/api/desktop/v1/albums/netease?q=${encodeURIComponent('周杰伦')}&offset=0&limit=5`, { cookie })
  assert.equal(first.status, 200, JSON.stringify(first.value))
  const ids = (first.value.items ?? []).map(item => item.id)
  check('album-first-page', {
    status: first.status, returned: ids.length, offset: first.value.offset, limit: first.value.limit, total: first.value.total,
    keys: ids.length > 0 ? Object.keys(first.value.items[0]).sort().join(',') : '',
    uniqueIds: new Set(ids).size,
  })
  assert.ok(first.value.total > 0, 'netease reports a real whole-session count')
  assert.ok(ids.length > 0 && ids.length <= 5)
  assert.equal(first.value.offset, 0)
  assert.equal(first.value.limit, 5)
  assert.equal(Object.keys(first.value.items[0]).sort().join(','), 'coverUrl,id,name,platform,trackCount,artistName'.split(',').sort().join(','), 'the album DTO must be the web shape')

  const second = await call(`/api/desktop/v1/albums/netease?q=${encodeURIComponent('周杰伦')}&offset=5&limit=5`, { cookie })
  assert.equal(second.status, 200)
  const secondIds = (second.value.items ?? []).map(item => item.id)
  const overlap = ids.filter(id => secondIds.includes(id))
  assert.equal(overlap.length, 0, 'offset must actually move the window; the old bug was page 2 repeating page 1')
  assert.equal(second.value.total, first.value.total, 'the count is about the whole match set, not one page')
  check('album-second-page', { returned: secondIds.length, overlappingIds: overlap.length, totalStable: second.value.total === first.value.total })

  const albumId = ids[0]
  const songs = await call(`/api/desktop/v1/albums/netease/${encodeURIComponent(albumId)}/songs`, { cookie })
  assert.equal(songs.status, 200, JSON.stringify(songs.value))
  assert.ok(Array.isArray(songs.value.items) && songs.value.items.length > 0, 'an album must expand into tracks')
  assert.equal(songs.value.total, songs.value.items.length, 'the album track list is unpaged: total is its whole size')
  check('album-songs', {
    tracks: songs.value.items.length, total: songs.value.total,
    keys: Object.keys(songs.value.items[0]).sort().join(','),
    platform: songs.value.items[0].platform,
  })

  const unavailable = await call('/api/desktop/v1/albums/bilibili?q=zhou&limit=5', { cookie })
  assert.equal(unavailable.status, 200, 'a configured provider without albums answers an empty page, not an error')
  assert.equal(Array.isArray(unavailable.value.items) && unavailable.value.items.length, 0)
  check('album-provider-without-albums', { status: unavailable.status, items: unavailable.value.items.length, total: unavailable.value.total })

  console.log('STACK_ALBUM_ACCEPTANCE_OK ' + JSON.stringify({ checks: results.map(result => result.check) }))
  await delay(50)
}

main().catch(error => { console.error(`STACK_ALBUM_ACCEPTANCE_FAILED ${String(error?.message ?? error).slice(0, 300)}`); process.exitCode = 1 })
