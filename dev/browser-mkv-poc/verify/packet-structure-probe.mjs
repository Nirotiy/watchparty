// Packet-structure probe: reads video packet sizes/keys/timestamps of one sample via OpenList
// to verify GOP length and keyframe sizes (the ~4s decode-stall hypothesis).
// Usage: node verify/packet-structure-probe.mjs [sampleIndex] [packetCount]
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import LibAV from "@libav.js/variant-webcodecs";

const sampleIndex = Number(process.argv[2] ?? 35);
const targetPackets = Number(process.argv[3] ?? 600);
const openListOrigin = "http://127.0.0.1:5349";
const credentialsPath = "C:\\Users\\Nirotiy\\Documents\\openlist_credentials.json";
const root = "/media/openlist-bdyun/Multimedia/";
const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../ffprobe-sample-20260904/sample-manifest-current.json");

const credentials = parseCredentials(readFileSync(credentialsPath, "utf8"));
const token = await login();
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const sample = manifest.find((entry) => entry.sampleIndex === sampleIndex);
const { rawUrl, size } = await resolveMedia(sample.relativePath);

const WINDOW = 4 * 1024 * 1024;
const windows = [];
libavInit();
function libavInit() { /* placeholder to keep structure */ }

const libav = await LibAV.LibAV({ noworker: true });
libav.onblockread = (name, position, length) => {
  void (async () => {
    const hit = windows.find((w) => position >= w.start && position + length <= w.start + w.bytes.byteLength);
    if (hit) {
      await libav.ff_block_reader_dev_send(name, position, hit.bytes.subarray(position - hit.start, position - hit.start + length));
      return;
    }
    const end = Math.min(size, position + WINDOW);
    const response = await fetch(rawUrl, { headers: { Range: `bytes=${position}-${end - 1}` } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    windows.unshift({ start: position, bytes });
    if (windows.length > 3) windows.pop();
    await libav.ff_block_reader_dev_send(name, position, bytes.subarray(0, Math.min(length, bytes.byteLength)));
  })().catch(async (error) => libav.ff_block_reader_dev_send(name, position, null, { errorCode: libav.EIO, error: String(error) }));
};

await libav.mkblockreaderdev("s.mkv", size);
const [formatContext, streams] = await libav.ff_init_demuxer_file("s.mkv");
const videoIndex = streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_VIDEO)?.index ?? 0;
const video = streams.find((s) => s.index === videoIndex);
const tb = video.time_base_num / video.time_base_den;
const packet = await libav.av_packet_alloc();

const seekSeconds = Number(process.env.PROBE_SEEK ?? 0);
if (seekSeconds > 0) {
  const timestamp = BigInt(Math.max(0, Math.floor(seekSeconds / (video.time_base_num / video.time_base_den))));
  const [low, high] = libav.bigIntToi64(timestamp);
  await libav.av_seek_frame(formatContext, videoIndex, low, high, libav.AVSEEK_FLAG_BACKWARD);
  await libav.avformat_flush(formatContext);
}

const rows = [];
let dtsBase = null;
for (let batch = 0; batch < 2000 && rows.length < targetPackets; batch += 1) {
  const [result, groups] = await libav.ff_read_frame_multi(formatContext, packet, { limit: 512 * 1024, unify: true, copyoutPacket: "default" });
  for (const [streamIndex, packets] of Object.entries(groups)) {
    if (Number(streamIndex) !== videoIndex) continue;
    for (const p of packets) {
      if (rows.length >= targetPackets) break;
      const dts = p.dts !== undefined && p.dts !== null ? LibAV.i64tof64(p.dts, p.dtshi ?? 0) : null;
      const sec = dts !== null ? dts * tb : null;
      if (sec !== null && dtsBase === null) dtsBase = sec;
      rows.push({
        n: rows.length + 1,
        sizeKB: Math.round(p.data.byteLength / 1024),
        sec: sec !== null ? +(sec - (dtsBase ?? 0)).toFixed(3) : null,
        key: Boolean(p.flags & 1),
      });
    }
  }
  if (result === libav.AVERROR_EOF) break;
}
await libav.av_packet_free(packet);
await libav.avformat_close_input_js(formatContext);
libav.terminate();

const keys = rows.filter((r) => r.key);
const keyGaps = keys.slice(1).map((k, i) => +(k.sec - keys[i].sec).toFixed(3));
const sizes = rows.map((r) => r.sizeKB).sort((a, b) => a - b);
const keySizes = keys.map((k) => k.sizeKB);
const normalSizes = rows.filter((r) => !r.key).map((r) => r.sizeKB);
console.log(JSON.stringify({
  packets: rows.length,
  keyframes: keys.length,
  keyframeSpacingSec: keyGaps.slice(0, 12),
  keyframeMedianSizeKB: keySizes.sort((a, b) => a - b)[Math.floor(keySizes.length / 2)] ?? null,
  keyframeMaxSizeKB: Math.max(0, ...keySizes),
  normalMedianSizeKB: normalSizes.sort((a, b) => a - b)[Math.floor(normalSizes.length / 2)] ?? null,
  normalMaxSizeKB: Math.max(0, ...normalSizes),
  sizeP95KB: sizes[Math.floor(sizes.length * 0.95)] ?? null,
  sizeMaxKB: sizes.at(-1) ?? null,
  firstKeyframes: keys.slice(0, 10),
}, null, 1));

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
async function resolveMedia(relativePath) {
  const result = await post("/api/fs/get", { path: `${root}${relativePath}` }, token);
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
