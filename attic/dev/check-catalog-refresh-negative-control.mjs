// Mutate a temporary copy, never the shared source. The stale-result assertion must turn red.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = await mkdtemp(path.join(os.tmpdir(), 'catalog-refresh-control-'))
try {
  const source = await readFile('desktop-shell/shared/catalog-refresh.ts', 'utf8')
  const changed = source.replace('if (advanced(current, before)) return current', 'return current')
  assert.ok(changed !== source, 'negative control mutation did not apply')
  const module = path.join(root, 'catalog-refresh.ts')
  await writeFile(module, changed)
  const original = await readFile('desktop-shell/tests/catalog-refresh.test.mjs', 'utf8')
  const test = original.replace('../shared/catalog-refresh.ts', pathToFileURL(module).href)
  const target = path.join(root, 'control.test.mjs')
  await writeFile(target, test)
  const child = spawn(process.execPath, ['--test', target], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject) })
  assert.ok(code !== 0 && output.includes('结果'), 'stale-result defect escaped the negative control')
  console.log('CATALOG_REFRESH_NEGATIVE_CONTROL_OK stale-result mutation rejected')
} finally { await rm(root, { recursive: true, force: true }) }
