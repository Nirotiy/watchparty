// Read-only comparison of the legacy REST rewrite and the backend response.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const read = origin => {
  const output = execFileSync('curl.exe', ['--noproxy', '*', '--silent', '--show-error', '--fail', `${origin}/api/media/libraries`], { encoding: 'utf8' })
  return JSON.parse(output)
}
const backend = read('http://127.0.0.1:8080')
const web = read('http://127.0.0.1:3000')
assert.deepEqual(web, backend, 'Next REST fallback must preserve media libraries JSON')
const digest = createHash('sha256').update(JSON.stringify(backend)).digest('hex')
console.log(JSON.stringify({ check: 'WEB_MEDIA_PROXY_EQUAL', at: new Date().toISOString(), web: ':3000/api/media/libraries', backend: ':8080/api/media/libraries', equal: true, sha256: digest }))
