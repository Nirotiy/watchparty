// Diagnostic probe: reproduces the browser's block-read pattern in Node against the real
// OpenList source and reports exactly which reads block and why (hit / inflight / miss-fetch).
// Phases: sequential playback -> seek(120s) to first frame -> sequential resume.
// Usage: node verify/readahead-probe.mjs [--no-prefetch] [--window 1048576] [--seconds 20]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import LibAV from "@libav.js/variant-webcodecs";

const args = process.argv.slice(2);
const usePrefetch = !args.includes("--no-prefetch");
const windowIdx = args.indexOf("--window");
const WINDOW = windowIdx >= 0 ? Number(args[windowIdx + 1]) : 1024 * 1024;
const secondsIdx = args.indexOf("--seconds");
const TARGET_SECONDS = secondsIdx >= 0 ? Number(args[secondsIdx + 1]) : 20;

const openListOrigin = "http://127.0.0.1:5349";
const credentialsPath = "C:\\Users\\Nirotiy\\Documents\\openlist_credentials.json";
const root = "/media/openlist-bdyun/Multimedia/";
const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../ffprobe-sample-20260904/sample-manifest-current.json");

const credentials = parseCredentials(readFileSync(credentialsPath, "utf8"));
const { rawUrl, size } = await resolveMedia((await login()));
const stats = {
  window: WINDOW, prefetch: usePrefetch,
  reads: 0, hits: 0, missFetches: 0, inflightAwaits: 0, prefetchFetches: 0,
  readsBlockedOver50ms: 0,
  fetchMs: [], prefetchMs: [],
  firstReads: [],
};
const trace = [];
let currentPhase = "open";

class Reader {
  windows = [];
  inflight = null;
  prefetching = false;
  async read(start, end) {
    stats.reads += 1;
    const t0 = performance.now();
    const served = serveFromCache(this.windows, start, end);
    if (served) {
      stats.hits += 1;
      if (usePrefetch) {
        const anchor = this.windows.find((x) => end - 1 >= x.start && end - 1 < x.start + x.bytes.byteLength) ?? this.windows[0];
        if (anchor) this.prefetchAfter(anchor);
      }
      this.recordRead(start, end, "hit", performance.now() - t0);
      return served;
    }
    let w;
    let source;
    if (this.inflight && start >= this.inflight.start && end <= this.inflight.end) {
      w = await this.inflight.promise; source = "inflight"; stats.inflightAwaits += 1;
    } else {
      w = await this.fetch(start, Math.min(size, Math.max(end, start + WINDOW)), false);
      source = "miss"; stats.missFetches += 1;
    }
    if (usePrefetch) this.prefetchAfter(w);
    this.recordRead(start, end, source, performance.now() - t0);
    return w.bytes.subarray(start - w.start, end - w.start);
  }
  recordRead(start, end, source, blockMs) {
    trace.push({ pos: start, len: end - start, source, ms: Math.round(blockMs), phase: currentPhase });
    if (blockMs > 50) stats.readsBlockedOver50ms += 1;
    if (stats.firstReads.length < 50) stats.firstReads.push({ pos: start, len: end - start, source, blockMs: Math.round(blockMs) });
  }
  prefetchAfter(w) {
    if (this.prefetching) return;
    const nextStart = w.start + w.bytes.byteLength;
    if (nextStart >= size) return;
    if (this.windows.some((x) => nextStart >= x.start && nextStart < x.start + x.bytes.byteLength)) return;
    if (this.inflight && nextStart >= this.inflight.start && nextStart < this.inflight.end) return;
    this.prefetching = true;
    void this.fetch(nextStart, Math.min(size, nextStart + WINDOW), true)
      .catch(() => { })
      .finally(() => { this.prefetching = false; });
  }
  fetch(start, end, isPrefetch) {
    const promise = (async () => {
      const t0 = performance.now();
      const response = await fetch(rawUrl, { headers: { Range: `bytes=${start}-${end - 1}` }, cache: "no-store" });
      if (response.status !== 206) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const ms = Math.round(performance.now() - t0);
      (isPrefetch ? stats.prefetchMs : stats.fetchMs).push(ms);
      if (isPrefetch) stats.prefetchFetches += 1;
      const w = { start, bytes };
      this.windows.unshift(w);
      if (this.windows.length > 4) this.windows.pop();
      return w;
    })();
    this.inflight = { start, end, promise };
    return promise.finally(() => { if (this.inflight?.promise === promise) this.inflight = null; });
  }
}

const reader = new Reader();
const libav = await LibAV.LibAV({ noworker: true });
libav.onblockread = (name, position, length) => {
  if (position >= size) { void libav.ff_block_reader_dev_send(name, position, new Uint8Array()); return; }
  void reader.read(position, Math.min(size, position + length))
    .then((bytes) => libav.ff_block_reader_dev_send(name, position, bytes))
    .catch((error) => libav.ff_block_reader_dev_send(name, position, null, { errorCode: libav.EIO, error: String(error) }));
};

