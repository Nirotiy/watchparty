import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import LibAV from "@libav.js/variant-webcodecs";

const args = process.argv.slice(2);
const useOpenList = args.includes("--openlist");
const debug = args.includes("--debug");
const localPath = resolve(args.find((arg) => !arg.startsWith("-")) ?? "probe.mkv");
const openListOrigin = "http://127.0.0.1:5349";
const credentialsPath = "C:\\Users\\Nirotiy\\Documents\\openlist_credentials.json";
const sampleRoot = "/media/openlist-bdyun/Multimedia/";
const sampleManifestPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../ffprobe-sample-20260904/sample-manifest-current.json");
const ranges = [];
let sourceLabel = localPath.split(/[\\/]/).at(-1);
let size;
let localFile;
let signedUrl;
let openListToken;
let samplePath;
let etag;
let refreshAttempts = 0;
let bytesRead = 0;

if (useOpenList) {
  const credentials = parseCredentials(await readFile(credentialsPath, "utf8"));
  openListToken = await loginOpenList(credentials);
  const manifest = JSON.parse(await readFile(sampleManifestPath, "utf8"));
  const sample = manifest.find((entry) => entry.sampleIndex === 1);
  if (!sample?.relativePath) throw new Error("Current sample manifest has no sampleIndex 1");
  samplePath = `${sampleRoot}${sample.relativePath}`;
  const media = await resolveOpenListMedia(openListToken, samplePath);
  signedUrl = media.rawUrl;
  size = media.size;
  sourceLabel = "openlist-sample-1";
} else {
  size = (await stat(localPath)).size;
  localFile = await readFile(localPath);
}

const filename = "probe.mkv";
const libav = await LibAV.LibAV({ noworker: true });
let formatContext;
let callbackError;

libav.onblockread = (name, position, length) => {
  if (debug) console.error(`block read ${position}+${length}`);
  void readBlock(position, length).then(async (bytes) => {
    await libav.ff_block_reader_dev_send(name, position, bytes);
  }).catch(async (error) => {
    callbackError = error;
    await libav.ff_block_reader_dev_send(name, position, null, {
      errorCode: libav.EIO ?? 5,
      error: error instanceof Error ? error.message : "Block read failed",
    });
  });
};

let streams;
try {
  await libav.mkblockreaderdev(filename, size);
  [formatContext, streams] = await libav.ff_init_demuxer_file(filename);
} catch (error) {
  libav.terminate();
  throw error;
}

const streamRows = await Promise.all(streams.map(async (stream) => ({
  index: stream.index,
  type: ["video", "audio", "data", "subtitle", "attachment"][stream.codec_type] ?? `type-${stream.codec_type}`,
  codec: await libav.avcodec_get_name(stream.codec_id),
  language: stream.metadata?.language ?? "und",
})));
console.log(JSON.stringify({ input: sourceLabel, size, streams: streamRows }, null, 2));

if (!streamRows.some((stream) => stream.type === "subtitle")) {
  libav.terminate();
  throw new Error("The selected MKV has no subtitle stream; stopping before browser work.");
}

const packetPointer = await libav.av_packet_alloc();
let packetCount = 0;
let batchCount = 0;
try {
  while (packetCount < 20 && batchCount < 100) {
    batchCount += 1;
    const [result, packetGroups] = await libav.ff_read_frame_multi(formatContext, packetPointer, {
      limit: 1,
      copyoutPacket: "default",
    });
    const packets = Object.entries(packetGroups).flatMap(([streamIndex, group]) =>
      group.map((packet) => ({ streamIndex: Number(streamIndex), packet })),
    );
    for (const { streamIndex, packet } of packets) {
      console.log(JSON.stringify({
        packet: packetCount + 1,
        streamIndex: packet.stream_index ?? streamIndex,
        pts: packet.pts ?? null,
        ptsHi: packet.ptshi ?? null,
        bytes: packet.data.byteLength,
      }));
      packetCount += 1;
      if (packetCount >= 20) break;
    }
    if (callbackError) throw callbackError;
    if (result === libav.AVERROR_EOF) break;
    if (!packets.length && result < 0) {
      throw new Error(`ff_read_frame_multi failed with ${await libav.strerror(-result)}`);
    }
  }
} finally {
  await libav.av_packet_free(packetPointer);
  await libav.avformat_close_input_js(formatContext);
  libav.terminate();
}

if (packetCount !== 20) throw new Error(`Expected 20 packets, received ${packetCount}`);
console.log(JSON.stringify({
  packets: packetCount,
  batches: batchCount,
  bytesRead,
  fullFileBytes: size,
  rangeRequests: ranges.length,
  ranges,
  refreshedUrlOnce: refreshAttempts > 0,
}));

async function readBlock(position, length) {
  if (!useOpenList) {
    const end = Math.min(size, position + length);
    const bytes = new Uint8Array(localFile.subarray(position, end));
    bytesRead += bytes.byteLength;
    ranges.push({ pos: position, length, bytes: bytes.byteLength, source: "file" });
    return bytes;
  }

  const end = Math.min(size - 1, position + length - 1);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headers = new Headers({ Range: `bytes=${position}-${end}` });
    if (etag) headers.set("If-Range", etag);
    const response = await fetch(signedUrl, { headers, cache: "no-store", referrerPolicy: "no-referrer" });
    ranges.push({ pos: position, length, status: response.status });
    if (response.status === 403 && attempt === 0) {
      await response.body?.cancel();
      signedUrl = (await resolveOpenListMedia(openListToken, samplePath)).rawUrl;
      refreshAttempts += 1;
      continue;
    }
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new Error(response.status === 200 ? "OpenList ignored Range; full response rejected" : `OpenList Range returned HTTP ${response.status}`);
    }
    const contentRange = response.headers.get("Content-Range");
    if (contentRange !== `bytes ${position}-${end}/${size}`) {
      await response.body?.cancel();
      throw new Error("OpenList Content-Range did not match the requested interval");
    }
    etag = response.headers.get("ETag") ?? etag;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== end - position + 1) throw new Error("OpenList Range body length mismatch");
    bytesRead += bytes.byteLength;
    ranges.at(-1).bytes = bytes.byteLength;
    return bytes;
  }
  throw new Error("OpenList signed URL refresh failed");
}

function parseCredentials(source) {
  try {
    return JSON.parse(source);
  } catch {
    return Object.fromEntries(source.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 0 ? ["", ""] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      }).filter(([key, value]) => key && value));
  }
}

async function loginOpenList(credentials) {
  if (!credentials.username || !credentials.password) throw new Error("OpenList credentials file is incomplete");
  const result = await postOpenList("/api/auth/login", {
    username: credentials.username,
    password: credentials.password,
  });
  if (result.code !== 200 || !result.data?.token) throw new Error("OpenList login failed");
  return result.data.token;
}

async function resolveOpenListMedia(token, mediaPath) {
  const result = await postOpenList("/api/fs/get", { path: mediaPath }, token);
  const rawUrl = result.data?.raw_url;
  const fileSize = Number(result.data?.size);
  if (result.code !== 200 || typeof rawUrl !== "string" || !Number.isSafeInteger(fileSize) || fileSize <= 0) {
    throw new Error("OpenList did not return a signed media URL and file size");
  }
  return { rawUrl, size: fileSize };
}

async function postOpenList(route, body, token) {
  const response = await fetch(`${openListOrigin}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: token } : {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OpenList request failed with HTTP ${response.status}`);
  return response.json();
}
