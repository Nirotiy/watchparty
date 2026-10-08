import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

async function loadModule(name, plugins = []) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(`../lib/mkv/${name}.ts`, import.meta.url))],
    bundle: true, format: "esm", platform: "browser", write: false, plugins });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { MediaClock } = await loadModule("media-clock");
const { RangeFile } = await loadModule("range-file");
const { canAttemptBrowserPlayback } = await loadModule("compatibility");
const { createLibavWorker } = await loadModule("libav-session");
const { groupSeasons } = await loadModule("../catalog-view");

test("libav initialization owns its worker before readiness and releases it on abort or failure", async () => {
  const previous = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    stopped = false;
    constructor() { workers.push(this); }
    terminate() { this.stopped = true; }
  };
  try {
    const aborted = new AbortController();
    const starting = createLibavWorker(() => new Promise(() => {}), "https://example.test/worker.mjs", aborted.signal);
    aborted.abort();
    await assert.rejects(starting, { name: "AbortError" });
    assert.equal(workers[0].stopped, true);
    await assert.rejects(createLibavWorker(async () => { throw new Error("boot failed"); },
      "https://example.test/worker.mjs", new AbortController().signal), /boot failed/);
    assert.equal(workers[1].stopped, true);
    const ready = await createLibavWorker(async ({ worker }) => ({ worker }),
      "https://example.test/worker.mjs", new AbortController().signal);
    assert.equal(ready.worker, workers[2]);
    assert.equal(ready.worker.stopped, false);
    ready.worker.terminate();
  } finally { globalThis.Worker = previous; }
});

test("media clock reanchors rate changes without jumping, including paused seeks", () => {
  let now = 1000;
  const clock = new MediaClock(() => now);
  clock.seek(10);
  clock.play();
  now += 5000;
  assert.equal(clock.currentTime, 15);
  clock.setRate(0.95);
  assert.equal(clock.currentTime, 15);
  assert.equal(clock.dueMs(20), now + 5000 / 0.95);
  now += 5000;
  assert.equal(clock.currentTime, 19.75);
  clock.setRate(1.05);
  assert.equal(clock.currentTime, 19.75);
  now += 5000;
  assert.equal(clock.currentTime, 25);
  clock.pause();
  now += 9000;
  assert.equal(clock.currentTime, 25);
  clock.seek(60);
  clock.play();
  now += 1000;
  assert.equal(clock.currentTime, 61.05);
});

test("MKV candidates do not turn other maybe formats into browser-supported media", () => {
  const item = (extension, browser) => ({ extension, compatibility: { browser, desktop: "supported" } });
  assert.equal(canAttemptBrowserPlayback(item("mkv", "maybe")), true);
  assert.equal(canAttemptBrowserPlayback(item("avi", "maybe")), false);
  assert.equal(canAttemptBrowserPlayback(item("mkv", "unsupported")), false);
  const [season] = groupSeasons(["Movie.MKV", "Movie.avi", "Movie.mp4"].map((name) => ({
    name, mediaId: name, compatibility: { browser: name.endsWith("mp4") ? "supported" : "maybe", desktop: "supported" },
  })));
  assert.deepEqual(season.children.map((child) => child.playable), [true, false, true]);
});

test("Range reader renews concurrent expired requests once and retries the same intervals", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  let renewals = 0;
  globalThis.fetch = async (url, options) => {
    const range = options.headers.get("Range");
    calls.push([url, range]);
    if (url === "https://example.test/old") return new Response(null, { status: 403 });
    const [, start, end] = range.match(/bytes=(\d+)-(\d+)/);
    const last = Math.min(99, Number(end));
    return new Response(new Uint8Array(last - Number(start) + 1), { status: 206,
      headers: { "Content-Range": `bytes ${start}-${last}/100`, ETag: '"same"' } });
  };
  try {
    const reader = new RangeFile("https://example.test/old", new AbortController().signal, async () => {
      renewals += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "https://example.test/new";
    });
    await Promise.all([reader.read(0, 10), reader.read(10, 20)]);
    assert.equal(renewals, 1);
    assert.deepEqual(calls, [
      ["https://example.test/old", "bytes=0-9"], ["https://example.test/old", "bytes=10-19"],
      ["https://example.test/new", "bytes=0-9"], ["https://example.test/new", "bytes=10-19"],
    ]);
    await reader.probe();
    assert.equal(reader.size, 100);
  } finally { globalThis.fetch = previousFetch; }
});

