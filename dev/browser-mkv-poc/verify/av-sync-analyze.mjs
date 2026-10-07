#!/usr/bin/env node
// P0 analyzer: finds flash/beep mark pairs in the shared-timeline capture and reports
// per-segment A/V offset statistics. Video onsets come from ddagrab frames, audio onsets
// from the HDA mic track (physical) ; the E1x2 loopback track is summarized as a control.
// Usage: node verify/av-sync-analyze.mjs <label> [--keepCapture]
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const label = process.argv[2];
if (!label) throw new Error("usage: node verify/av-sync-analyze.mjs <label> [--keepCapture]");
const keepCapture = process.argv.includes("--keepCapture");
const resultsDir = join(here, "results");
const capturePath = join(resultsDir, `${label}-capture.mkv`);
const metaPath = join(resultsDir, `${label}-capture-meta.json`);
if (!existsSync(capturePath)) throw new Error(`capture not found: ${capturePath}`);
const meta = JSON.parse(readFileSync(metaPath, "utf8"));

// Each input is zero-based by ffmpeg, so the per-run capture skew equals the gap between the
// devices' first-sample wall stamps, which ffmpeg prints as "start:" in the info log.
// Mic wall base from the ffmpeg log (dshow start is uptime seconds); the ddagrab base is derived
// later from the calibration flash once the video frames are decoded.
let micStartUptime = null;
{
  const logPath = join(resultsDir, `${label}-capture.log`);
  if (existsSync(logPath)) {
    const log = readFileSync(logPath, "utf8");
    const re = /Input #(\d+), ([a-z0-9_]+), from '([^']+)'[\s\S]{0,800}?start: ([\d.]+)/g;
    let m;
    while ((m = re.exec(log))) {
      if (m[2] === "dshow" && String(m[3]).includes("Microphone")) micStartUptime = Number(m[4]);
    }
  }
}
const calibrationWallEpochSec = Number(meta.calibrationWallEpochSec ?? 0) || null;
let captureStarts = null;
let deltaSec = 0;

const run = (args) => new Promise((res, rej) => {
  const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  const out = [];
  let err = "";
  p.stdout.on("data", (c) => out.push(c));
  p.stderr.setEncoding("utf8");
  p.stderr.on("data", (c) => { err += c; });
  p.on("close", (code) => (code === 0 ? res(Buffer.concat(out)) : rej(new Error(`ffmpeg exit ${code}: ${err.slice(-500)}`))));
});

