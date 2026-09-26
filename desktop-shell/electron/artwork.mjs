import { net } from 'electron'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

// Album art is the one asset the shell loads from a host that is not the MusicParty
// server. The renderer has no network access (CSP `connect-src 'none'`, `img-src
// 'self' data:`), so the bytes are fetched here and handed back as a data URL —
// which also keeps the canvas readable for palette extraction (a cross-origin
// <img> taints it and `getImageData` throws).
const MAX_BYTES = 6 * 1024 * 1024
const MAX_REDIRECTS = 3
const CACHE_LIMIT = 32
const cache = new Map()

function isLoopback(host) {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '')
  return value === 'localhost' || value === '0.0.0.0' || value === '::1' || value.startsWith('127.')
}

function isPrivateAddress(address) {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '')
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)
  if (mapped) return isPrivateAddress(mapped[1])
  if (isLoopback(value)) return true
  if (value.startsWith('fe80') || value.startsWith('fc') || value.startsWith('fd')) return true
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return false
  return parts[0] === 10
    || parts[0] === 169 && parts[1] === 254
    || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
    || parts[0] === 192 && parts[1] === 168
    || parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
}

/**
 * Covers come from public CDNs, so a host that resolves to the local network is
 * always a misconfiguration or an attack. Only the isolated acceptance profiles
 * talk to a loopback fixture.
 */
async function hostAllowed(hostname, allowLoopback) {
  if (!hostname) return false
  if (isIP(hostname)) return isLoopback(hostname) ? allowLoopback : !isPrivateAddress(hostname)
  if (isLoopback(hostname)) return allowLoopback
  try {
    const records = await lookup(hostname, { all: true })
    if (!records.length) return false
    return records.every(record => !isPrivateAddress(record.address) || allowLoopback && isLoopback(record.address))
  } catch { return false }
}

function validate(candidate) {
  let url
  try { url = new URL(candidate) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if (candidate.length > 2048) return null
  return url
}

/** Follows redirects by hand so every hop is validated against the same host policy. */
async function load(url, allowLoopback, redirects = 0) {
  if (redirects > MAX_REDIRECTS) throw new Error('artwork_redirect_limit')
  if (!await hostAllowed(url.hostname, allowLoopback)) throw new Error('artwork_host_rejected')
  const response = await net.fetch(url.href, { redirect: 'manual', bypassCustomProtocolHandlers: true })
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    const next = location ? validate(new URL(location, url).href) : null
    if (!next) throw new Error('artwork_redirect_invalid')
    return load(next, allowLoopback, redirects + 1)
  }
  if (!response.ok) throw new Error(`artwork_status_${response.status}`)
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!type.startsWith('image/')) throw new Error('artwork_not_an_image')
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_BYTES) throw new Error('artwork_too_large')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!buffer.byteLength) throw new Error('artwork_empty')
  if (buffer.byteLength > MAX_BYTES) throw new Error('artwork_too_large')
  return `data:${type};base64,${buffer.toString('base64')}`
}

export async function fetchArtworkImage(candidate, options = {}) {
  const allowLoopback = options.allowLoopback === true
  const cached = cache.get(candidate)
  if (cached !== undefined) return cached
  const url = validate(candidate)
  if (!url) throw new Error('artwork_url_rejected')
  const dataUrl = await load(url, allowLoopback)
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
  cache.set(candidate, dataUrl)
  return dataUrl
}