test("Range reader cancels full responses, rejects changed files and bounds failed renewal", async () => {
  const previousFetch = globalThis.fetch;
  let cancelled = 0;
  let requests = 0;
  const reader = new RangeFile("https://example.test/media", new AbortController().signal);
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled += 1; } }), { status: 200 });
    await assert.rejects(reader.probe(), /Range/);
    assert.equal(cancelled, 1);
    globalThis.fetch = async () => new Response(new Uint8Array(10), { status: 206,
      headers: { "Content-Range": "bytes 0-9/10", ETag: '"one"' } });
    await reader.probe();
    globalThis.fetch = async () => new Response(new Uint8Array(10), { status: 206,
      headers: { "Content-Range": "bytes 0-9/10", ETag: '"two"' } });
    await assert.rejects(reader.read(0, 10), /文件已变化/);
    globalThis.fetch = async () => { requests += 1; return new Response(null, { status: 403 }); };
    const expired = new RangeFile("https://example.test/expired", new AbortController().signal, async () => "https://example.test/expired");
    await assert.rejects(expired.probe(), /403/);
    assert.equal(requests, 2);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(new RangeFile("https://example.test/unused", aborted.signal).probe(), { name: "AbortError" });
    assert.equal(requests, 2);
  } finally { globalThis.fetch = previousFetch; }
});

