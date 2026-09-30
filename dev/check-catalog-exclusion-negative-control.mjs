// Mutate a disposable source copy, never the shared worktree or a live database.
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = await mkdtemp(path.resolve('temp-html/exclusion-negative-'))
try {
  await cp('server', path.join(root, 'server'), { recursive: true })
  const target = path.join(root, 'server/media/catalog-store.ts')
  const original = await readFile(target, 'utf8')
  const needle = 'return this.readScan(libraryId).filter(file => !excluded.has(file.relativePath));'
  assert.equal(original.split(needle).length - 1, 1, 'mutation must match exactly one filter')
  await writeFile(target, original.replace(needle, 'return this.readScan(libraryId);'))
  const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=排除标记保留扫描事实', path.join(root, 'server/test/catalog-edit.test.ts')], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 1, 'removed exclusion filter must fail the real regression test')
  assert.ok((result.stdout + result.stderr).includes('2 !== 1'), 'negative control must fail on the unfiltered file count')
  console.log('CATALOG_EXCLUSION_NEGATIVE_CONTROL_OK removed-filter mutation rejected by real test')
} finally { await rm(root, { recursive: true, force: true }) }
