import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const SAMPLE_PLAN = [
  { category: "Anime", quota: 34 },
  { category: "Film", quota: 1 },
  { category: "TV Shows", quota: 15 },
];
const VIDEO_EXTENSIONS = new Set([
  ".3gp",
  ".avi",
  ".flv",
  ".m2ts",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".mts",
  ".ts",
  ".webm",
  ".wmv",
]);
const SEED = "watchparty-ffprobe-2026-09-04";
const MAX_CANDIDATES_PER_BUCKET = 8;
const MAX_DIRECTORIES_PER_BUCKET = 48;
const PROBE_TIMEOUT_MS = 45_000;

function parseArguments(argv) {
  const result = {
    root: "K:\\Multimedia",
    output: path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")),
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root" && argv[index + 1]) result.root = argv[++index];
    else if (argv[index] === "--output" && argv[index + 1]) result.output = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
  }
  return result;
}

function stableRank(value) {
  return createHash("sha256").update(`${SEED}\0${value}`).digest("hex");
}

function byName(left, right) {
  return left.name.localeCompare(right.name, "en", { numeric: true, sensitivity: "base" });
}

async function readDirectory(directory) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true })).sort(byName);
  } catch {
    return [];
  }
}

function isVideoFile(name) {
  return VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

async function collectBucketCandidates(bucketPath) {
  const queue = [bucketPath];
  const candidates = [];
  let directoriesRead = 0;
  while (
    queue.length > 0 &&
    candidates.length < MAX_CANDIDATES_PER_BUCKET &&
    directoriesRead < MAX_DIRECTORIES_PER_BUCKET
  ) {
    const directory = queue.shift();
    directoriesRead += 1;
    for (const entry of await readDirectory(directory)) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isFile() && isVideoFile(entry.name)) candidates.push(fullPath);
      else if (entry.isDirectory()) queue.push(fullPath);
      if (candidates.length >= MAX_CANDIDATES_PER_BUCKET) break;
    }
  }
  return candidates.sort((left, right) => stableRank(left).localeCompare(stableRank(right)));
}

async function chooseCategorySamples(libraryRoot, category, quota) {
  const categoryRoot = path.join(libraryRoot, category);
  const entries = await readDirectory(categoryRoot);
  const buckets = entries
    .filter((entry) => entry.isDirectory() || (entry.isFile() && isVideoFile(entry.name)))
    .map((entry) => ({
      name: entry.name,
      path: path.join(categoryRoot, entry.name),
      directFile: entry.isFile(),
      candidates: undefined,
    }))
    .sort((left, right) => stableRank(`${category}/${left.name}`).localeCompare(stableRank(`${category}/${right.name}`)));

  const chosen = [];
  for (let round = 0; round < MAX_CANDIDATES_PER_BUCKET && chosen.length < quota; round += 1) {
    for (const bucket of buckets) {
      if (chosen.length >= quota) break;
      if (!bucket.candidates) {
        bucket.candidates = bucket.directFile
          ? [bucket.path]
          : await collectBucketCandidates(bucket.path);
      }
      const candidate = bucket.candidates[round];
      if (candidate && !chosen.includes(candidate)) chosen.push(candidate);
    }
  }
  if (chosen.length < quota) {
    throw new Error(`${category} only yielded ${chosen.length}/${quota} bounded candidates`);
  }
  return chosen.map((filePath, index) => ({
    sampleIndex: index + 1,
    category,
    relativePath: path.relative(libraryRoot, filePath).split(path.sep).join("/"),
    filePath,
  }));
}

function runFfprobe(filePath) {
  const args = [
    "-v",
    "error",
    "-probesize",
    "2097152",
    "-analyzeduration",
    "1000000",
    "-show_error",
    "-show_format",
    "-show_streams",
    "-of",
    "json",
    filePath,
  ];
  return new Promise((resolve) => {
    const child = spawn("ffprobe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `ffprobe exited ${code}` });
        return;
      }
      try {
        const probe = JSON.parse(stdout);
        // Keep artifacts portable and avoid persisting the machine-specific mount path.
        if (probe.format) delete probe.format.filename;
        resolve({ ok: true, probe });
      } catch {
        resolve({ ok: false, error: "ffprobe returned invalid JSON" });
      }
    });
  });
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

function streamValues(results, type, property) {
  return results.flatMap((result) =>
    result.ok
      ? (result.probe.streams ?? [])
          .filter((stream) => stream.codec_type === type)
          .map((stream) => stream[property] || "unknown")
      : [],
  );
}

function extensionOf(result) {
  return path.extname(result.relativePath).toLowerCase() || "(none)";
}

