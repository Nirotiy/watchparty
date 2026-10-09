import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OPENLIST = "http://127.0.0.1:5349";
const CREDENTIALS_PATH = "C:\\Users\\Nirotiy\\Documents\\openlist_credentials.json";
const SAMPLE_ROOT = "/media/openlist-bdyun/Multimedia/";
const PROBE_TIMEOUT_MS = 60_000;
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function parseCredentials(source) {
  try {
    return JSON.parse(source);
  } catch {
    return Object.fromEntries(
      source
        .split(/\r?\n/)
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

function runFfprobe(url) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "debug",
      "-rw_timeout", "15000000",
      "-probesize", "2097152",
      "-analyzeduration", "1000000",
      "-show_error",
      "-show_format",
      "-show_streams",
      "-of", "json",
      url,
    ];
    const child = spawn("ffprobe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-1_000_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-300_000);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Could not start ffprobe: ${error.code ?? error.name}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      let probe;
      try {
        probe = JSON.parse(stdout);
      } catch {
        resolve({ code, signal, probe: null, stderr });
        return;
      }
      resolve({ code, signal, probe, stderr });
    });
  });
}

async function main() {
  const credentials = parseCredentials(await readFile(CREDENTIALS_PATH, "utf8"));
  if (!credentials.username || !credentials.password) {
    throw new Error("Credentials file must provide username and password");
  }

  const login = await postJson("/api/auth/login", {
    username: credentials.username,
    password: credentials.password,
  });
  const token = login.data?.token;
  if (login.code !== 200 || !token) throw new Error("OpenList login failed");

  const manifest = JSON.parse(
    await readFile(path.join(SCRIPT_DIRECTORY, "sample-manifest.json"), "utf8"),
  );
  const codecFiles = new Map();
  const codecStreams = new Map();
  const trackGroups = new Map();
  const categoryTotals = new Map();
  let resolved = 0;
  let probed = 0;
  let failed = 0;
  let bytesRead = 0;
  let advertisedBytes = 0;
  let filesReadToAdvertisedSizeOrMore = 0;
  let httpRequests = 0;
  let rangeRequests = 0;

  for (let index = 0; index < manifest.length; index += 1) {
    const sample = manifest[index];
    const category = categoryTotals.get(sample.category) ?? {
      requested: 0,
      resolved: 0,
      probed: 0,
    };
    category.requested += 1;
    categoryTotals.set(sample.category, category);

    try {
      const pathInOpenList = SAMPLE_ROOT + sample.relativePath;
      const result = await postJson("/api/fs/get", { path: pathInOpenList }, token);
      if (result.code !== 200 || !result.data?.raw_url) continue;
      resolved += 1;
      category.resolved += 1;

      const probeResult = await runFfprobe(result.data.raw_url);
      const probe = probeResult.probe;
      const stats = [...probeResult.stderr.matchAll(/Statistics:\s*([^\r\n]+)/gi)]
        .map((match) => match[1]);
      const readMatch = stats.join(" ").match(/([\d,]+) bytes read/i);
      const sampleBytesRead = readMatch ? Number(readMatch[1].replaceAll(",", "")) : 0;
      bytesRead += sampleBytesRead;
      const sampleSize = Number(result.data.size);
      if (Number.isFinite(sampleSize) && sampleSize > 0) {
        advertisedBytes += sampleSize;
        if (sampleBytesRead >= sampleSize) filesReadToAdvertisedSizeOrMore += 1;
      }
      const requestMatch = stats.join(" ").match(/(\d+) requests/i);
      if (requestMatch) httpRequests += Number(requestMatch[1]);
      rangeRequests += new Set(
        [...probeResult.stderr.matchAll(/Range:\s*bytes=(\d+-\d*)/gi)]
          .map((match) => match[1]),
      ).size;

      if (probe && probeResult.code === 0) {
        probed += 1;
        category.probed += 1;
        const fileCodecKeys = new Set();
        const fileTrackKeys = new Set();
        for (const stream of probe.streams ?? []) {
          const type = stream.codec_type ?? "unknown";
          const codec = stream.codec_name ?? "unknown";
          const codecKey = `${type}:${codec}`;
          codecStreams.set(codecKey, (codecStreams.get(codecKey) ?? 0) + 1);
          fileCodecKeys.add(codecKey);

          const details = type === "video"
            ? {
                type,
                codec,
                profile: stream.profile ?? null,
                resolution: stream.width && stream.height ? `${stream.width}x${stream.height}` : null,
                pixelFormat: stream.pix_fmt ?? null,
                frameRate: stream.avg_frame_rate ?? null,
              }
            : type === "audio"
              ? {
                  type,
                  codec,
                  channels: stream.channels ?? null,
                  channelLayout: stream.channel_layout ?? null,
                  sampleRate: stream.sample_rate ?? null,
                }
              : { type, codec };
          const trackKey = JSON.stringify(details);
          let group = trackGroups.get(trackKey);
          if (!group) {
            group = { ...details, files: 0, streams: 0 };
            trackGroups.set(trackKey, group);
          }
          group.streams += 1;
          if (!fileTrackKeys.has(trackKey)) {
            group.files += 1;
            fileTrackKeys.add(trackKey);
          }
        }
        for (const key of fileCodecKeys) codecFiles.set(key, (codecFiles.get(key) ?? 0) + 1);
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }

  process.stdout.write(`${JSON.stringify({
    sampleCount: manifest.length,
    resolvedInOpenList: resolved,
    successfullyProbed: probed,
    failedOrMissing: manifest.length - probed,
    categoryTotals: Object.fromEntries(categoryTotals),
    codecFiles: Object.fromEntries([...codecFiles].sort()),
    codecStreams: Object.fromEntries([...codecStreams].sort()),
    trackSummary: [...trackGroups.values()].sort((left, right) =>
      `${left.type}:${left.codec}:${left.profile ?? ""}:${left.resolution ?? ""}`
        .localeCompare(`${right.type}:${right.codec}:${right.profile ?? ""}:${right.resolution ?? ""}`),
    ),
    rangeReads: {
      ffprobeBytesReported: bytesRead,
      advertisedMediaBytes: advertisedBytes,
      filesReadToAdvertisedSizeOrMore,
      httpRequestsReported: httpRequests,
      distinctRangeHeadersObserved: rangeRequests,
    },
  }, null, 2)}\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
