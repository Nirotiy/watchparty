// Isolated writes only; preserve the live catalog and never read approval secrets.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = path.resolve(`D:/WatchParty-Diagnostics/media-clean-${stamp}`);
const logPath = path.resolve('temp-html/catalog-exclusion-media-clean.log');
const resultPath = path.resolve('temp-html/catalog-exclusion-media-clean.json');
await mkdir(path.join(root, 'temp'), { recursive: true });
const env = { ...process.env, TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'), NO_PROXY: '127.0.0.1,localhost,::1', NODE_USE_ENV_PROXY: '1', WATCHPARTY_MEDIA_CHECK_ORIGIN: 'http://127.0.0.1:8102' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WATCHPARTY_MEDIA_CHECK_REVIEW;
delete env.WATCHPARTY_MEDIA_CHECK_APPROVAL_FILE;
function summary(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('BEGIN');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const hash = createHash('sha256');
    for (const { name } of tables) {
      const escaped = name.replaceAll('"', '""');
      hash.update(JSON.stringify({ name, rows: db.prepare(`SELECT * FROM "${escaped}"`).all() }));
    }
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    db.exec('COMMIT');
    return { digest: hash.digest('hex'), integrity };
  } finally { db.close(); }
}
const livePaths = ['data/watchparty-catalog.sqlite', 'data/watchparty-library.sqlite'];
const before = livePaths.map(summary);
const startedAt = new Date().toISOString();
const backend = spawn(process.execPath, ['dev/iso-catalog-instance.mjs', '--port=8102', `--root=${root}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let backendOutput = '';
backend.stdout.on('data', data => { backendOutput += data.toString(); });
backend.stderr.resume();
let electron;
let output = '';
let timedOut = false;
try {
  for (let i = 0; i < 120 && !backendOutput.includes('ISO_LISTENING'); i++) {
    assert.equal(backend.exitCode, null, 'isolated backend exited before ready');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(backendOutput.includes('ISO_LISTENING'), 'isolated backend did not become ready');
  const copyBefore = ['watchparty-catalog.sqlite', 'watchparty-library.sqlite'].map(file => summary(path.join(root, 'data', file)));
  assert.ok(copyBefore.every(x => x.integrity === 'ok'));
  electron = spawn('D:/WatchParty-Diagnostics/electron-runtime/electron.exe', [path.resolve('desktop-shell/electron'), '--media-check'], { cwd: path.resolve('.'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  electron.stdout.on('data', data => { output += data.toString(); });
  electron.stderr.on('data', data => { output += data.toString(); });
  const timeout = setTimeout(() => { timedOut = true; electron.kill(); }, 480000);
  const exitCode = await new Promise((resolve, reject) => { electron.once('close', resolve); electron.once('error', reject); });
  clearTimeout(timeout);
  await writeFile(logPath, output);
  const steps = output.split(/\r?\n/).filter(line => line.startsWith('MEDIA_CHECK_STEP ')).map(line => JSON.parse(line.slice('MEDIA_CHECK_STEP '.length)));
  const marker = output.split(/\r?\n/).includes('ELECTRON_MEDIA_CHECK_OK');
  const after = livePaths.map(summary);
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  const copyAfter = ['watchparty-catalog.sqlite', 'watchparty-library.sqlite'].map(file => summary(path.join(root, 'data', file)));
  const passed = exitCode === 0 && !timedOut && marker && steps.length > 0 && steps.every(step => step.ok === true) && unchanged && copyAfter.every(x => x.integrity === 'ok');
  const result = { startedAt, finishedAt: new Date().toISOString(), passed, exitCode, timedOut, marker, steps, origin: env.WATCHPARTY_MEDIA_CHECK_ORIGIN, root, before, after, liveUnchanged: unchanged, copyBefore, copyAfter };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  await writeFile(path.join(root, 'MANIFEST.txt'), `VACUUM INTO snapshots by iso-catalog-instance.mjs\n${JSON.stringify({ copyBefore, copyAfter, liveUnchanged: unchanged }, null, 2)}\nValidation copy is not a production rollback backup.\n`);
  console.log(JSON.stringify({ passed, exitCode, marker, steps: steps.length, liveUnchanged: unchanged, resultPath }));
  assert.ok(passed, 'clean media gate failed; see recorded result');
} finally {
  if (electron && electron.exitCode === null) electron.kill();
  backend.kill();
  if (backend.exitCode === null) await new Promise(resolve => backend.once('exit', resolve));
}