// ---- stream A: video flash onsets (8x8 block means + per-frame PTS) ------------------------
const VW = 640, VH = 360, FRAME_BYTES = VW * VH;
const GRID = 8, BW = VW / GRID, BH = VH / GRID;
const blockMeansOfFrame = (buf) => {
  const out = new Array(GRID * GRID).fill(0);
  const counts = new Array(GRID * GRID).fill(0);
  for (let y = 0; y < VH; y += 4) {
    const by = Math.floor(y / BH);
    for (let x = 0; x < VW; x += 4) {
      const bi = by * GRID + Math.floor(x / BW);
      out[bi] += buf[y * VW + x];
      counts[bi] += 1;
    }
  }
  for (let i = 0; i < out.length; i += 1) out[i] /= Math.max(1, counts[i]);
  return out;
};
const videoFrames = await new Promise((res, rej) => {
  const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", capturePath, "-map", "0:v:0",
    "-fps_mode", "passthrough", "-vf", "format=gray", "-f", "rawvideo", "-"], { stdio: ["ignore", "pipe", "pipe"] });
  const frames = [];
  let pending = Buffer.alloc(0);
  let err = "";
  p.stderr.setEncoding("utf8");
  p.stderr.on("data", (c) => { err += c; });
  p.stdout.on("data", (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= FRAME_BYTES) {
      frames.push(blockMeansOfFrame(pending.subarray(0, FRAME_BYTES)));
      pending = pending.subarray(FRAME_BYTES);
    }
  });
  p.on("close", (code) => (code === 0 ? res(frames) : rej(new Error(`video decode ${code}: ${err.slice(-300)}`))));
});
const ptsList = await new Promise((res, rej) => {
  const p = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time",
    "-of", "csv=p=0", capturePath], { stdio: ["ignore", "pipe", "pipe"] });
  let o = "";
  p.stdout.on("data", (c) => { o += c; });
  p.on("close", (code) => (code === 0 ? res(o.trim().split("\n").map(Number)) : rej(new Error("ffprobe pts failed"))));
});
{
  // The calibration flash anchors the zero-based ddagrab timeline: its wall timestamp minus the
  // file time of the first fully-white frame gives the wall moment of video file time zero.
  let ddBaseEpoch = null;
  if (calibrationWallEpochSec) {
    const frameMeans = videoFrames.map((f) => f.reduce((a, b) => a + b, 0) / f.length);
    for (let i = 0; i < frameMeans.length; i += 1) {
      if (frameMeans[i] <= 220) continue;
      let j = i;
      while (j < frameMeans.length && frameMeans[j] > 220) j += 1;
      if (j - i >= 15) { ddBaseEpoch = calibrationWallEpochSec - (ptsList[i] ?? i / 30); break; }
      i = j;
    }
  }
  if (micStartUptime !== null && ddBaseEpoch !== null) {
    const bridge = Number(meta.bridgeEpochMinusUptime ?? 0);
    const micBaseEpoch = micStartUptime + bridge;
    captureStarts = {
      micStartUptime,
      bridge,
      micBaseEpoch: +micBaseEpoch.toFixed(3),
      ddBaseEpoch: +ddBaseEpoch.toFixed(3),
      calibrationWallEpochSec,
      deltaMs: +((micBaseEpoch - ddBaseEpoch) * 1000).toFixed(1),
    };
    deltaSec = captureStarts.deltaMs / 1000;
  } else {
    captureStarts = { micStartUptime, calibrationWallEpochSec, ddBaseEpoch: ddBaseEpoch === null ? null : +ddBaseEpoch.toFixed(3), deltaMs: null };
  }
}
const startTimes = await new Promise((res, rej) => {
  const p = spawn("ffprobe", ["-v", "error", "-show_entries", "stream=index,codec_type,start_time",
    "-of", "json", capturePath], { stdio: ["ignore", "pipe", "pipe"] });
  let o = "";
  p.stdout.on("data", (c) => { o += c; });
  p.on("close", (code) => {
    if (code !== 0) { rej(new Error("ffprobe start_time failed")); return; }
    const streams = JSON.parse(o).streams ?? [];
    const video = streams.find((s) => s.codec_type === "video");
    const audio0 = streams.filter((s) => s.codec_type === "audio")[0];
    res({ video: Number(video?.start_time ?? 0), audio0: Number(audio0?.start_time ?? 0) });
  });
});
const videoOnsets = [];
{
  // baseline per block = median across frames; flash score per frame = max block delta
  const nFrames = videoFrames.length;
  const nBlocks = GRID * GRID;
  const medians = new Array(nBlocks).fill(0);
  for (let b = 0; b < nBlocks; b += 1) {
    const col = videoFrames.map((f) => f[b]).sort((a, c) => a - c);
    medians[b] = col[Math.floor(nFrames * 0.5)];
  }
  const scores = videoFrames.map((f) => Math.max(...f.map((v, b) => v - medians[b])));
  const delta = scores.map((s, i) => (i ? s - scores[i - 1] : 0));
  const inFlash = { value: false };
  for (let i = 0; i < scores.length; i += 1) {
    const above = scores[i] >= 60 && delta[i] > 25;   // bright block region appears sharply
    if (above && !inFlash.value) {
      videoOnsets.push({ frame: i, t: ptsList[i] ?? i / 30, peak: scores[i] });
    }
    inFlash.value = above;
  }
}

// ---- stream B: mic audio onsets ------------------------------------------------------------
async function audioOnsetsOf(streamIndex) {
  const SR = 48000, WIN = Math.round(SR * 0.005);
  return new Promise((res, rej) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", capturePath, "-map", `0:a:${streamIndex}`,
      "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { stdio: ["ignore", "pipe", "pipe"] });
    const env = [];            // envelope sample per ~5ms step (one entry per WIN samples)
    let acc = 0, accN = 0, tail = 0;
    let err = "";
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (c) => { err += c; });
    p.stdout.on("data", (chunk) => {
      for (let i = 0; i + 4 <= chunk.length; i += 4) {
        const x = chunk.readFloatLE(i);
        acc += x * x;
        accN += 1;
        if (accN >= WIN) { env.push(Math.sqrt(acc / accN)); acc = 0; accN = 0; }
      }
      tail += chunk.length;
    });
    p.on("close", (code) => (code === 0 ? res({ env, stepSec: WIN / SR, totalSamples: tail / 4 }) : rej(new Error(`audio${streamIndex} decode ${code}: ${err.slice(-300)}`))));
  });
}
const mic = await audioOnsetsOf(0);
const envSorted = [...mic.env].sort((a, b) => a - b);
const noiseFloor = envSorted[Math.floor(envSorted.length * 0.2)] ?? 0;
const peakEnv = envSorted[envSorted.length - 1] ?? 0;
const audioOnsets = [];
{
  const threshold = Math.max(noiseFloor * 8, peakEnv * 0.08, 1e-5);
  let inBeep = false, peak = 0, peakIdx = -1;
  for (let i = 0; i < mic.env.length; i += 1) {
    const v = mic.env[i];
    if (!inBeep && v >= threshold) { inBeep = true; peak = v; peakIdx = i; }
    else if (inBeep) {
      if (v > peak) { peak = v; peakIdx = i; }
      if (v < threshold * 0.5) {
        // refine onset: walk back from peak to the 20% crossing
        let k = peakIdx;
        while (k > 0 && mic.env[k] > peak * 0.2) k -= 1;
        audioOnsets.push({ idx: k, t: startTimes.audio0 + k * mic.stepSec, peak, threshold });
        inBeep = false;
      }
    }
  }
}
let e1x2Summary = null;
if (meta.devices.audio1) {
  try {
    const ctl = await audioOnsetsOf(1);
    const s = [...ctl.env].sort((a, b) => a - b);
    e1x2Summary = { medianEnv: s[Math.floor(s.length / 2)], maxEnv: s[s.length - 1] ?? 0 };
  } catch (e) { e1x2Summary = { error: String(e.message).slice(0, 120) }; }
}

