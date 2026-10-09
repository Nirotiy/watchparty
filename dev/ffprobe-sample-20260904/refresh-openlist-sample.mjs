import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OPENLIST = "http://127.0.0.1:5349";
const CREDENTIALS_PATH = "C:\\Users\\Nirotiy\\Documents\\openlist_credentials.json";
const LIBRARY_ROOT = "/media/openlist-bdyun/Multimedia";
const PLAN = [
  { category: "Anime", quota: 34 },
  { category: "Film", quota: 1 },
  { category: "TV Shows", quota: 15 },
];
const VIDEO_EXTENSIONS = new Set([
  ".3gp", ".avi", ".flv", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4",
  ".mpeg", ".mpg", ".mts", ".ts", ".webm", ".wmv",
]);
const SUBTITLE_EXTENSIONS = new Set([
  ".ass", ".idx", ".ssa", ".srt", ".sub", ".sup", ".vtt",
]);
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROBE_TIMEOUT_MS = 60_000;

function parseCredentials(source) {
  try {
    return JSON.parse(source);
  } catch {
    return Object.fromEntries(
      source.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const separator = line.indexOf("=");
          return separator < 0
            ? ["", ""]
            : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
        })
        .filter(([key, value]) => key && value),
    );
  }
}

async function postJson(route, body, token) {
  const response = await fetch(`${OPENLIST}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: token } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OpenList HTTP ${response.status}`);
  return response.json();
}

async function listDirectory(directory, token) {
  const entries = [];
  let page = 1;
  let total = 0;
  do {
    const result = await postJson("/api/fs/list", {
      path: directory,
      password: "",
      page,
      per_page: 200,
    }, token);
    if (result.code !== 200) throw new Error("OpenList directory listing failed");
    entries.push(...(result.data.content ?? []));
    total = result.data.total ?? entries.length;
    page += 1;
  } while (entries.length < total);
  return entries;
}

function stableRank(value) {
  return createHash("sha256").update(`watchparty-openlist-2026-10\0${value}`).digest("hex");
}

function joinOpenList(parent, name) {
  return `${parent.replace(/\/$/, "")}/${name}`;
}

function relativeToLibrary(openListPath) {
  return openListPath.slice(LIBRARY_ROOT.length + 1);
}

function mediaPath(sample) {
  return joinOpenList(LIBRARY_ROOT, sample.relativePath);
}

async function getMedia(sample, token) {
  return postJson("/api/fs/get", { path: mediaPath(sample) }, token);
}

async function candidatesFromBucket(bucketPath, token) {
  const queue = [bucketPath];
  const candidates = [];
  let directoriesRead = 0;
  while (queue.length && candidates.length < 8 && directoriesRead < 48) {
    const directory = queue.shift();
    directoriesRead += 1;
    const entries = await listDirectory(directory, token);
    for (const entry of entries) {
      const fullPath = joinOpenList(directory, entry.name);
      if (entry.is_dir) queue.push(fullPath);
      else if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        candidates.push(fullPath);
      }
      if (candidates.length >= 8) break;
    }
  }
  return candidates.sort((left, right) => stableRank(left).localeCompare(stableRank(right)));
}

async function replacementAnimeSamples(existingSamples, count, token) {
  const categoryPath = joinOpenList(LIBRARY_ROOT, "Anime");
  const buckets = await listDirectory(categoryPath, token);
  const orderedBuckets = buckets
    .filter((entry) => entry.is_dir)
    .sort((left, right) => stableRank(left.name).localeCompare(stableRank(right.name)));
  const existingPaths = new Set(existingSamples.map((sample) => sample.relativePath));
  const replacements = [];

  for (const bucket of orderedBuckets) {
    if (replacements.length >= count) break;
    const bucketPath = joinOpenList(categoryPath, bucket.name);
    const candidates = await candidatesFromBucket(bucketPath, token);
    for (const candidatePath of candidates) {
      const relativePath = relativeToLibrary(candidatePath);
      if (existingPaths.has(relativePath)) continue;
      const sample = { category: "Anime", relativePath };
      try {
        const result = await getMedia(sample, token);
        if (result.code !== 200 || !result.data?.raw_url) continue;
      } catch {
        continue;
      }
      replacements.push(sample);
      existingPaths.add(relativePath);
      break;
    }
  }
  if (replacements.length < count) {
    throw new Error(`Anime replacement search found ${replacements.length}/${count} files`);
  }
  return replacements;
}

