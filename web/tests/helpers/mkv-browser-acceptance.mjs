// Real Chrome room acceptance against mkv-local-server.mjs; no production calls.
// node web/tests/helpers/mkv-browser-acceptance.mjs <evidence.json> [--capture]
// --capture records only H27T22 at (0,-1440), output_idx=1. Raw recordings are temporary.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile, copyFile } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import path from "node:path";

const base = "http://127.0.0.1:18981";
const origin = "http://127.0.0.1:18982";
const profile = await mkdtemp(path.join(tmpdir(), "next-mkv-chrome-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const output = process.argv[2] ?? path.join(tmpdir(), "next-mkv-acceptance.json");
const captureMode = process.argv.includes("--capture");
const result = { startedAt: new Date().toISOString(), checks: [], samples: [] };
const fixture = await (await fetch(`${base}/__fixture`)).json();
async function command(event, payload = {}) {
  const response = await (await fetch(`${base}/__fixture/command`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, payload }) })).json();
  assert.equal(response.ok, true, JSON.stringify(response));
}
await command("CMD:mediaSet");
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
  "--window-position=0,-1440", "--window-size=1280,900", "about:blank",
], { stdio: "ignore" });
let ws;
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const current = ++id;
  const timeout = setTimeout(() => { pending.delete(current); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
  pending.set(current, { resolve: (value) => { clearTimeout(timeout); resolve(value); },
    reject: (error) => { clearTimeout(timeout); reject(error); } });
  ws.send(JSON.stringify({ id: current, method, params }));
});
async function evaluate(expression, userGesture = false) {
  const value = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.text + " " + value.exceptionDetails.exception?.description);
  return value.result?.value;
}
const snapshot = () => evaluate(`(() => {
  const canvas = document.querySelector('canvas[aria-label="MKV 视频"]');
  let pixels = null;
  if (canvas) {
    const data = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let sum=0, nonblack=0;
    for(let i=0;i<data.length;i+=160) { sum+=data[i]+data[i+1]+data[i+2]; if(data[i]+data[i+1]+data[i+2]>30) nonblack++; }
    pixels={mean:sum/(data.length/160*3),nonblack};
  }
  const rig=globalThis.__mkvRig;
  const audio=rig.audio.map(context=>({state:context.state,time:context.currentTime}));
  let rms=0;
  for(const analyser of rig.analysers) { const data=new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data);
    rms=Math.max(rms,Math.sqrt(data.reduce((sum,value)=>sum+value*value,0)/data.length)); }
  return {wall:performance.now(),time:Number(canvas?.dataset.mediaTime??-1),rate:Number(canvas?.dataset.playbackRate??0),audioPeak:rig.audioPeak,
    width:canvas?.width,height:canvas?.height,pixels,audio,rms,workers:rig.workers.map(w=>w.stopped),
    cues:rig.cues.slice(-5),rates:rig.rates.slice(-5),errors:rig.errors,body:document.body.innerText.slice(0,1000)};
})()`);
async function until(predicate, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await snapshot();
    if (predicate(value)) { result.checks.push({ label, value }); console.log(label, JSON.stringify(value)); return value; }
    if (value.body.includes("MKV 解码引擎初始化超时") || value.body.includes("MKV 播放失败")) throw new Error(value.body);
    await sleep(200);
  }
  throw new Error(`Failed ${label}: ${JSON.stringify(await snapshot())}`);
}
async function clickCanvas() {
  const box = await evaluate(`(()=>{const r=document.querySelector('canvas[aria-label="MKV 视频"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...box });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...box });
}
async function physicalRun() {
  await command("CMD:seek", { positionSeconds: 2 });
  await until((s) => Math.abs(s.time - 2) < 0.1, "physical-paused-start");
  await evaluate("document.querySelector('canvas[aria-label=\"MKV 视频\"]').parentElement.requestFullscreen()", true);
  const display = await evaluate("({x:screenX,y:screenY,width:innerWidth,height:innerHeight})");
  assert.equal(display.y, -1440, "Capture must stay on H27T22");
  result.display = display;
  const directory = await mkdtemp(path.join(tmpdir(), "next-mkv-physical-"));
  const results = path.join(directory, "results");
  await mkdir(results);
  const label = "next-room-rate-mix";
  const capturePath = path.join(results, `${label}-capture.mkv`);
  const startEpoch = Date.now();
  const bridge = Date.now() / 1000 - uptime();
  const capture = spawn("ffmpeg", ["-hide_banner", "-loglevel", "info",
    "-f", "lavfi", "-i", "ddagrab=output_idx=1:framerate=30",
    "-f", "dshow", "-audio_buffer_size", "20", "-i", "audio=Microphone (High Definition Audio Device)",
    "-f", "dshow", "-audio_buffer_size", "20", "-i", "audio=Loopback 1/2 (2- E1x2 OTG)",
    "-filter_complex", "[0:v]hwdownload,format=bgra,scale=640:360[outv]",
    "-map", "[outv]", "-map", "1:a", "-map", "2:a",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "flac", "-t", "75", "-y", capturePath], { stdio: ["pipe", "ignore", "pipe"] });
  let log = "";
  capture.stderr.on("data", (chunk) => { log += chunk; });
  capture.stdin.on("error", () => {});
  const finished = new Promise((resolve) => capture.on("close", resolve));
  try {
    await sleep(1000);
    const calibration = spawn("powershell", ["-NoProfile", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
      "$f=New-Object System.Windows.Forms.Form; $f.FormBorderStyle='None'; $f.TopMost=$true; " +
      "$f.StartPosition='Manual'; $f.Location=New-Object System.Drawing.Point(0,-1440); " +
      "$f.Size=New-Object System.Drawing.Size(2560,1440); $f.BackColor=[System.Drawing.Color]::White; " +
      "$f.Show(); [Console]::Out.WriteLine('CALIB '+([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()/1000.0)); " +
      "Start-Sleep -Milliseconds 1200; $f.Close();"], { stdio: ["ignore", "pipe", "pipe"] });
    let calibrationLog = "";
    calibration.stdout.on("data", (chunk) => { calibrationLog += chunk; });
    await new Promise((resolve) => calibration.on("close", resolve));
    const calibrationWall = Number(/CALIB ([\d.]+)/.exec(calibrationLog)?.[1]);
    assert.ok(calibrationWall, "physical calibration timestamp");
    await clickCanvas();
    await command("CMD:play");
    for (const rate of [1, 0.95, 1.05]) {
      await command("CMD:rate", { rate });
      const started = Date.now();
      const samples = [];
      let screenshotTaken = false;
      while (Date.now() - started < 20000) {
        const sample = await snapshot();
        samples.push({ wall: sample.wall, time: sample.time, rate: sample.rate, cues: sample.cues, rms: sample.rms });
        if (!screenshotTaken && sample.cues.some((cue) => Math.abs(cue.time - sample.time) < 0.04)) {
          const shot = await send("Page.captureScreenshot", { format: "png" });
          const proof = path.join(tmpdir(), `next-mkv-room-proof-${rate}.png`);
          await writeFile(proof, Buffer.from(shot.data, "base64"));
          result.frameProofs ??= [];
          result.frameProofs.push(proof);
          screenshotTaken = true;
        }
        await sleep(150);
      }
      const first = samples[5], last = samples.at(-1);
      const measured = (last.time - first.time) / ((last.wall - first.wall) / 1000);
      assert.ok(Math.abs(measured - rate) < 0.02, `physical run frame rate ${measured} vs ${rate}`);
      result.samples.push({ requestedRate: rate, measuredRate: measured, samples });
      console.log(`physical segment ${rate} measured ${measured}`);
    }
    await command("CMD:pause");
    capture.stdin.write("q\n");
    assert.equal(await finished, 0, log.slice(-500));
    await writeFile(path.join(results, `${label}-capture.log`), log);
    await writeFile(path.join(results, `${label}-capture-meta.json`), JSON.stringify({
      captureStartEpochMs: startEpoch, captureEndEpochMs: Date.now(), bridgeEpochMinusUptime: bridge,
      calibrationWallEpochSec: calibrationWall,
      devices: { video: "ddagrab output_idx=1 @30fps", audio0: "Microphone (High Definition Audio Device)", audio1: "Loopback 1/2 (2- E1x2 OTG)" },
    }));
    // Run the frozen POC analyzer unchanged from a temporary copy; its outputs stay outside the baseline.
    await copyFile(new URL("../../../dev/browser-mkv-poc/verify/av-sync-analyze.mjs", import.meta.url), path.join(directory, "analyze.mjs"));
    const analyzer = spawn(process.execPath, [path.join(directory, "analyze.mjs"), label], { stdio: ["ignore", "inherit", "inherit"] });
    assert.equal(await new Promise((resolve) => analyzer.on("close", resolve)), 0);
    result.physical = JSON.parse(await readFile(path.join(results, `${label}-sync.json`), "utf8"));
    const absolute = result.physical.pairs.map((pair) => Math.abs(pair.offsetMs)).sort((a, b) => a - b);
    // The frozen analyzer's p95AbsMs uses signed values. Correct that statistic in this evidence only.
    result.physical.correctedP95AbsMs = absolute[Math.min(absolute.length - 1, Math.floor(absolute.length * 0.95))];
    result.physical.overallStats.p95AbsMs = result.physical.correctedP95AbsMs;
    for (const segment of result.physical.segmentStats) {
      const offsets = result.physical.pairs.filter((pair) => pair.tVideo >= segment.firstT - 0.1 && pair.tVideo <= segment.lastT + 0.1)
        .map((pair) => Math.abs(pair.offsetMs)).sort((a, b) => a - b);
      segment.stats.p95AbsMs = offsets[Math.min(offsets.length - 1, Math.floor(offsets.length * 0.95))];
    }
    assert.ok(result.physical.captureStarts.deltaMs !== null, "calibrated physical offset");
    assert.ok(absolute.length >= 8, "at least eight physical flash/beep pairs");
    assert.ok(absolute.at(-1) < 100, `physical A/V max ${absolute.at(-1)}ms`);
  } finally {
    if (capture.exitCode === null) { capture.stdin.write("q\n"); await finished; }
    await rm(directory, { recursive: true, force: true });
  }
}
try {
  let port;
  for (let i = 0; i < 80; i++) {
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { await sleep(250); }
  }
  assert.ok(port, "Chrome debugging port");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiting = pending.get(message.id);
    if (waiting) {
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
      else waiting.resolve(message.result);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  const instrument = `(() => {
    const rig=globalThis.__mkvRig={workers:[],audio:[],analysers:[],cues:[],rates:[],errors:[],audioPeak:0};
    setInterval(()=>{for(const analyser of rig.analysers) { const data=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(data);
      rig.audioPeak=Math.max(rig.audioPeak,Math.sqrt(data.reduce((sum,value)=>sum+value*value,0)/data.length));}},20);
    const NativeWorker=Worker;
    globalThis.Worker=class extends NativeWorker { constructor(...args) { super(...args); const entry={stopped:false};rig.workers.push(entry);
      const stop=this.terminate.bind(this);this.terminate=()=>{entry.stopped=true;stop();}; } };
    const NativeAudio=AudioContext;
    globalThis.AudioContext=class extends NativeAudio { constructor(...args) {super(...args);rig.audio.push(this);}
      createGain() {const gain=super.createGain();const analyser=this.createAnalyser();gain.connect(analyser);rig.analysers.push(analyser);return gain;}
      createBufferSource() {const source=super.createBufferSource();const start=source.start.bind(source);
        source.start=(...args)=>{rig.rates.push(source.playbackRate.value);start(...args);};return source;} };
    const draw=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText=function(text,...args){rig.cues.push({text,time:Number(this.canvas.dataset.mediaTime)});
      if(rig.cues.length>100)rig.cues.shift();return draw.call(this,text,...args);};
    addEventListener('error',event=>rig.errors.push(event.message));
    addEventListener('unhandledrejection',event=>rig.errors.push(String(event.reason)));
    if(location.origin===${JSON.stringify(origin)}) {
      localStorage.setItem('watchparty_client_id',${JSON.stringify(crypto.randomUUID())});
      localStorage.setItem(${JSON.stringify(`token_${fixture.room.roomId}`)},${JSON.stringify(fixture.room.accessToken)});
    }
  })()`;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: instrument });
  await send("Page.navigate", { url: `${origin}/room/${fixture.room.roomId}` });
  await until((s) => s.width === 1920 && s.time >= 0 && s.pixels.nonblack > 100, "paused-first-frame");
  if (captureMode) {
    await physicalRun();
  } else {
    // A real canvas gesture exercises AudioContext unlock before the owner command.
    await clickCanvas();
    await command("CMD:play");
    await until((s) => s.time > 2 && s.audio.some((a) => a.state === "running"), "playing-with-audio");
    await until((s) => s.audioPeak > 0.002 && s.cues.some((cue) => cue.text.includes("M01")), "beep-and-embedded-cue", 10000);
    await command("CMD:pause");
  }
  await sleep(500);
  const paused = await snapshot();
  await sleep(1000);
  assert.equal((await snapshot()).time, paused.time, "paused frame is stable");
  result.checks.push({ label: "pause-stable", value: paused });
  await command("CMD:seek", { positionSeconds: 60 });
  await until((s) => Math.abs(s.time - 60) < 0.2, "paused-seek-60");
  await command("CMD:rate", { rate: 0.95 });
  await command("CMD:play");
  const start = await until((s) => s.time > 61 && s.rate === 0.95 && s.rates.some((rate) => Math.abs(rate - 0.95) < 1e-6), "rate-095");
  await sleep(6000);
  const end = await snapshot();
  const rate = (end.time - start.time) / ((end.wall - start.wall) / 1000);
  assert.ok(Math.abs(rate - 0.95) < 0.035, `measured media rate ${rate}`);
  result.checks.push({ label: "rate-095-measured", value: rate });
  await command("CMD:rate", { rate: 1.05 });
  await until((s) => s.rate === 1.05 && s.rates.some((rate) => Math.abs(rate - 1.05) < 1e-6), "running-rate-105");
  await command("CMD:seek", { positionSeconds: 120 });
  await until((s) => s.time >= 120 && s.time < 125, "playing-seek-120");
  await command("CMD:pause");
  result.metrics = (await (await fetch(`${base}/__fixture`)).json()).metrics;
  assert.equal(result.metrics.fullRequests, 0);
  await command("CMD:mediaSet", { media: { kind: "http", url: "https://127.0.0.1:18982/__missing.mp4" } });
  await until((s) => s.time === -1 && s.workers.every(Boolean) && s.audio.every((a) => a.state === "closed"), "source-switch-releases-worker-and-audio");
  assert.deepEqual((await snapshot()).errors, []);
  result.pass = true;
} catch (error) {
  result.pass = false;
  result.failure = error.message;
  try { result.final = await snapshot(); } catch {}
  console.error(result.failure);
  process.exitCode = 1;
} finally {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(`Evidence: ${output}`);
  if (ws?.readyState === WebSocket.OPEN) {
    try { await send("Browser.close"); } catch {}
    ws.close();
  }
  chrome.kill();
  await sleep(500);
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
