// Two real Chrome profiles, one isolated Next room. No production or OpenList calls.
// node web/tests/helpers/mkv-dual-client-acceptance.mjs <evidence.json>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const backend = "http://127.0.0.1:18981";
const origin = "http://127.0.0.1:18982";
const output = process.argv[2] ?? path.join(tmpdir(), "next-mkv-dual.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const result = { startedAt: new Date().toISOString(), scope: "presented-frame PTS, not physical scanout", checks: [], segments: [] };
const clients = [];
const fixture = await (await fetch(`${backend}/__fixture`)).json();
const roomUrl = `${origin}/room/${fixture.room.roomId}`;
async function command(event, payload = {}) {
  const response = await (await fetch(`${backend}/__fixture/command`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, payload }) })).json();
  assert.equal(response.ok, true, JSON.stringify(response));
}
async function startClient(name, left) {
  const profile = await mkdtemp(path.join(tmpdir(), `next-mkv-dual-${name}-`));
  const clientId = crypto.randomUUID();
  const process = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    `--window-position=${left},-1440`, "--window-size=1280,900", "about:blank",
  ], { stdio: "ignore" });
  const client = { name, profile, process, clientId };
  clients.push(client);
  let port;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { await sleep(250); }
  }
  assert.ok(port, `${name} Chrome port`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  client.ws = ws;
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  client.send = (method, params = {}) => new Promise((resolve, reject) => {
    const current = ++id;
    const timeout = setTimeout(() => { pending.delete(current); reject(new Error(`${name} CDP timeout: ${method}`)); }, 15000);
    pending.set(current, { resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); } });
    ws.send(JSON.stringify({ id: current, method, params }));
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
    else waiting.resolve(message.result);
  };
  client.evaluate = async (expression) => {
    const value = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
    return value.result?.value;
  };
  await client.send("Page.enable");
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    // Next 开发工具指示器固定在视口左下角，会挡住房间底栏本机静音按钮的坐标点击；验收环境里隐藏它（生产构建没有这个元素）。
    const hideDevBadge=()=>{const style=document.createElement("style");style.textContent="nextjs-portal{display:none !important}";document.documentElement.appendChild(style);};
    if(document.documentElement)hideDevBadge();else addEventListener("DOMContentLoaded",hideDevBadge,{once:true});
    globalThis.__dualRig={errors:[],audio:[],cues:[],workers:[],frames:0};
    const rig=__dualRig, NativeAudio=AudioContext, NativeWorker=Worker;
    globalThis.AudioContext=class extends NativeAudio {constructor(...args){super(...args);rig.audio.push(this);}};
    globalThis.Worker=class extends NativeWorker {constructor(...args){super(...args);const entry={stopped:false};rig.workers.push(entry);
      const stop=this.terminate.bind(this);this.terminate=()=>{entry.stopped=true;stop();};}};
    const draw=CanvasRenderingContext2D.prototype.drawImage, text=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.drawImage=function(...args){rig.frames++;return draw.apply(this,args);};
    CanvasRenderingContext2D.prototype.fillText=function(value,...args){rig.cues.push({text:value,time:Number(this.canvas.dataset.mediaTime)});
      if(rig.cues.length>8)rig.cues.shift();return text.call(this,value,...args);};
    addEventListener('error',event=>rig.errors.push(event.message));
    addEventListener('unhandledrejection',event=>rig.errors.push(String(event.reason)));
    if(location.origin===${JSON.stringify(origin)}) {
      localStorage.setItem('watchparty_client_id',${JSON.stringify(clientId)});
      localStorage.setItem(${JSON.stringify(`token_${fixture.room.roomId}`)},${JSON.stringify(fixture.room.accessToken)});
    }
  })()` });
  await client.send("Page.navigate", { url: roomUrl });
  return client;
}
const snapshot = (client) => client.evaluate(`(() => {
  const canvas=document.querySelector('canvas[aria-label="MKV 视频"]');
  return {epoch:performance.timeOrigin+performance.now(),time:Number(canvas?.dataset.mediaTime??-1),
    rate:Number(canvas?.dataset.playbackRate??0),width:canvas?.width,frames:__dualRig.frames,
    audio:__dualRig.audio.map(context=>context.state),workers:__dualRig.workers.map(worker=>worker.stopped),
    cues:__dualRig.cues,errors:__dualRig.errors,clientId:localStorage.getItem('watchparty_client_id'),
    control:document.querySelector('button[aria-label="播放"],button[aria-label="暂停"]')?.getAttribute('aria-label'),
    connected:document.body.innerText.includes('已连接'),screen:{x:screenX,y:screenY},body:document.body.innerText.slice(0,500)};
})()`);
async function until(client, predicate, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await snapshot(client);
    if (value.errors.length) throw new Error(`${client.name}: ${value.errors.join(", ")}`);
    if (predicate(value)) { result.checks.push({ client: client.name, label, elapsedMs: Date.now() - start, value }); console.log(`${client.name}: ${label}`); return value; }
    await sleep(100);
  }
  throw new Error(`${client.name} ${label}: ${JSON.stringify(await snapshot(client))}`);
}
async function click(client, selector) {
  const box = await client.evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw Error('Control not found');
    const r=element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...box });
  await sleep(100);
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...box });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...box });
}
async function sampleSegment(label, seconds, playing, requireAudio = true) {
  const samples = [];
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    const [a, b] = await Promise.all(clients.map(snapshot));
    assert.ok(a.connected && b.connected, `${label}: both connected`);
    const epoch = Math.max(a.epoch, b.epoch);
    const timeA = a.time + (playing ? (epoch - a.epoch) / 1000 * a.rate : 0);
    const timeB = b.time + (playing ? (epoch - b.epoch) / 1000 * b.rate : 0);
    samples.push({ a, b, sampleSkewMs: Math.abs(a.epoch - b.epoch), gapMs: Math.abs(timeA - timeB) * 1000 });
    await sleep(100);
  }
  const sorted = samples.map((sample) => sample.gapMs).sort((a, b) => a - b);
  const first = samples[0];
  const last = samples.at(-1);
  const observedRates = ["a", "b"].map((key) =>
    (last[key].time - first[key].time) * 1000 / (last[key].epoch - first[key].epoch));
  const matchingCueSamples = samples.filter(({ a, b }) => {
    const cueA = a.cues.at(-1), cueB = b.cues.at(-1);
    return cueA && cueB && cueA.time >= first.a.time && cueB.time >= first.b.time
      && cueA.text === cueB.text && Math.abs(cueA.time - cueB.time) <= 0.1;
  }).length;
  const summary = { label, samples: samples.length, medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1), observedRates, matchingCueSamples,
    maxSamplingSkewMs: Math.max(...samples.map((sample) => sample.sampleSkewMs)) };
  result.segments.push({ ...summary, measurements: samples });
  console.log(JSON.stringify(summary));
  assert.ok(summary.p95Ms <= 100 && summary.maxMs <= 250, `${label}: sync outside tolerance ${JSON.stringify(summary)}`);
  for (const [index, key] of ["a", "b"].entries()) {
    assert.ok(Math.abs(observedRates[index] - (playing ? first[key].rate : 0)) <= 0.025,
      `${label}: ${key} did not advance at the expected rate`);
  }
  if (playing) assert.ok(matchingCueSamples > 0, `${label}: no matching newly rendered subtitle cues`);
  for (const sample of samples) {
    assert.deepEqual(sample.a.errors, []);
    assert.deepEqual(sample.b.errors, []);
    assert.equal(sample.a.control, playing ? "暂停" : "播放");
    assert.equal(sample.b.control, playing ? "暂停" : "播放");
    assert.equal(sample.a.rate, sample.b.rate);
    if (requireAudio) {
      assert.ok(sample.a.audio.includes("running"), `${label}: A audio context suspended`);
      assert.ok(sample.b.audio.includes("running"), `${label}: B audio context suspended`);
    }
  }
}
async function unlockAndResume(client, label) {
  const before = await (await fetch(`${backend}/__fixture`)).json();
  await click(client, 'button[aria-label="静音"]');
  await sleep(100);
  await click(client, 'button[aria-label="取消静音"]');
  await until(client, (s) => s.audio.includes("running"), `${label}-audio-unlocked`);
  const after = await (await fetch(`${backend}/__fixture`)).json();
  assert.equal(after.snapshot.revision, before.snapshot.revision, "local audio unlock must not send room commands");
  for (const peer of clients) await until(peer, (s) => s.control === "暂停", `${label}-playback-uninterrupted`);
  await sleep(1000);
}
try {
  await command("CMD:mediaSet");
  const a = await startClient("A", 0);
  const first = await until(a, (s) => s.width === 1920 && s.time === 0 && s.connected, "initial-paused-frame");
  assert.equal(first.screen.y, -1440);
  await click(a, 'button[aria-label="播放"]');
  await until(a, (s) => s.time >= 8 && s.audio.includes("running"), "playing-before-late-join");
  const b = await startClient("B", 1280);
  const joined = await until(b, (s) => s.width === 1920 && s.time > 8 && s.connected, "late-join-catches-up");
  assert.equal(joined.screen.y, -1440);
  assert.notEqual(first.clientId, joined.clientId, "independent identities");
  await sleep(1000);
  await sampleSegment("late-join-before-gesture-1x", 5, true, false);
  await unlockAndResume(b, "late-join");
  await sampleSegment("both-audio-running-1x", 8, true);
  await click(b, 'button[aria-label="暂停"]');
  await until(a, (s) => s.control === "播放", "B-pause-propagates-to-A");
  await sleep(500);
  await sampleSegment("paused", 2, false);
  await command("CMD:seek", { positionSeconds: 60 });
  for (const client of clients) await until(client, (s) => Math.abs(s.time - 60) < 0.1, "paused-seek-60");
  await sampleSegment("paused-seek", 2, false);
  for (const positionSeconds of [61, 60.5, 60]) {
    await command("CMD:seek", { positionSeconds });
    for (const client of clients) await until(client, (s) => Math.abs(s.time - positionSeconds) < 0.06, `paused-small-seek-${positionSeconds}`);
  }
  await click(a, 'button[aria-label="播放"]');
  await until(b, (s) => s.time > 61 && s.control === "暂停", "A-resume-propagates-to-B");
  await command("CMD:rate", { rate: 0.95 });
  for (const client of clients) await until(client, (s) => s.rate === 0.95, "running-rate-095");
  await sampleSegment("running-095", 8, true);
  await command("CMD:rate", { rate: 1.05 });
  for (const client of clients) await until(client, (s) => s.rate === 1.05, "running-rate-105");
  await sampleSegment("running-105", 8, true);
  await command("CMD:seek", { positionSeconds: 120 });
  for (const client of clients) await until(client, (s) => s.time >= 120 && s.time < 125, "playing-seek-120");
  await sampleSegment("playing-seek", 5, true);
  await b.send("Page.reload");
  await until(b, (s) => s.width === 1920 && s.time > 125 && s.connected, "reload-rejoins-playing-room");
  await sleep(1000);
  await sampleSegment("reload-before-gesture", 5, true, false);
  await unlockAndResume(b, "reload");
  await sampleSegment("reload-recovery", 5, true);
  await click(a, 'button[aria-label="暂停"]');
  await until(b, (s) => s.control === "播放", "final-pause-propagates");
  await sampleSegment("final-paused", 2, false);
  result.pass = true;
} catch (error) {
  result.pass = false;
  result.failure = error.message;
  console.error(result.failure);
  result.final = await Promise.all(clients.filter((client) => client.evaluate).map((client) => snapshot(client).catch(() => null)));
  process.exitCode = 1;
} finally {
  for (const client of clients) {
    if (client.ws?.readyState === WebSocket.OPEN) {
      try { await client.send("Browser.close"); } catch {}
      client.ws.close();
    }
    client.process.kill();
  }
  await sleep(500);
  for (const client of clients) {
    await rm(client.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  result.profilesDeleted = true;
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(`Evidence: ${output}`);
}