function subtitleAssociation(mediaName, entries) {
  const mediaStem = path.parse(mediaName).name.toLocaleLowerCase();
  const matched = entries.filter((entry) => {
    if (entry.is_dir) return false;
    const extension = path.extname(entry.name).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.has(extension)) return false;
    const stem = path.parse(entry.name).name.toLocaleLowerCase();
    return stem === mediaStem || stem.startsWith(`${mediaStem}.`) || stem.startsWith(`${mediaStem} `);
  });
  return matched.map((entry) => path.extname(entry.name).toLowerCase());
}

function runFfprobe(url) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "debug",
      "-rw_timeout", "15000000",
      "-probesize", "2097152",
      "-analyzeduration", "1000000",
      "-show_error", "-show_format", "-show_streams", "-of", "json", url,
    ];
    const child = spawn("ffprobe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-1_000_000); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-300_000); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Could not start ffprobe: ${error.code ?? error.name}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      let probe = null;
      try { probe = JSON.parse(stdout); } catch {}
      if (probe?.format) delete probe.format.filename;
      resolve({ code, signal, probe, stderr });
    });
  });
}

function summarizeStreams(probe) {
  return (probe?.streams ?? []).map((stream) => ({
    type: stream.codec_type,
    codec: stream.codec_name,
    profile: stream.profile,
    width: stream.width,
    height: stream.height,
    pixelFormat: stream.pix_fmt,
    frameRate: stream.avg_frame_rate,
    channels: stream.channels,
    channelLayout: stream.channel_layout,
    sampleRate: stream.sample_rate,
    language: stream.tags?.language,
  }));
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

async function main() {
  const credentials = parseCredentials(await readFile(CREDENTIALS_PATH, "utf8"));
  if (!credentials.username || !credentials.password) throw new Error("Credentials are incomplete");
  const login = await postJson("/api/auth/login", {
    username: credentials.username,
    password: credentials.password,
  });
  const token = login.data?.token;
  if (login.code !== 200 || !token) throw new Error("OpenList login failed");

  const previous = JSON.parse(
    await readFile(path.join(SCRIPT_DIRECTORY, "sample-manifest.json"), "utf8"),
  );
  const validByCategory = new Map(PLAN.map(({ category }) => [category, []]));
  const missingByCategory = new Map(PLAN.map(({ category }) => [category, 0]));
  for (const sample of previous) {
    const result = await getMedia(sample, token);
    if (result.code === 200 && result.data?.raw_url) validByCategory.get(sample.category)?.push(sample);
    else missingByCategory.set(sample.category, (missingByCategory.get(sample.category) ?? 0) + 1);
  }

  const samples = [];
  for (const { category, quota } of PLAN) {
    const valid = validByCategory.get(category) ?? [];
    const missing = Math.max(0, quota - valid.length);
    const replacements = category === "Anime" && missing > 0
      ? await replacementAnimeSamples(valid, missing, token)
      : [];
    if (valid.length + replacements.length < quota) {
      throw new Error(`${category} has fewer than ${quota} current samples`);
    }
    samples.push(...[...valid.slice(0, quota), ...replacements]
      .map((sample) => ({ category, relativePath: sample.relativePath })));
  }
  const manifest = samples.map((sample, index) => ({ sampleIndex: index + 1, ...sample }));
  const sidecarSummary = { matchedVideoFiles: 0, filesByExtension: {} };
  const sidecarBySample = new Map();
  for (const sample of manifest) {
    const fullPath = mediaPath(sample);
    const parent = fullPath.slice(0, fullPath.lastIndexOf("/"));
    const entries = await listDirectory(parent, token);
    const extensions = subtitleAssociation(path.basename(fullPath), entries);
    sidecarBySample.set(sample.sampleIndex, extensions);
    if (extensions.length) sidecarSummary.matchedVideoFiles += 1;
    for (const extension of extensions) {
      sidecarSummary.filesByExtension[extension] = (sidecarSummary.filesByExtension[extension] ?? 0) + 1;
    }
  }

  const codecFiles = new Map();
  const codecStreams = new Map();
  const videoProfiles = new Map();
  const audioProfiles = new Map();
  const subtitleStreams = new Map();
  const probeResults = [];
  let resolved = 0;
  let failed = 0;
  let bytesRead = 0;
  let advertisedBytes = 0;
  let completeByReportedBytes = 0;
  let httpRequests = 0;
  for (const sample of manifest) {
    const result = await getMedia(sample, token);
    if (result.code !== 200 || !result.data?.raw_url) {
      failed += 1;
      probeResults.push({ ...sample, ok: false, reason: "media-unavailable" });
      continue;
    }
    resolved += 1;
    const probed = await runFfprobe(result.data.raw_url);
    const stats = [...probed.stderr.matchAll(/Statistics:\s*([^\r\n]+)/gi)].map((match) => match[1]);
    const readMatch = stats.join(" ").match(/([\d,]+) bytes read/i);
    const sampleBytes = readMatch ? Number(readMatch[1].replaceAll(",", "")) : 0;
    bytesRead += sampleBytes;
    const size = Number(result.data.size);
    if (Number.isFinite(size) && size > 0) {
      advertisedBytes += size;
      if (sampleBytes >= size) completeByReportedBytes += 1;
    }
    const requestMatch = stats.join(" ").match(/(\d+) requests/i);
    if (requestMatch) httpRequests += Number(requestMatch[1]);

    const streams = summarizeStreams(probed.probe);
    const fileCodecs = new Set();
    for (const stream of streams) {
      const codecKey = `${stream.type}:${stream.codec}`;
      increment(codecStreams, codecKey);
      fileCodecs.add(codecKey);
      if (stream.type === "video") {
        const key = `${stream.codec}|${stream.profile ?? "?"}|${stream.width}x${stream.height}|${stream.pixelFormat ?? "?"}|${stream.frameRate ?? "?"}`;
        increment(videoProfiles, key);
      } else if (stream.type === "audio") {
        const key = `${stream.codec}|${stream.channels ?? "?"}ch ${stream.channelLayout ?? "?"}|${stream.sampleRate ?? "?"}`;
        increment(audioProfiles, key);
      } else if (stream.type === "subtitle") increment(subtitleStreams, stream.codec ?? "unknown");
    }
    for (const codec of fileCodecs) increment(codecFiles, codec);
    const ok = Boolean(probed.probe && probed.code === 0);
    if (!ok) failed += 1;
    probeResults.push({
      ...sample,
      ok,
      advertisedSize: size,
      bytesReportedByFfprobe: sampleBytes,
      externalSubtitles: sidecarBySample.get(sample.sampleIndex) ?? [],
      streams,
    });
  }

  const summary = {
    sampling: {
      requested: manifest.length,
      successfullyProbed: manifest.length - failed,
      failed,
      originalMissingByCategory: Object.fromEntries(missingByCategory),
      quotas: PLAN,
    },
    codecFiles: Object.fromEntries([...codecFiles].sort()),
    codecStreams: Object.fromEntries([...codecStreams].sort()),
    videoProfiles: Object.fromEntries([...videoProfiles].sort()),
    audioProfiles: Object.fromEntries([...audioProfiles].sort()),
    embeddedSubtitleStreams: Object.fromEntries([...subtitleStreams].sort()),
    externalSubtitles: sidecarSummary,
    rangeReads: {
      ffprobeBytesReported: bytesRead,
      advertisedMediaBytes: advertisedBytes,
      samplesReadToAdvertisedSizeOrMore: completeByReportedBytes,
      httpRequestsReported: httpRequests,
    },
  };

  await writeFile(
    path.join(SCRIPT_DIRECTORY, "sample-manifest-current.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(SCRIPT_DIRECTORY, "ffprobe-results-current.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), summary, results: probeResults }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