test("MKV lifecycle supersedes paused seeks, closes decoders and aborts source requests on dispose", async () => {
  const previous = Object.fromEntries(["fetch", "VideoDecoder", "VTTCue", "requestAnimationFrame", "cancelAnimationFrame"].map((key) => [key, globalThis[key]]));
  const frames = [];
  const seeks = [];
  let closed = 0;
  let terminated = 0;
  let signal;
  const video = { index: 0, codec_type: 0, codec: "h264", config: { codec: "avc1.42001e" },
    codecParameters: { width: 640, height: 360 }, time_base_num: 1, time_base_den: 1000000 };
  const subtitle = { ...video, index: 3, codec_type: 3, codec: "subrip", config: null };
  const session = {
    streams: [video, subtitle], durationSeconds: 120,
    libav: { AVMEDIA_TYPE_VIDEO: 0, AVMEDIA_TYPE_AUDIO: 1, AVMEDIA_TYPE_SUBTITLE: 3, AVMEDIA_TYPE_ATTACHMENT: 4, AVERROR_EOF: -1 },
    async seek(time) { seeks.push(time); this.time = time; },
    async readPackets() { await new Promise((resolve) => setTimeout(resolve, 5)); return { result: -1,
      packets: { 0: [{ stream_index: 0, pts: this.time * 1e6, ptshi: 0, duration: 100000, data: new Uint8Array() }],
        3: [{ stream_index: 3, pts: this.time * 1e6, duration: 1000000, data: new TextEncoder().encode(`Cue ${this.time}`) }] } }; },
    videoChunk(packet) { return { timestamp: packet.pts }; },
    async close() { terminated += 1; },
  };
  globalThis.__mkvTestSession = session;
  globalThis.fetch = async (_url, options) => { signal = options.signal; return new Response(new Uint8Array(100),
    { status: 206, headers: { "Content-Range": "bytes 0-99/100" } }); };
  globalThis.VideoDecoder = class {
    static async isConfigSupported() { return { supported: true }; }
    state = "unconfigured";
    decodeQueueSize = 0;
    constructor(callbacks) { this.callbacks = callbacks; }
    configure() { this.state = "configured"; }
    decode(chunk) { const frame = { timestamp: chunk.timestamp, closed: false, close() { this.closed = true; } };
      frames.push(frame); this.callbacks.output(frame); }
    async flush() {}
    close() { if (this.state !== "closed") closed += 1; this.state = "closed"; }
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 2);
  globalThis.cancelAnimationFrame = clearTimeout;
  const plugin = { name: "isolated-demuxer", setup(build) {
    build.onResolve({ filter: /libav-session$/ }, () => ({ path: "fixture", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
      export class LibavSession { static async open() { return globalThis.__mkvTestSession; } }
      export function packetSeconds(packet) { return packet.pts / 1e6; }
      export function packetDecodeSeconds() { return null; }
    ` }));
  } };
  const { MkvPlayer } = await loadModule("player", [plugin]);
  const renderedCues = [];
  const canvas = { width: 0, height: 0, dataset: {}, getContext: () => ({ drawImage() {}, strokeText() {}, fillText(text) { renderedCues.push(text); } }) };
  const errors = [];
  const player = new MkvPlayer({ canvas, onReady() {}, onTimeUpdate() {}, onEnded() {}, onError: (...args) => errors.push(args) });
  try {
    await player.load("https://example.test/movie");
    player.seek(10);
    player.seek(60);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(seeks.at(-1), 60);
    assert.equal(seeks.includes(10), false);
    assert.equal(Number(canvas.dataset.mediaTime), 60);
    assert.equal(renderedCues.at(-1), "Cue 60", "subtitle packets later in a batch must reach the paused preview frame");
    globalThis.VTTCue = class {
      startTime = 59;
      endTime = 61;
      getCueAsHTML() { return { textContent: "External 60" }; }
    };
    const external = { cues: null };
    player.setExternalSubtitle(true, external);
    await new Promise((resolve) => setTimeout(resolve, 30));
    renderedCues.length = 0;
    external.cues = [new VTTCue()];
    player.setExternalSubtitle(true, external);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(renderedCues.at(-1), "External 60", "VTT load must repaint the paused frame without a room seek");
    renderedCues.length = 0;
    player.setExternalSubtitle(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(renderedCues.at(-1), "Cue 60", "switching back to embedded subtitles must repaint the paused frame");
    assert.ok(frames.every((frame) => frame.closed));
    await player.play();
    player.setPlaybackRate(0.95);
    await new Promise((resolve) => setTimeout(resolve, 30));
    player.pause();
    const paused = player.currentTime;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(player.currentTime, paused);
    player.dispose();
    player.dispose();
    assert.equal(signal.aborted, true);
    assert.equal(terminated, 1);
    assert.ok(closed >= 2);
    assert.ok(frames.every((frame) => frame.closed));
    assert.deepEqual(errors, []);
  } finally { player.dispose(); Object.assign(globalThis, previous); delete globalThis.__mkvTestSession; }
});

test("local tracks switch without changing the clock, expose codec support, and report blocked audio", async () => {
  const keys = ["fetch", "VideoDecoder", "AudioDecoder", "AudioContext", "requestAnimationFrame", "cancelAnimationFrame"];
  const previous = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  const video = { index: 0, codec_type: 0, codec: "h264", config: { codec: "avc1" },
    codecParameters: { width: 640, height: 360 }, time_base_num: 1, time_base_den: 1000000 };
  const track = (index, codec, codec_type, language) => ({ ...video, index, codec, codec_type,
    config: codec_type === 1 ? { codec } : null, metadata: { language, title: `Track ${index}` },
    codecParameters: { extradata: new TextEncoder().encode("[Script Info]") } });
  const session = {
    streams: [video, track(1, "aac", 1, "eng"), track(2, "aac", 1, "jpn"), track(3, "unsupported", 1, "fra"),
      track(4, "subrip", 3, "eng"), track(5, "ass", 3, "jpn"), track(6, "hdmv_pgs_subtitle", 3, "fra")],
    durationSeconds: 120,
    libav: { AVMEDIA_TYPE_VIDEO: 0, AVMEDIA_TYPE_AUDIO: 1, AVMEDIA_TYPE_SUBTITLE: 3, AVMEDIA_TYPE_ATTACHMENT: 4, AVERROR_EOF: -1 },
    async seek(time) { this.time = time; },
    async readPackets() { await new Promise((resolve) => setTimeout(resolve, 5)); return { result: -1,
      packets: { 0: [{ stream_index: 0, pts: this.time * 1e6, data: new Uint8Array() }] } }; },
    videoChunk(packet) { return { timestamp: packet.pts }; }, async close() {},
  };
  globalThis.__mkvTrackSession = session;
  globalThis.fetch = async () => new Response(new Uint8Array(100), { status: 206, headers: { "Content-Range": "bytes 0-99/100" } });
  globalThis.VideoDecoder = class {
    static async isConfigSupported() { return { supported: true }; }
    state = "configured"; decodeQueueSize = 0;
    constructor(callbacks) { this.callbacks = callbacks; }
    configure() {}
    decode(chunk) { this.callbacks.output({ timestamp: chunk.timestamp, close() {} }); }
    async flush() {} close() { this.state = "closed"; }
  };
  globalThis.AudioDecoder = class extends globalThis.VideoDecoder {
    static async isConfigSupported(config) { return { supported: config.codec !== "unsupported" }; }
  };
  globalThis.AudioContext = class {
    state = "suspended"; destination = {};
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    async resume() { this.state = "running"; }
    async close() { this.state = "closed"; }
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 2);
  globalThis.cancelAnimationFrame = clearTimeout;
  const plugin = { name: "track-fixture", setup(build) {
    build.onResolve({ filter: /libav-session$/ }, () => ({ path: "fixture", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
      export class LibavSession { static async open() { return globalThis.__mkvTrackSession; } }
      export function packetSeconds(packet) { return packet.pts / 1e6; }
      export function packetDecodeSeconds() { return null; }
    ` }));
  } };
  const { MkvPlayer } = await loadModule("player", [plugin]);
  const states = [], tracks = [], subtitles = [], errors = [];
  const canvas = { width: 0, height: 0, dataset: {}, getContext: () => ({ drawImage() {} }) };
  const player = new MkvPlayer({ canvas, onReady() {}, onTimeUpdate() {}, onEnded() {},
    onError: (...args) => errors.push(args), onLocalState: (state) => states.push(state),
    onTracks: (value) => tracks.push(value), onSubtitle: (value) => subtitles.push(value) });
  try {
    await player.load("https://example.test/tracks.mkv");
    assert.equal(states.at(-1).audio, "blocked");
    assert.deepEqual(tracks.at(-1).items.map((item) => [item.id, item.supported]), [[1, true], [2, true], [3, false], [4, true], [5, true], [6, false]]);
    assert.equal(tracks.at(-1).items[1].language, "jpn");
    player.seek(60);
    await player.selectAudioTrack(2);
    assert.equal(player.currentTime, 60);
    assert.equal(tracks.at(-1).audioId, 2);
    await assert.rejects(player.selectAudioTrack(3), /support/i);
    assert.equal(tracks.at(-1).audioId, 2);
    player.selectSubtitleTrack(5);
    assert.equal(subtitles.at(-1).index, 5);
    player.selectSubtitleTrack(null);
    assert.equal(tracks.at(-1).subtitleId, null);
    assert.equal(subtitles.at(-1), null);
    await player.unlockAudio();
    assert.equal(states.at(-1).audio, "running");
    assert.equal(player.currentTime, 60, "local audio activation does not start the clock");
    assert.deepEqual(errors, []);
  } finally { player.dispose(); Object.assign(globalThis, previous); delete globalThis.__mkvTrackSession; }
});
