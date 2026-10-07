#!/usr/bin/env node
// Drives the interactive poc-manual-chrome window: loads a curated per-format sample list, plays each for
// the given seconds, collects telemetry, then swaps to the next. Leaves the page paused on the last sample.
// Usage: node verify/rotate.mjs [--seconds 180] [--gap 5] [sampleIndex ...]
// Default list = one sample per format class: H.264 8-bit / HEVC 1080p / HEVC 4K / H.264 10-bit / tiny AVC / MPEG-2.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argNum = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const playSeconds = argNum("seconds", 180);
const gapSeconds = argNum("gap", 5);
const loadOnly = process.argv.includes("--load-only");
const rawArgs = process.argv.slice(2);
const list = [];
for (let i = 0; i < rawArgs.length; i += 1) {
  if (rawArgs[i] === "--seconds" || rawArgs[i] === "--gap") { i += 1; continue; }
  if (/^[0-9]+$/.test(rawArgs[i])) list.push(Number(rawArgs[i]));
}
const DEFAULT_LIST = [17, 2, 3, 30, 36, 39];
const samples = list.length ? list : DEFAULT_LIST;

const profileDir = join(tmpdir(), "poc-manual-chrome");
const portFile = join(profileDir, "DevToolsActivePort");
if (!existsSync(portFile)) throw new Error("poc-manual-chrome is not running; start it with: node verify/open-page.mjs");
const port = readFileSync(portFile, "utf8").split("\n")[0].trim();
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((t) => t.type === "page" && (t.url || "").includes("localhost:5188"));
if (!target) throw new Error("POC page target not found");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve: res, reject: rej } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? rej(new Error(JSON.stringify(message.error))) : res(message.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, { resolve: res, reject: rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;
const stateText = (sel) => evalJs(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ""`);
const toggleText = () => evalJs(`document.querySelector("#play-toggle")?.textContent.trim() ?? ""`);

await send("Runtime.enable");
const ensurePaused = async () => {
  if ((await toggleText()) === "Ⅱ") { await evalJs(`document.querySelector("#play-toggle").click()`); await sleep(600); }
};

const summaryPath = join(here, "results", "format-rotation.jsonl");
const ticksPath = join(here, "results", "format-rotation-ticks.jsonl");
let lastTickT = 0;
const results = [];

for (const sampleIndex of samples) {
  const rec = { sampleIndex, at: new Date().toISOString() };
  try {
    const meta = execFileSync(process.execPath, [join(here, "sign-url.mjs"), String(sampleIndex)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const mediaUrl = meta.trim().replace("http://127.0.0.1:5349", "http://127.0.0.1:5397");
    rec.path = execFileSync(process.execPath, ["-e", `const m=require(${JSON.stringify(join(here, "../../ffprobe-sample-20260904/sample-manifest-current.json"))});process.stdout.write(m.find(e=>e.sampleIndex===${sampleIndex})?.relativePath||"")`], { encoding: "utf8" }).trim();

    await ensurePaused();
    await evalJs(`document.querySelector('[data-mode="url"]').click()`);
    await evalJs(`(() => { const i = document.querySelector("#media-url"); i.value = ${JSON.stringify(mediaUrl)}; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await evalJs(`document.querySelector("#inspect").click()`);

    let demux = "";
    for (let i = 0; i < 480; i += 1) {
      await sleep(250);
      demux = await stateText("#demux-state");
      if (demux.includes("失败") || demux.includes("已解析")) break;
    }
    if (!demux.includes("已解析")) {
      rec.loadOk = false;
      rec.error = `demux: ${demux}`;
      rec.events = await evalJs(`[...document.querySelectorAll("#events li")].slice(0, 4).map(li => li.innerText.replace(/\\s+/g, " "))`);
      console.log(`rotate: sample ${sampleIndex} LOAD FAILED (${demux})`);
      results.push(rec);
      appendFileSync(summaryPath, JSON.stringify(rec) + "\n");
      continue;
    }
    rec.loadOk = true;
    rec.durationAtLoad = await stateText("#seek-time");
    rec.loadEvent = await evalJs(`[...document.querySelectorAll("#events li")].find(li => li.innerText.includes("时长"))?.innerText.replace(/\\s+/g, " ") ?? ""`);
    rec.tracks = await evalJs(`document.querySelector("#tracks")?.innerText.split("\\n").filter(l => ["VIDEO","AUDIO"].includes(l) || l.includes("WebCodecs")).slice(0,6).join(" ")`);
    if (loadOnly) {
      console.log(`rotate: sample ${sampleIndex} load-only | ${rec.durationAtLoad} | ${rec.loadEvent}`);
      results.push(rec);
      appendFileSync(summaryPath, JSON.stringify(rec) + "\n");
      continue;
    }

    lastTickT = Date.now();
    const countersAtStart = await evalJs(`(() => { const t = globalThis.__pocTelemetry?.ticks || []; const last = t[t.length - 1]; return last ? { decoded: last.decoded, coalesced: last.coalesced } : { decoded: 0, coalesced: 0 }; })()`);
    await evalJs(`document.querySelector("#play-toggle").click()`);
    const playStart = Date.now();
    const startSeekTime = await stateText("#seek-time");
    let decodeFail = null;
    const tickBuf = [];
    while ((Date.now() - playStart) / 1000 < playSeconds) {
      await sleep(gapSeconds * 1000);
      const elapsed = (Date.now() - playStart) / 1000;
      const ticksRaw = await evalJs(`JSON.stringify((globalThis.__pocTelemetry && globalThis.__pocTelemetry.ticks || []).filter(t => t.t > ${lastTickT}))`);
      const ticks = JSON.parse(ticksRaw || "[]");
      for (const t of ticks) { tickBuf.push(t); lastTickT = Math.max(lastTickT, t.t); }
      const decode = await stateText("#decode-state");
      if (decode.includes("失败")) { decodeFail = decode; break; }
      if (decode.includes("已停止") && tickBuf.length > 3) { decodeFail = decode; break; }
      if (elapsed > 45 && (await stateText("#seek-time")) === startSeekTime) { decodeFail = `no decode output within 45s (${decode})`; break; }
    }
    rec.playedSeconds = Math.round((Date.now() - playStart) / 1000);
    await ensurePaused();
    await sleep(1200);

    rec.decodeFail = decodeFail;
    rec.limitations = await stateText("#limitations");
    rec.seekTime = await stateText("#seek-time");
    rec.metrics = await evalJs(`(() => ({ requests: document.querySelector("#metric-requests")?.textContent, bytes: document.querySelector("#metric-bytes")?.textContent, size: document.querySelector("#metric-size")?.textContent, full: document.querySelector("#metric-full")?.textContent }))()`);
    rec.events = await evalJs(`[...document.querySelectorAll("#events li")].slice(0, 3).map(li => li.innerText.replace(/\\s+/g, " "))`);

    const raf = tickBuf.map((t) => t.maxRafGapMs).filter((x) => x != null);
    const dec = tickBuf.map((t) => t.maxDecodeGapMs).filter((x) => x != null);
    appendFileSync(ticksPath, JSON.stringify({ sampleIndex, playStart, playedSeconds: rec.playedSeconds, ticks: tickBuf }) + "\n");
    const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
    const lastTick = tickBuf[tickBuf.length - 1];
    rec.ticks = {
      count: tickBuf.length,
      rafMax: raf.length ? Math.max(...raf) : null,
      rafP95: q(raf, 0.95),
      rafOver50: raf.filter((x) => x > 50).length,
      rafOver100: raf.filter((x) => x > 100).length,
      decMedian: q(dec, 0.5),
      decMax: dec.length ? Math.max(...dec) : null,
      coalescedDelta: lastTick ? lastTick.coalesced - countersAtStart.coalesced : null,
      decodedFrames: lastTick ? lastTick.decoded - countersAtStart.decoded : null,
    };
    console.log(`rotate: sample ${sampleIndex} done | ${rec.tracks?.slice(0, 50)} | ticks=${rec.ticks.count} rafMax=${rec.ticks.rafMax} raf>100=${rec.ticks.rafOver100} | ${rec.limitations?.slice(0, 90)}`);
  } catch (error) {
    rec.error = String(error?.message || error);
    console.log(`rotate: sample ${sampleIndex} ERROR ${rec.error}`);
  }
  results.push(rec);
  appendFileSync(summaryPath, JSON.stringify(rec) + "\n");
}

console.log("rotate: all done");
console.log(JSON.stringify(results.map((r) => ({ i: r.sampleIndex, load: r.loadOk, played: r.playedSeconds, rafMax: r.ticks?.rafMax, rafOver100: r.ticks?.rafOver100, coalesced: r.ticks?.coalescedDelta, frames: r.ticks?.decodedFrames })), null, 1));
process.exit(0);