// ---- pairing & segments --------------------------------------------------------------------
const pairs = [];
{
  const used = new Set();
  for (const vo of videoOnsets) {
    let best = null, bestAdj = 1e9;
    for (let j = 0; j < audioOnsets.length; j += 1) {
      if (used.has(j)) continue;
      const adj = (vo.t - audioOnsets[j].t) - deltaSec;
      if (Math.abs(adj) < Math.abs(bestAdj)) { bestAdj = adj; best = j; }
    }
    if (best !== null && Math.abs(bestAdj) < 0.4) {
      used.add(best);
      const rawMs = (vo.t - audioOnsets[best].t) * 1000;
      pairs.push({ tVideo: vo.t, tAudio: audioOnsets[best].t, rawOffsetMs: rawMs, offsetMs: rawMs - deltaSec * 1000 });
    }
  }
}
pairs.sort((a, b) => a.tVideo - b.tVideo);
const segments = [];
{
  let cur = [];
  let prevT = null;
  for (const p of pairs) {
    if (prevT !== null && p.tVideo - prevT > 3.5) { segments.push(cur); cur = []; }
    cur.push(p);
    prevT = p.tVideo;
  }
  if (cur.length) segments.push(cur);
}
const stats = (arr) => {
  if (!arr.length) return null;
  const xs = arr.map((p) => p.offsetMs);
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { n: xs.length, meanMs: +mean.toFixed(1), stdMs: +std.toFixed(1), medianMs: +q(0.5).toFixed(1), minMs: +sorted[0].toFixed(1), maxMs: +sorted[sorted.length - 1].toFixed(1), p95AbsMs: +q(0.95).toFixed(1) };
};
let drift = null;
{
  if (pairs.length > 4) {
    const n = pairs.length;
    const t0 = pairs[0].tVideo;
    const xs = pairs.map((p) => (p.tVideo - t0) / 60);
    const ys = pairs.map((p) => p.offsetMs);
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i += 1) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    drift = { slopeMsPerMin: +(den ? num / den : 0).toFixed(2) };
  }
}

const out = {
  label,
  captureFile: capturePath,
  captureSeconds: ((meta.captureEndEpochMs - meta.captureStartEpochMs) / 1000).toFixed(1),
  devices: meta.devices,
  video: { frames: videoFrames.length, ptsCount: ptsList.length, lastPts: ptsList.length ? +ptsList[ptsList.length - 1].toFixed(3) : null, nominalFps: 30, onsets: videoOnsets.map((o) => +o.t.toFixed(3)) },
  audio: { onsetCount: audioOnsets.length, noiseFloor, peakEnv, onsets: audioOnsets.map((o) => +o.t.toFixed(3)) },
  e1x2Control: e1x2Summary,
  pairs: pairs.map((p) => ({ tVideo: +p.tVideo.toFixed(3), tAudio: +p.tAudio.toFixed(3), rawOffsetMs: +p.rawOffsetMs.toFixed(1), offsetMs: +p.offsetMs.toFixed(1) })),
  captureStarts,
  segmentStats: segments.map((s, i) => ({ rank: i, firstT: +s[0].tVideo.toFixed(1), lastT: +s[s.length - 1].tVideo.toFixed(1), stats: stats(s) })),
  overallStats: stats(pairs),
  drift,
  uncertainty: { videoFrameMs: 33.3, audioEnvelopeMs: +(mic.stepSec * 1000).toFixed(1), note: "Absolute offset additionally carries a constant capture-side skew between ddagrab and dshow start latencies; per-mark variance and drift are skew-independent." },
};
const outPath = join(resultsDir, `${label}-sync.json`);
writeFileSync(outPath, JSON.stringify(out, null, 1), "utf8");
console.log(JSON.stringify({ label, pairs: pairs.length, segments: out.segmentStats, overall: out.overallStats, drift, e1x2Control: e1x2Summary }, null, 1));
if (!keepCapture) { try { unlinkSync(capturePath); console.log("capture deleted (use --keepCapture to keep)"); } catch {} }