await libav.mkblockreaderdev("probe.mkv", size);
const [formatContext, streams] = await libav.ff_init_demuxer_file("probe.mkv");
const video = streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_VIDEO);
const videoIndex = video?.index ?? 0;
const packetPointer = await libav.av_packet_alloc();

const phases = [];
async function drain(label, stopWhen, pace = false) {
  currentPhase = label;
  const batchMs = [];
  let videoPackets = 0;
  const t0 = performance.now();
  for (let batch = 0; batch < 6000; batch += 1) {
    const b0 = performance.now();
    const [result, groups] = await libav.ff_read_frame_multi(formatContext, packetPointer, { limit: 512 * 1024, unify: true, copyoutPacket: "default" });
    batchMs.push(performance.now() - b0);
    for (const [streamIndex, packets] of Object.entries(groups)) {
      if (Number(streamIndex) === videoIndex) videoPackets += packets.length;
    }
    if (stopWhen(videoPackets)) break;
    if (result === libav.AVERROR_EOF) break;
    if (pace) {
      // Consume at ~30 fps like real playback so prefetch timing matches the browser.
      const wait = (videoPackets / 30) * 1000 - (performance.now() - t0);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  phases.push(phaseStats(label, batchMs, videoPackets, performance.now() - t0));
}

await drain("play", (count) => count >= Math.ceil(TARGET_SECONDS * 30), true);
const seekSeconds = 120;
const timestamp = BigInt(Math.max(0, Math.floor(seekSeconds / (video.time_base_num / video.time_base_den))));
const [low, high] = libav.bigIntToi64(timestamp);
const seekResult = await libav.av_seek_frame(formatContext, videoIndex, low, high, libav.AVSEEK_FLAG_BACKWARD);
await libav.avformat_flush(formatContext);
await drain("seekToFirstFrame", (count) => count >= 1);
await drain("resume", (count) => count >= Math.ceil(5 * 30), true);

await libav.av_packet_free(packetPointer);
await libav.avformat_close_input_js(formatContext);
libav.terminate();

writeFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "results", "readahead-trace.jsonl"), trace.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

console.log(JSON.stringify({
  summary: {
    window: WINDOW, prefetch: usePrefetch, seekResult,
    reads: stats.reads, hits: stats.hits, inflightAwaits: stats.inflightAwaits, missFetches: stats.missFetches,
    prefetchFetches: stats.prefetchFetches, readsBlockedOver50ms: stats.readsBlockedOver50ms,
    fetchMs: { p50: pct(stats.fetchMs, 0.5), p95: pct(stats.fetchMs, 0.95), max: Math.max(0, ...stats.fetchMs) },
    prefetchMs: { p50: pct(stats.prefetchMs, 0.5), p95: pct(stats.prefetchMs, 0.95) },
  },
  phases,
  firstReads: stats.firstReads.slice(0, 30),
}, null, 2));

function serveFromCache(windows, start, end) {
  let cursor = start;
  const parts = [];
  while (cursor < end) {
    const w = windows.find((x) => cursor >= x.start && cursor < x.start + x.bytes.byteLength);
    if (!w) return null;
    const pieceEnd = Math.min(end, w.start + w.bytes.byteLength);
    parts.push({ offset: cursor - start, bytes: w.bytes.subarray(cursor - w.start, pieceEnd - w.start) });
    cursor = pieceEnd;
  }
  if (parts.length === 1) return parts[0].bytes;
  const out = new Uint8Array(end - start);
  for (const p of parts) out.set(p.bytes, p.offset);
  return out;
}
function phaseStats(label, batchMs, videoPackets, wallMs) {
  return {
    label, batches: batchMs.length, videoPackets, wallMs: Math.round(wallMs),
    p50: pct(batchMs, 0.5), p95: pct(batchMs, 0.95), max: Math.round(Math.max(0, ...batchMs)),
    over50ms: batchMs.filter((v) => v > 50).length,
  };
}
function pct(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]);
}
function parseCredentials(source) {
  try { return JSON.parse(source); } catch {
    return Object.fromEntries(source.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return i < 0 ? ["", ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
      .filter(([k, v]) => k && v));
  }
}
async function login() {
  const result = await post("/api/auth/login", { username: credentials.username, password: credentials.password });
  if (result.code !== 200 || !result.data?.token) throw new Error("login failed");
  return result.data.token;
}
async function resolveMedia(authToken) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const sample = manifest.find((entry) => entry.sampleIndex === 43);
  const result = await post("/api/fs/get", { path: `${root}${sample.relativePath}` }, authToken);
  if (result.code !== 200 || typeof result.data?.raw_url !== "string") throw new Error("resolve failed");
  return { rawUrl: result.data.raw_url, size: Number(result.data.size) };
}
async function post(route, body, authToken) {
  const response = await fetch(`${openListOrigin}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authToken ? { authorization: authToken } : {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OpenList HTTP ${response.status}`);
  return response.json();
}
