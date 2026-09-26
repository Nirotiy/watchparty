import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../shared/yrc.ts', import.meta.url), 'utf8')
const { parseYrc, pairByTime } = await import(`data:text/javascript;base64,${Buffer.from(ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })).toString('base64')}`)

test('YRC rows keep per-word segments and zero-duration punctuation', () => {
  const lines = parseYrc('[0,2400](0,300,0)你(300,0,0)，(300,400,0)好(700,0,0)！(700,1700,0)世界\n[2400,1500](2400,1500,0)下一行')
  assert.equal(lines.length, 2)
  assert.deepEqual(lines[0].segments.map(segment => segment.text), ['你', '，', '好', '！', '世界'])
  assert.deepEqual(lines[0].segments.map(segment => [segment.start, segment.end]), [[0, 300], [300, 300], [300, 700], [700, 700], [700, 2400]])
  assert.equal(lines[0].text, '你，好！世界')
  assert.equal(lines[1].start, 2400)
  assert.equal(lines[1].end, 3900)
})

test('plain LRC rows are accepted as whole-line entries', () => {
  const lines = parseYrc('[00:03.580]译文\n[00:10.000]第二行\n{ "t": 0, "c": [{ "tx": "credit" }] }')
  assert.deepEqual(lines.map(line => [line.start, line.text]), [[3580, '译文'], [10000, '第二行']])
  assert.equal(lines[0].segments.length, 1)
})

test('the extra track pairs by time window, never by line count', () => {
  const main = parseYrc('[0,1000](0,1000,0)one\n[4000,1000](4000,1000,0)two\n[8000,1000](8000,1000,0)three')
  const extra = parseYrc('[00:00.500]壹\n[00:04.200]贰 + 贰续\n[00:12.400]末尾补丁')
  assert.deepEqual(pairByTime(main, extra), ['壹', '贰 + 贰续', '末尾补丁'])
})

test('lines sort by start time and empty input stays empty', () => {
  assert.deepEqual(parseYrc(''), [])
  assert.deepEqual(parseYrc(null), [])
  const lines = parseYrc('[5000,1000](5000,1000,0)later\n[1000,1000](1000,1000,0)earlier')
  assert.deepEqual(lines.map(line => line.text), ['earlier', 'later'])
})
