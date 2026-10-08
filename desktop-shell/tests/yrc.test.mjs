import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../shared/yrc.ts', import.meta.url), 'utf8')
const { parseYrc, pairByTime, pairLyricExtras } = await import(`data:text/javascript;base64,${Buffer.from(ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })).toString('base64')}`)

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
  assert.deepEqual(pairByTime(main, extra), ['壹', '贰 + 贰续', ''])
})

test('lines sort by start time and empty input stays empty', () => {
  assert.deepEqual(parseYrc(''), [])
  assert.deepEqual(parseYrc(null), [])
  const lines = parseYrc('[5000,1000](5000,1000,0)later\n[1000,1000](1000,1000,0)earlier')
  assert.deepEqual(lines.map(line => line.text), ['earlier', 'later'])
})

test('small early timestamps belong to the next onset, and distant extras stay unpaired', () => {
  const main = parseYrc('[1000,3000]first\n[4000,2000]second')
  assert.deepEqual(pairByTime(main, parseYrc('[00:03.990]second translation\n[00:12.000]unrelated')), ['', 'second translation'])
})

test('an exact onset wins over an overlapping earlier line', () => {
  const main = parseYrc('[1000,10000]first\n[4000,2000]second')
  assert.deepEqual(pairByTime(main, parseYrc('[00:04.000]second translation')), ['', 'second translation'])
})

// NetEase 1850706852, Secret (Your Fire): legacy and word tracks have different timestamps.
const secretMain = '[134220,3060]You\'re like just what I like\n[138660,2040]Make another friend\n[142440,1350]You think you know me'
const secretLegacy = '[02:14.363]You\'re like just what I like\n[02:18.648]Make another friend\n[02:22.046]You think you know me'
const secretTranslated = '[02:14.363]你正合我心意\n[02:18.648]结识新友吧\n[02:22.046]你自以为了解我'

test('Secret translations prefer the word track and fill only its missing rows from legacy anchors', () => {
  const wordTranslated = '[02:14.220]逐字译文\n[02:22.440]你自以为了解我'
  assert.deepEqual(pairLyricExtras(parseYrc(secretMain), wordTranslated, secretLegacy, secretTranslated), ['逐字译文', '结识新友吧', '你自以为了解我'])
  assert.deepEqual(pairLyricExtras(parseYrc(secretMain), '', secretLegacy, secretTranslated), ['你正合我心意', '结识新友吧', '你自以为了解我'])
})

test('legacy fallback cannot move Sickness onto an untranslated La line', () => {
  const main = parseYrc('[174120,2820]La la la la la\n[177510,2100]Sickness')
  const legacy = '[02:54.186]La la la la la\n[02:57.497]Sickness'
  const extra = '[02:57.497]病态'
  assert.deepEqual(pairLyricExtras(main, '[02:57.510]病态', legacy, extra), ['', '病态'])
})

test('legacy text anchors handle large timing differences and repeated choruses without row indexing', () => {
  const main = parseYrc('[1000,1000]HELLO!\n[2000,1000]unmatched\n[20000,1000]Hello\n[30000,1000]Final line')
  const legacy = '[00:01.100]Hello\n[00:20.200]Hello\n[00:36.000]Final line'
  const extra = '[00:01.100]first\n[00:20.200]second\n[00:36.000]final'
  assert.deepEqual(pairLyricExtras(main, '', legacy, extra), ['first', '', 'second', 'final'])
})