function bitDepthSignal(stream) {
  const pixelFormat = stream.pix_fmt ?? "";
  const match = pixelFormat.match(/(?:p|gbrp)(10|12|16)(?:le|be)?$/);
  return match ? Number(match[1]) : pixelFormat.includes("10") ? 10 : 8;
}

function summarize(results) {
  const successful = results.filter((result) => result.ok);
  const videoStreams = successful.flatMap((result) =>
    (result.probe.streams ?? []).filter((stream) => stream.codec_type === "video"),
  );
  return {
    requested: results.length,
    successful: successful.length,
    failed: results.length - successful.length,
    categories: countBy(results.map((result) => result.category)),
    extensions: countBy(results.map(extensionOf)),
    videoCodecs: countBy(streamValues(successful, "video", "codec_name")),
    audioCodecs: countBy(streamValues(successful, "audio", "codec_name")),
    subtitleCodecs: countBy(streamValues(successful, "subtitle", "codec_name")),
    tenBitOrHigher: videoStreams.filter((stream) => bitDepthSignal(stream) >= 10).length,
    hdrSignaled: videoStreams.filter((stream) =>
      ["smpte2084", "arib-std-b67"].includes(stream.color_transfer),
    ).length,
    hevc: videoStreams.filter((stream) => stream.codec_name === "hevc").length,
    h264: videoStreams.filter((stream) => stream.codec_name === "h264").length,
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function dictionaryRows(dictionary) {
  const entries = Object.entries(dictionary);
  if (entries.length === 0) return '<tr><td colspan="2">无</td></tr>';
  return entries
    .map(([name, count]) => `<tr><td><code>${escapeHtml(name)}</code></td><td>${count}</td></tr>`)
    .join("");
}

function primaryStream(result, type) {
  return result.ok
    ? (result.probe.streams ?? []).find((stream) => stream.codec_type === type)
    : undefined;
}

function renderReport(results, summary, generatedAt, ffprobeVersion) {
  const rows = results
    .map((result, index) => {
      const video = primaryStream(result, "video");
      const audio = primaryStream(result, "audio");
      const subtitles = result.ok
        ? (result.probe.streams ?? []).filter((stream) => stream.codec_type === "subtitle")
        : [];
      const status = result.ok ? '<span class="ok">成功</span>' : '<span class="bad">失败</span>';
      const videoText = video
        ? `${video.codec_name ?? "?"} ${video.profile ?? ""} ${video.pix_fmt ?? ""} ${video.width ?? "?"}×${video.height ?? "?"}`
        : "无";
      const audioText = audio
        ? `${audio.codec_name ?? "?"} ${audio.channel_layout ?? audio.channels ?? ""}`
        : "无";
      const subtitleText = subtitles.map((stream) => stream.codec_name ?? "?").join(", ") || "无";
      return `<tr>
        <td>${index + 1}</td><td>${escapeHtml(result.category)}</td>
        <td class="path">${escapeHtml(result.relativePath)}</td><td>${escapeHtml(extensionOf(result))}</td>
        <td>${escapeHtml(videoText)}</td><td>${escapeHtml(audioText)}</td><td>${escapeHtml(subtitleText)}</td><td>${status}</td>
      </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WatchParty 媒体库 ffprobe 抽样报告</title>
<style>
:root{color-scheme:dark;font-family:Inter,"Segoe UI",sans-serif;background:#000;color:#f5f5f5}*{box-sizing:border-box}body{margin:0;background:#000;color:#f5f5f5}main{max-width:1500px;margin:auto;padding:28px}h1{font-size:26px;margin:0 0 8px}h2{font-size:18px;margin:30px 0 10px;border-bottom:1px solid #333;padding-bottom:8px}p,li{line-height:1.55;color:#d2d2d2}code{font-family:"Cascadia Code",monospace;color:#87d7ff}.meta{color:#8b8b8b;font-size:13px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));border:1px solid #2a2a2a}.metric{padding:14px;border-right:1px solid #2a2a2a}.metric:last-child{border-right:0}.metric strong{display:block;font-size:25px;color:#fff}.metric span{font-size:12px;color:#969696}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}.panel{border-top:1px solid #444;padding-top:8px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;vertical-align:top;padding:7px 8px;border-bottom:1px solid #242424}th{position:sticky;top:0;background:#080808;color:#aaa}.table-wrap{overflow:auto;max-height:70vh;border:1px solid #242424}.path{min-width:360px;max-width:680px;overflow-wrap:anywhere}.ok{color:#71dc9b}.bad{color:#ff8585}.note{border-left:3px solid #5aa9e6;padding:8px 12px;background:#090d10}ul{padding-left:20px}@media(max-width:700px){main{padding:16px}.metric{border-bottom:1px solid #2a2a2a}.path{min-width:260px}}
</style></head><body><main>
<h1>WatchParty 媒体库 ffprobe 抽样报告</h1>
<p class="meta">生成时间：${escapeHtml(generatedAt)}　ffprobe：${escapeHtml(ffprobeVersion)}</p>
<div class="metrics">
  <div class="metric"><strong>${summary.requested}</strong><span>抽样文件</span></div>
  <div class="metric"><strong>${summary.successful}</strong><span>成功探测</span></div>
  <div class="metric"><strong>${summary.failed}</strong><span>失败/超时</span></div>
  <div class="metric"><strong>${summary.hevc}</strong><span>HEVC 视频流</span></div>
  <div class="metric"><strong>${summary.tenBitOrHigher}</strong><span>10 bit 或更高信号</span></div>
  <div class="metric"><strong>${summary.hdrSignaled}</strong><span>HDR transfer 信号</span></div>
</div>
<h2>方法与边界</h2>
<div class="note"><p>这是面向播放兼容性判断的分层样本，不是库存占比统计。配额为 Anime 34、Film 1、TV Shows 15；Film 当前仅发现 1 个视频文件，因此把剩余名额转给 Anime。优先跨一级目录取样，再在目录内补足。目录遍历和每个目录候选数均有限制。</p></div>
<ul><li>ffprobe 串行运行，<code>probesize=2 MiB</code>、<code>analyzeduration=1 s</code>、单文件 45 秒超时。</li><li>不解码整段视频、不计帧、不计算文件哈希、不读取媒体正文作内容识别。</li><li>云盘驱动仍可能为了 MP4 尾部 moov 或容器索引执行 Range 读取；此成本由容器布局和挂载实现决定。</li><li>报告仅保存媒体库相对路径，不保存挂载地址。</li></ul>
<h2>格式概览</h2><div class="grid">
<section class="panel"><h3>扩展名</h3><table><tbody>${dictionaryRows(summary.extensions)}</tbody></table></section>
<section class="panel"><h3>视频编码</h3><table><tbody>${dictionaryRows(summary.videoCodecs)}</tbody></table></section>
<section class="panel"><h3>音频编码</h3><table><tbody>${dictionaryRows(summary.audioCodecs)}</tbody></table></section>
<section class="panel"><h3>内封字幕编码</h3><table><tbody>${dictionaryRows(summary.subtitleCodecs)}</tbody></table></section>
</div>
<h2>逐文件结果</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>分类</th><th>相对路径</th><th>封装</th><th>主视频流</th><th>主音频流</th><th>内封字幕</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table></div>
</main></body></html>`;
}

async function commandVersion() {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", ["-version"], { windowsHide: true });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", () => resolve(stdout.split(/\r?\n/, 1)[0] || "unknown"));
    child.on("error", () => resolve("unknown"));
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await fs.mkdir(options.output, { recursive: true });
  const samples = [];
  for (const plan of SAMPLE_PLAN) {
    samples.push(...(await chooseCategorySamples(options.root, plan.category, plan.quota)));
  }
  await fs.writeFile(
    path.join(options.output, "sample-manifest.json"),
    `${JSON.stringify(samples.map(({ filePath: _filePath, ...sample }) => sample), null, 2)}\n`,
    "utf8",
  );

  const results = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    process.stdout.write(`[${index + 1}/${samples.length}] ${sample.relativePath}\n`);
    results.push({
      sampleIndex: index + 1,
      category: sample.category,
      relativePath: sample.relativePath,
      ...(await runFfprobe(sample.filePath)),
    });
  }

  const generatedAt = new Date().toISOString();
  const ffprobeVersion = await commandVersion();
  const summary = summarize(results);
  const artifact = {
    generatedAt,
    ffprobeVersion,
    methodology: {
      seed: SEED,
      plan: SAMPLE_PLAN,
      maxCandidatesPerTopLevelBucket: MAX_CANDIDATES_PER_BUCKET,
      maxDirectoriesReadPerBucket: MAX_DIRECTORIES_PER_BUCKET,
      probeSizeBytes: 2_097_152,
      analyzeDurationMicroseconds: 1_000_000,
      probeTimeoutMs: PROBE_TIMEOUT_MS,
    },
    summary,
    results,
  };
  await fs.writeFile(
    path.join(options.output, "ffprobe-results.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(options.output, "report.html"),
    renderReport(results, summary, generatedAt, ffprobeVersion),
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

await main();
