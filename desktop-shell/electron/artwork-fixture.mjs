/**
 * Fixture OpenList for phase-2 artwork: a folder that holds **both** a poster.jpg and
 * video files. The real library has no such folder (its one poster folder, 偶像大师 (2011),
 * holds only images and nfo), so the file-card thumbnail path cannot be seen or asserted
 * anywhere else. Serves just enough of the OpenList API for the backend client:
 *
 *   POST /api/auth/login · POST /api/fs/list · POST /api/fs/get · GET /raw/<name>
 *
 *   node electron/artwork-fixture.mjs start    # foreground; registers the source, prints ids
 *   node electron/artwork-fixture.mjs delete    # removes the source (also runs on start)
 *
 * Then `node electron/launch.mjs --media-check` picks it up: the harness's artwork-card
 * step runs only while a library named `Fixture` is present.
 *
 * Poster bytes are read once from the real library through the backend (read-only) and
 * cached in the temp dir, so this never writes to anyone's storage.
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mode = process.argv[2] ?? 'start'
const PORT = Number(process.env.WP_FIXTURE_PORT ?? 19092)
const BACKEND = process.env.WP_FIXTURE_BACKEND ?? 'http://127.0.0.1:8080'
const SOURCE_NAME = 'Artwork fixture'
const LIBRARY_NAME = 'Fixture'
const ROOT = '/media/Fixture'
const posterFile = join(tmpdir(), 'wp-fixture-poster.jpg')

async function deleteSource() {
  const list = await (await fetch(`${BACKEND}/api/admin/media-sources`)).json()
  for (const source of (list.sources ?? []).filter(entry => entry.name === SOURCE_NAME)) {
    const response = await fetch(`${BACKEND}/api/admin/media-sources/${source.id}`, { method: 'DELETE' })
    console.log('DELETED', source.id, response.status)
  }
}

if (mode === 'delete') {
  await deleteSource()
  process.exit(0)
}

async function posterBytes() {
  if (existsSync(posterFile)) return readFileSync(posterFile)
  const root = await (await fetch(`${BACKEND}/api/media/list?libraryId=lib_anime&path=%2F`)).json()
  const folder = (root.items ?? []).find(item => item.type === 'dir' && item.name.includes('偶像大师'))
  if (!folder) throw new Error('real poster folder not found; list the Anime library first')
  const inside = await (await fetch(`${BACKEND}/api/media/list?libraryId=lib_anime&path=${encodeURIComponent(folder.relativePath)}`)).json()
  const image = await fetch(`${BACKEND}/api/media/artwork/${encodeURIComponent(inside.posterId)}`)
  const bytes = Buffer.from(await image.arrayBuffer())
  writeFileSync(posterFile, bytes)
  console.log('POSTER_BYTES', image.headers.get('content-type'), bytes.byteLength)
  return bytes
}

const poster = await posterBytes()
const VIDEO = Buffer.alloc(1024, 7)
const ENTRIES = [
  { name: 'poster.jpg', is_dir: false, size: poster.length },
  { name: `${LIBRARY_NAME}.Movie.2024.mkv`, is_dir: false, size: VIDEO.length },
  { name: 'Season 01', is_dir: true, size: 0 },
]

function json(response, payload) {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/raw/poster.jpg') {
    response.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': poster.length })
    response.end(poster)
    return
  }
  if (request.method === 'GET' && url.pathname === '/raw/video') {
    response.writeHead(200, { 'content-type': 'video/x-matroska', 'content-length': VIDEO.length })
    response.end(VIDEO)
    return
  }
  if (request.method !== 'POST') return json(response, { code: 404, message: 'not found' })
  const text = await new Promise(resolve => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => resolve(body || '{}'))
  })
  const body = JSON.parse(text)
  if (url.pathname === '/api/auth/login') return json(response, { code: 200, data: { token: 'fixture-token' } })
  if (url.pathname === '/api/fs/list') {
    const path = String(body.path ?? '')
    return json(response, { code: 200, data: { content: path === ROOT || path === '/' ? ENTRIES : [] } })
  }
  if (url.pathname === '/api/fs/get') {
    const path = String(body.path ?? '')
    if (path.endsWith('poster.jpg')) return json(response, { code: 200, data: { raw_url: `http://127.0.0.1:${PORT}/raw/poster.jpg`, size: poster.length } })
    if (path.endsWith('.mkv')) return json(response, { code: 200, data: { raw_url: `http://127.0.0.1:${PORT}/raw/video`, size: VIDEO.length } })
    return json(response, { code: 404, message: 'no such file' })
  }
  if (url.pathname === '/api/fs/search') return json(response, { code: 200, data: { content: [] } })
  if (url.pathname === '/api/fs/link') return json(response, { code: 200, data: { url: `http://127.0.0.1:${PORT}/raw/video` } })
  return json(response, { code: 404, message: 'unknown endpoint' })
})

server.listen(PORT, '127.0.0.1', async () => {
  console.log('FIXTURE_LISTENING', PORT)
  await deleteSource()
  const created = await fetch(`${BACKEND}/api/admin/media-sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: SOURCE_NAME,
      internalBaseUrl: `http://127.0.0.1:${PORT}`,
      publicBaseUrl: `http://127.0.0.1:${PORT}`,
      username: 'fixture',
      password: 'fixture',
      libraries: [{ name: LIBRARY_NAME, kind: 'movie', path: ROOT }],
    }),
  })
  const created_body = await created.json()
  console.log('SOURCE', created.status, JSON.stringify(created_body.libraries?.map(library => [library.id, library.name]) ?? created_body.code))
})
