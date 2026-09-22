import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/lib/ipc.ts', import.meta.url), 'utf8')
const js = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 })
const exports = {}
vm.runInNewContext(js, { exports, URL, require: () => ({}) })
const { backendAddressError } = exports

test('local management origins show an actionable backend port error', () => {
  for (const origin of ['http://127.0.0.1:18083', 'https://localhost:18083/', ' http://LOCALHOST:18083 ', 'http://[::1]:18083']) {
    assert.match(backendAddressError(origin), /18083.*管理网页.*18082/)
  }
})

test('remote ports and valid local backend origins are not assumed to be management websites', () => {
  for (const origin of ['http://127.0.0.1:18082', 'https://example.com:18083', 'http://localhost.example.com:18083', 'http://192.168.1.20:18083', '', 'not a URL']) {
    assert.equal(backendAddressError(origin), undefined)
  }
})
