import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const packageName = 'WatchParty-Electron-20260930T112500Z';
const packageRoot = `D:/WatchParty-Diagnostics/${packageName}`;
const runtime = 'D:/WatchParty-Diagnostics/electron-runtime/electron.exe';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const temp = `D:/WatchParty-Diagnostics/linkle-final-${stamp}`;
await mkdir(temp, { recursive: true });
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const sidecarFiles = ['src-tauri/target/debug/watchparty-native-sidecar.exe', 'desktop-shell/electron/native/watchparty-native-sidecar.exe', `artifacts/electron-local/${packageName}/resources/app/electron/native/watchparty-native-sidecar.exe`, `${packageRoot}/resources/app/electron/native/watchparty-native-sidecar.exe`];
async function sidecars() { return Object.fromEntries(await Promise.all(sidecarFiles.map(async file => [file, await hash(file)]))); }
async function tree(folder, prefix = '') {
  const files = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await tree(path.join(folder, entry.name), relative + '/'));
    else files.push(relative);
  }
  return files.sort();
}
const renderer = await tree('desktop-shell/dist-electron');
const appFiles = ['main.mjs', 'preload-built.cjs', 'policy.cjs', 'sidecar-client.mjs', 'smoke.mjs', 'wallpaper.mjs', 'artwork.mjs'];
const equivalence = await Promise.all([
  ...renderer.map(async file => ({ file: `dist-electron/${file}`, dev: await hash(`desktop-shell/dist-electron/${file}`), packaged: await hash(`${packageRoot}/resources/app/dist-electron/${file}`) })),
  ...appFiles.map(async file => ({ file: `electron/${file}`, dev: await hash(`desktop-shell/electron/${file}`), packaged: await hash(`${packageRoot}/resources/app/electron/${file}`) })),
  (async () => ({ file: 'electron.exe', dev: await hash(runtime), packaged: await hash(`${packageRoot}/${packageName}.exe`) }))(),
]);
assert.ok(equivalence.every(file => file.dev === file.packaged), 'development app differs from final package');
const before = await sidecars();
assert.ok(Object.values(before).every(value => value === 'de2ca22ed971ff3702414b87bef7a66a8b3bfc620122b281d56ee4aa143b2c70'));
const env = { ...process.env, TEMP: temp, TMP: temp, NO_PROXY: '127.0.0.1,localhost,::1' };
for (const name of Object.keys(env)) if (/^(http_proxy|https_proxy|all_proxy|electron_run_as_node|watchparty_catalog_approval_secret)$/i.test(name)) delete env[name];
const command = [runtime, path.resolve('desktop-shell/electron'), '--linkle-check'];
const startedAt = new Date().toISOString();
const child = spawn(command[0], command.slice(1), { env, cwd: path.resolve('.'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', data => { output += data.toString(); });
child.stderr.on('data', data => { output += data.toString(); });
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 480000);
let exitCode;
try { exitCode = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }); }
finally { clearTimeout(timeout); }
await writeFile('temp-html/catalog-exclusion-linkle-final.log', output);
const after = await sidecars();
const markers = ['LINKLE_ONE_SCREEN_CHECKS_OK', 'ELECTRON_NATIVE_SMOKE_OK'].filter(marker => output.split(/\r?\n/).includes(marker));
const stable = JSON.stringify(before) === JSON.stringify(after);
const passed = exitCode === 0 && !timedOut && markers.length === 2 && stable;
const result = {
  validated: 'linkle-check', decidedBy: 'GPT-6.1-Sol / Codex harness; user authorized replacement run',
  package: packageRoot, startedAt, finishedAt: new Date().toISOString(), command, exitCode, timedOut, passed,
  runCount: 1, sidecarSha256: { before, after, stable }, rendererEquivalence: equivalence, markers,
  watchpartyHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  evidencePaths: { log: path.resolve('temp-html/catalog-exclusion-linkle-final.log'), generatedArtifacts: temp },
  coverage: 'Development harness with external Electron runtime; renderer, main, preload and sidecar byte-equivalent to final external package; isolated Go service. Does not replace package-smoke or prove audible output.',
};
await writeFile('temp-html/catalog-exclusion-linkle-final.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ passed, exitCode, markers, sidecarStable: stable }));
assert.ok(passed, 'Linkle gate failed; see recorded evidence');
await writeFile(`${packageRoot}/validation-linkle-check.json`, JSON.stringify(result, null, 2), { flag: 'wx' });
await writeFile(`artifacts/electron-local/${packageName}/validation-linkle-check.json`, JSON.stringify(result, null, 2), { flag: 'wx' });
