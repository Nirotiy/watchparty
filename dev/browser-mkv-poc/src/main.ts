import "./style.css";
import { LibavSession, packetDecodeSeconds, packetSeconds, type MediaStream } from "./libav-session";
import { RangeFile, type RangeMetrics } from "./range-file";
import type { Packet } from "@libav.js/types";

type TrackRow = { kind: "VIDEO" | "AUDIO" | "SUB"; codec: string; details: string; language: string; streamIndex: number };
type DeferredUrl = { resolve: (url: string) => void; timeout: number };

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing app root");

app.innerHTML = `
  <main>
    <header>
      <div><div class="eyebrow">ISOLATED BROWSER POC / MATRIX V1</div><h1>MKV 解码流水线</h1><p>直连 Range → Matroska demux → WebCodecs · 本地轨道偏好 · 无房间状态</p></div>
      <div class="runtime"><span id="isolation-dot" class="dot"></span><span id="isolation-label">跨源隔离检测中</span><span class="divider"></span><span id="browser-label">浏览器检测中</span></div>
    </header>
    <section class="source-bar" aria-label="媒体源">
      <div class="source-mode"><button class="mode selected" data-mode="url">签名 URL</button><button class="mode" data-mode="file">本机文件</button></div>
      <label class="url-field" id="url-wrap"><span>媒体 URL</span><input id="media-url" type="url" autocomplete="off" spellcheck="false" placeholder="粘贴短时签名 MKV URL，只保留在当前页面内存" /><button id="refresh-url" class="icon-button" title="刷新签名 URL" aria-label="刷新签名 URL">↻</button></label>
      <label class="file-field hidden" id="file-wrap"><span>选择 MKV</span><input id="media-file" type="file" accept=".mkv,.webm,video/x-matroska" /></label>
      <button id="inspect" class="primary-button">检查并载入</button>
    </section>
    <div class="workspace">
      <section class="left-column">
        <div class="video-panel">
          <div class="panel-top"><span>FRAME OUTPUT</span><span id="decode-state" class="state neutral">等待媒体源</span></div>
          <div class="frame-stage">
            <canvas id="frame-canvas" width="960" height="540" aria-label="解码帧输出"></canvas>
            <canvas id="subtitle-canvas" width="960" height="540" aria-hidden="true"></canvas>
          </div>
          <div class="player-controls"><button id="play-toggle" class="icon-button" title="播放视频轨" aria-label="播放视频轨" disabled>▶</button><button id="prev-frame" class="icon-button" title="向前 seek 10 秒" aria-label="向前 seek 10 秒">−10</button><input id="seek-range" type="range" min="0" max="100" value="0" disabled aria-label="播放位置" /><button id="next-frame" class="icon-button" title="向后 seek 10 秒" aria-label="向后 seek 10 秒">+10</button><span id="seek-time" class="mono">00:00 / --:--</span></div>
          <div id="limitations" class="limitations">连续视频包测试已接入；音频输出、A/V sync 與 20 分鐘基準尚未驗收。</div>
        </div>
        <div class="event-panel"><div class="panel-heading"><h2>运行事件</h2><button id="clear-events" class="text-button">清除</button></div><ol id="events" class="events" aria-live="polite"></ol></div>
      </section>
      <aside class="right-column">
        <section class="section-block"><div class="section-heading"><h2>解码流水线</h2><span id="run-id" class="mono muted">RUN / --</span></div>
          <ol class="pipeline">
            <li><span class="stage-no">01</span><div><strong>签名媒体源</strong><small id="source-detail">仅内存态；不进入 URL、日志或存储</small></div><span id="source-state" class="state neutral">等待</span></li>
            <li><span class="stage-no">02</span><div><strong>HTTP Range</strong><small id="range-detail">206、Content-Range、CORS 暴露头</small></div><span id="range-state" class="state neutral">等待</span></li>
            <li><span class="stage-no">03</span><div><strong>Matroska demux</strong><small id="demux-detail">Info / Tracks / Cues / packet offset</small></div><span id="demux-state" class="state neutral">等待</span></li>
            <li><span class="stage-no">04</span><div><strong>WebCodecs</strong><small id="codec-detail">每条轨单独 isConfigSupported</small></div><span id="codec-state" class="state neutral">等待</span></li>
            <li><span class="stage-no">05</span><div><strong>WASM 软件解码</strong><small>用户确认后加载；LGPL 组件审核未完成</small></div><span id="wasm-state" class="state warn">待选型</span></li>
          </ol>
        </section>
        <section class="section-block"><div class="section-heading"><h2>媒体轨道</h2><span class="scope-note">仅本地选择</span></div><div id="tracks" class="tracks empty">检查媒体后显示轨道及原生能力。</div><div id="subtitle-note" class="note hidden"></div></section>
        <section class="section-block"><div class="section-heading"><h2>Range / seek 诊断</h2><span id="cors-state" class="state neutral">未测</span></div><div class="metrics"><div><span>请求数</span><strong id="metric-requests">0</strong></div><div><span>读取量</span><strong id="metric-bytes">0 B</strong></div><div><span>seek 延迟</span><strong id="metric-seek">--</strong></div></div><div class="metric-foot"><span>文件声明大小</span><strong id="metric-size">--</strong><span>完整媒体下载</span><strong id="metric-full">未发生</strong></div><progress id="wasm-progress" max="100" value="0"></progress>
          <div id="wasm-consent" class="consent hidden"><div><strong>原生解码器无法满足此轨道</strong><span>WASM 组件尚未通过 LGPL / 源码义务审查，当前不会下载或执行。</span></div><button id="wasm-confirm" class="secondary-button" disabled>确认加载</button><button id="mpv-fallback" class="secondary-button">交给 MPV</button></div>
        </section>
      </aside>
    </div>
    <footer><span>样本矩阵：H.264 Main 1080p30 / AAC stereo · HEVC Main 10 / FLAC · ASS / SRT</span><span>libav.js 6.10.9 · LGPL-2.1 · bridge ISC</span><span>本页为隔离验证工具，不接入房间播放器</span></footer>
  </main>`;

const $ = <T extends HTMLElement>(selector: string) => {
  const element = app.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};
const canvas = $("#frame-canvas") as HTMLCanvasElement;
const context = canvas.getContext("2d");
let subtitleCanvas = $("#subtitle-canvas") as HTMLCanvasElement;
const urlInput = $("#media-url") as HTMLInputElement;
const fileInput = $("#media-file") as HTMLInputElement;
const seekInput = $("#seek-range") as HTMLInputElement;
const eventList = $("#events");
let activeMode: "url" | "file" = "url";
let source: RangeFile | File | null = null;
let session: LibavSession | null = null;
let streams: MediaStream[] = [];
let videoTrack: MediaStream | null = null;
let audioTrack: MediaStream | null = null;
let subtitleTrack: MediaStream | null = null;
let durationSeconds = 0;
let playbackAbort: AbortController | null = null;
let activeDecoder: VideoDecoder | null = null;
let activeAudioDecoder: AudioDecoder | null = null;
let audioContext: AudioContext | null = null;
let audioGain: GainNode | null = null;
const audioMuted = new URLSearchParams(location.search).get("mute") === "1";
const query = new URLSearchParams(location.search);
const videoOnlyDiagnostic = query.get("video-only") === "1";
const requestedReadLimit = Number(query.get("read-limit"));
const playbackReadLimit = Number.isSafeInteger(requestedReadLimit) && requestedReadLimit >= 64 * 1024 && requestedReadLimit <= 2 * 1024 * 1024
  ? requestedReadLimit
  : 512 * 1024;
const requestedRate = Number(query.get("rate"));
let playbackRate = Number.isFinite(requestedRate) && requestedRate >= 0.5 && requestedRate <= 2 ? requestedRate : 1;
const DECODE_LEAD_MS = 600;
const PRESENT_DUE_TOLERANCE_MS = 10;
let playbackStartWall = 0;
let playbackStartPts = 0;
let videoDecodeBaseDts: number | null = null;
let videoDecodeBaseOffset = 0;
let videoDecodeScheduleSeconds = 0;
/** Single media→wall mapping shared by video presentation, packet pacing and audio scheduling. */
const mediaDueMs = (mediaSeconds: number) => playbackStartWall + ((mediaSeconds - playbackStartPts) * 1000) / playbackRate;
let audioScheduledBuffers = 0;
let audioDroppedBuffers = 0;
let audioOutputLatenessMs: number[] = [];
let audioOutputTimestampAgeMs: number[] = [];
let audioOutputPtsGapsMs: number[] = [];
let lastAudioOutputEndPts: number | null = null;
let decodedOutputFrames = 0;
let lateFrames = 0;
let previousOutputTimestamp: number | null = null;
let outputPtsGapsMs: number[] = [];
let decodeCallbackDelaysMs: number[] = [];
let decoderOutputIntervalsMs: number[] = [];
let lastDecoderOutputAt: number | null = null;
let telemetryMaxDecodeGapMs = 0;
let telemetryMaxRafGapMs = 0;
const pocTelemetry: { lastAt: number; ticks: Array<{ t: number; decoded: number; coalesced: number; maxDecodeGapMs: number; maxRafGapMs: number }> } = { lastAt: 0, ticks: [] };
let videoPacketSubmitIntervalsMs: number[] = [];
let lastVideoPacketSubmitAt: number | null = null;
let videoPacketPtsRegressions = 0;
let lastSubmittedVideoPacketPts: number | null = null;
let decodeQueueWaitMs = 0;
let decodeQueueWaitEvents = 0;
let packetReadDurationsMs: number[] = [];
let canvasDrawDurationsMs: number[] = [];
let canvasRenderVersion = 0;
let canvasObservedVersion = 0;
let canvasPresentedFrames = 0;
let canvasCoalescedFrames = 0;
let canvasPresentIntervalsMs: number[] = [];
let canvasPresentedPtsGapsMs: number[] = [];
let canvasLastPresentedAt: number | null = null;
let canvasLastPresentedPts: number | null = null;
let canvasLatestOutputPts: number | null = null;
let playbackLongTaskObserver: PerformanceObserver | null = null;
let playbackLongTaskCount = 0;
let playbackLongTaskMs = 0;
let playbackMaxLongTaskMs = 0;
const presentQueue: Array<{ frame: VideoFrame; dueMs: number }> = [];
let activeCaption = "";
let activeCaptionUntil = 0;
let pendingUrl: DeferredUrl | null = null;
let jassub: import("jassub").default | null = null;
let jassubTrackIndex = -1;
let subtitleRenderPending = false;
let subtitleRenderErrorReported = false;

function event(message: string, kind: "ok" | "warn" | "error" | "info" = "info") {
  const row = document.createElement("li");
  row.className = kind;
  const timestamp = document.createElement("time");
  timestamp.textContent = new Date().toLocaleTimeString("zh-HK", { hour12: false });
  const text = document.createElement("span");
  text.textContent = message;
  row.append(timestamp, text);
  eventList.prepend(row);
  while (eventList.children.length > 60) eventList.lastElementChild?.remove();
}

function setState(id: string, text: string, tone: "neutral" | "ok" | "warn" | "error") {
  const target = $(`#${id}`);
  target.textContent = text;
  target.className = `state ${tone}`;
}

function updateMetrics(metrics: RangeMetrics) {
  $("#metric-requests").textContent = String(metrics.requests);
  $("#metric-bytes").textContent = formatBytes(metrics.bytes);
  $("#metric-size").textContent = metrics.size ? formatBytes(metrics.size) : "--";
  $("#metric-full").textContent = metrics.fullBodyRejected
    ? "已取消 200 正文"
    : metrics.requests === 0
      ? "本机文件"
      : metrics.size > 0 && metrics.coveredBytes >= metrics.size
        ? "Range 已覆盖全片"
        : `Range 覆盖 ${metrics.size ? Math.round(metrics.coveredBytes / metrics.size * 100) : 0}%`;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function renderTracks(rows: TrackRow[]) {
  const wrapper = $("#tracks");
  wrapper.classList.remove("empty");
  wrapper.replaceChildren();
  if (!rows.length) {
    wrapper.textContent = "未识别到可读轨道";
    return;
  }
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "track-row";
    const label = document.createElement("span");
    label.className = "track-kind";
    label.textContent = row.kind;
    const details = document.createElement("div");
    details.className = "track-details";
    const title = document.createElement("strong");
    title.textContent = row.codec;
    const subtitle = document.createElement("small");
    subtitle.textContent = `${row.details}${row.language ? ` · ${row.language}` : ""}`;
    const local = document.createElement("span");
    local.className = "track-local";
    const select = document.createElement("input");
    select.type = "radio";
    select.name = `local-${row.kind}`;
    select.value = String(row.streamIndex);
    select.checked = wrapper.querySelector(`input[name="local-${row.kind}"]`) === null;
    select.setAttribute("aria-label", `选择本地${row.kind}轨道`);
    select.addEventListener("change", () => {
      const stream = streams.find((candidate) => candidate.index === row.streamIndex) ?? null;
      if (row.kind === "VIDEO") videoTrack = stream;
      if (row.kind === "AUDIO") audioTrack = stream;
      if (row.kind === "SUB") {
        subtitleTrack = stream;
        if (stream) void activateSubtitleTrack(stream).catch((error) => {
          event(`字幕初始化失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
        });
      }
      event(`${row.kind} 轨道本地切换为 ${row.streamIndex}。`, "info");
    });
    local.append(select, document.createTextNode("本地"));
    details.append(title, subtitle);
    item.append(label, details, local);
    wrapper.append(item);
  }
}

function waitForSignedUrl() {
  return new Promise<string>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingUrl = null;
      reject(new Error("等待新签名 URL 超时"));
    }, 60_000);
    pendingUrl = { resolve, timeout };
  });
}

async function loadMedia() {
  await clearMedia();
  const id = `POC-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  $("#run-id").textContent = `RUN / ${id}`;
  try {
    if (activeMode === "url") {
      const mediaUrl = urlInput.value.trim();
      if (!mediaUrl) throw new Error("请粘贴有效的短时签名 URL");
      const parsed = new URL(mediaUrl);
      if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") throw new Error("远程媒体源必须使用 HTTPS");
      source = new RangeFile(mediaUrl, updateMetrics, async () => {
        event("签名 URL 返回 403。请在 60 秒内粘贴刷新后的同一媒体 URL。", "warn");
        return waitForSignedUrl();
      });
      setState("source-state", "内存态", "ok");
    } else {
      const picked = fileInput.files?.[0];
      if (!picked) throw new Error("请选择一个 MKV 文件");
      source = picked;
      setState("source-state", "本机文件", "ok");
    }
    $("#source-detail").textContent = activeMode === "url" ? "短时 URL 仅在本页内存；403 后刷新一次" : "本机文件由同一块设备接口读取";
    event("媒体源已载入内存，本次运行不会写入浏览器存储。", "ok");

    const rangeStart = performance.now();
    const firstRange = source instanceof RangeFile
      ? await source.probe()
      : { ok: true as const, status: 0, size: source.size, reason: "本机 File.slice 对照" };
    updateMetrics(source instanceof RangeFile ? source.metrics : fileMetrics(source));
    if (!firstRange.ok) {
      setState("range-state", "不可用", "error");
      setState("cors-state", "源不符合", "error");
      $("#range-detail").textContent = firstRange.reason;
      throw new Error(firstRange.reason);
    }
    const elapsed = Math.round(performance.now() - rangeStart);
    setState("range-state", activeMode === "url" ? "206 / Range OK" : "slice OK", "ok");
    setState("cors-state", activeMode === "url" ? "可读" : "本机", "ok");
    $("#range-detail").textContent = `${firstRange.status || "Blob"} · 首区间 ${elapsed} ms`;
    event(`Range 首段检查成功，状态 ${firstRange.status || "File.slice"}，${elapsed} ms。`, "ok");

    session = await LibavSession.open(source);
    streams = session.streams;
    const libav = session.libav;
    const videoStreams = streams.filter((stream) => stream.codec_type === libav.AVMEDIA_TYPE_VIDEO);
    const audioStreams = streams.filter((stream) => stream.codec_type === libav.AVMEDIA_TYPE_AUDIO);
    const subtitleStreams = streams.filter((stream) => stream.codec_type === libav.AVMEDIA_TYPE_SUBTITLE);
    videoTrack = videoStreams[0] ?? null;
    audioTrack = audioStreams[0] ?? null;
    subtitleTrack = subtitleStreams.find((stream) => stream.codec !== "hdmv_pgs_subtitle") ?? subtitleStreams[0] ?? null;
    durationSeconds = session.durationSeconds;
    seekInput.disabled = false;
    $("#play-toggle").removeAttribute("disabled");
    seekInput.max = String(Math.max(1, Math.floor(durationSeconds)));
    $("#seek-time").textContent = `00:00 / ${durationSeconds ? clock(durationSeconds) : "--:--"}`;

    const rows: TrackRow[] = [];
    let videoSupported = false;
    for (const stream of videoStreams) {
      const config = stream.config as VideoDecoderConfig | null;
      const supported = Boolean(config && globalThis.VideoDecoder && (await VideoDecoder.isConfigSupported(config)).supported);
      videoSupported ||= supported;
      rows.push({
        kind: "VIDEO",
        streamIndex: stream.index,
        codec: `${stream.codec} / ${config?.codec ?? "unknown"}`,
        details: `${config && "codedWidth" in config ? `${config.codedWidth} × ${config.codedHeight}` : "尺寸未知"} · ${supported ? "WebCodecs 可解" : "WebCodecs 不支持"}`,
        language: stream.metadata?.language ?? "und",
      });
      event(`WebCodecs video ${stream.codec}: ${supported ? "config supported" : "unsupported"}.`, supported ? "ok" : "warn");
    }
    for (const stream of audioStreams) {
      const config = stream.config as AudioDecoderConfig | null;
      const supported = Boolean(config && globalThis.AudioDecoder && (await AudioDecoder.isConfigSupported(config)).supported);
      rows.push({
        kind: "AUDIO",
        streamIndex: stream.index,
        codec: `${stream.codec} / ${config?.codec ?? "unknown"}`,
        details: `${config && "numberOfChannels" in config ? `${config.numberOfChannels} ch · ${config.sampleRate} Hz` : "参数未知"} · ${supported ? "WebCodecs 可解" : "WebCodecs 不支持"}`,
        language: stream.metadata?.language ?? "und",
      });
      event(`WebCodecs audio ${stream.codec}: ${supported ? "config supported" : "unsupported"}.`, supported ? "ok" : "warn");
    }
    for (const stream of subtitleStreams) {
      rows.push({
        kind: "SUB",
        streamIndex: stream.index,
        codec: stream.codec,
        details: stream.codec === "hdmv_pgs_subtitle" ? "PGS 图像字幕，仅识别，不渲染" : "demux 循环直接提取字幕包",
        language: stream.metadata?.language ?? "und",
      });
    }
    renderTracks(rows);
    if (subtitleTrack && !videoOnlyDiagnostic) await activateSubtitleTrack(subtitleTrack);
    $("#demux-detail").textContent = `${rows.length} 条轨道 · libav packet reader`;
    $("#subtitle-note").classList.toggle("hidden", subtitleStreams.length === 0);
    $("#subtitle-note").textContent = subtitleStreams.length ? "SubRip / ASS 字幕包随 demux 批次提取；PGS 只识别，不渲染。" : "此媒体未发现内嵌字幕轨。";
    setState("demux-state", "Tracks 已解析 · FFmpeg", "ok");
    setState("codec-state", videoSupported ? "Video API 可用" : "需回退", videoSupported ? "ok" : "warn");
    $("#codec-detail").textContent = videoTrack?.config?.codec ?? "无视频轨";
    setState("decode-state", videoSupported ? "能力回报可用，待实际解码" : "需要确认软解回退", "warn");
    $("#wasm-consent").classList.toggle("hidden", videoSupported);
    event(`libav.js Matroska tracks 已解析：${rows.length} 轨；时长 ${clock(durationSeconds)}。`, "ok");
    updateMetrics(source instanceof RangeFile ? source.metrics : fileMetrics(source));
  } catch (error) {
    const message = error instanceof Error ? error.message : "载入失败";
    event(message, "error");
    setState("source-state", "错误", "error");
    setState("demux-state", "demux 失败", "error");
  }
}

function fileMetrics(file: File): RangeMetrics {
  return { requests: 0, bytes: 0, coveredBytes: 0, size: file.size, fullBodyRejected: false };
}

function clock(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

async function seekTo(seconds: number) {
  if (!session || !videoTrack) return;
  const started = performance.now();
  try {
    stopVideoPlayback();
    await session.seek(seconds, videoTrack);
    await decodeUntilVideoFrame(session);
    const elapsed = Math.round(performance.now() - started);
    $("#metric-seek").textContent = `${elapsed} ms`;
    seekInput.value = String(Math.floor(seconds));
    $("#seek-time").textContent = `${clock(seconds)} / ${durationSeconds ? clock(durationSeconds) : "--:--"}`;
    $("#limitations").textContent = `libav av_seek_frame + WebCodecs 首帧 · ${elapsed} ms；连续播放门槛仍未测`;
    setState("decode-state", "seek 后首帧解码成功", elapsed < 3000 ? "ok" : "warn");
    event(`libav seek ${clock(seconds)}，恢复首帧用时 ${elapsed} ms。`, elapsed < 3000 ? "ok" : "warn");
    if (source instanceof RangeFile) {
      const newRanges = source.requests.slice(-12);
      event(`seek 期间最近 Range: ${newRanges.map(({ pos, length }) => `${pos}+${length}`).join(", ") || "无新请求"}。`, "info");
      updateMetrics(source.metrics);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "seek 失败";
    setState("decode-state", "seek / 解码失败", "error");
    event(message, "error");
  }
}

async function decodeUntilVideoFrame(activeSession: LibavSession) {
  if (!videoTrack?.config || !globalThis.VideoDecoder) throw new Error("WebCodecs 视频配置不可用");
  let outputFrame = false;
  const decoder = new VideoDecoder({
    output(frame) {
      drawFrame(frame);
      frame.close();
      outputFrame = true;
    },
    error(error) {
      event(`WebCodecs seek decode: ${error.message}`, "error");
    },
  });
  decoder.configure(videoTrack.config as VideoDecoderConfig);
  for (let batchIndex = 0; batchIndex < 100 && decoder.state === "configured"; batchIndex += 1) {
    const batch = await activeSession.readPackets();
    for (const packet of flattenPackets(batch)) {
      if (subtitleTrack && packet.stream_index === subtitleTrack.index) renderSubtitlePacket(packet, subtitleTrack);
      if (packet.stream_index !== videoTrack.index) continue;
      decoder.decode(activeSession.videoChunk(packet, videoTrack));
      await decoder.flush();
      if (outputFrame) {
        decoder.close();
        return;
      }
    }
    if (batch.result === activeSession.libav.AVERROR_EOF) break;
  }
  if (decoder.state !== "closed") decoder.close();
  throw new Error("libav seek 后没有输出首帧");
}

async function toggleVideoPlayback() {
  if (playbackAbort) {
    stopVideoPlayback();
    return;
  }
  if (!session || !videoTrack || !videoTrack.config) return;
  const controller = new AbortController();
  playbackAbort = controller;
  const button = $("#play-toggle") as HTMLButtonElement;
  button.textContent = "Ⅱ";
  button.title = "暂停视频轨";
  button.setAttribute("aria-label", "暂停视频轨");
  const startAt = Number(seekInput.value);
  try {
    await session.seek(startAt, videoTrack);
    const startPackets = await session.readPackets();
    const firstVideoPacket = flattenPackets(startPackets).find((packet) => packet.stream_index === videoTrack?.index);
    if (!firstVideoPacket) throw new Error("seek 起点后没有视频包");
    playbackStartPts = packetSeconds(firstVideoPacket, videoTrack);
    playbackStartWall = performance.now();
    videoDecodeBaseDts = null;
    videoDecodeBaseOffset = 0;
    videoDecodeScheduleSeconds = 0;
    audioScheduledBuffers = 0;
    audioDroppedBuffers = 0;
    audioOutputLatenessMs = [];
    audioOutputTimestampAgeMs = [];
    audioOutputPtsGapsMs = [];
    lastAudioOutputEndPts = null;
    decodedOutputFrames = 0;
    lateFrames = 0;
    previousOutputTimestamp = null;
    outputPtsGapsMs = [];
    decodeCallbackDelaysMs = [];
    decoderOutputIntervalsMs = [];
    lastDecoderOutputAt = null;
    videoPacketSubmitIntervalsMs = [];
    lastVideoPacketSubmitAt = null;
    videoPacketPtsRegressions = 0;
    lastSubmittedVideoPacketPts = null;
    decodeQueueWaitMs = 0;
    decodeQueueWaitEvents = 0;
    packetReadDurationsMs = [];
    canvasDrawDurationsMs = [];
    canvasRenderVersion = 0;
    canvasObservedVersion = 0;
    canvasPresentedFrames = 0;
    canvasCoalescedFrames = 0;
    canvasPresentIntervalsMs = [];
    canvasPresentedPtsGapsMs = [];
    canvasLastPresentedAt = null;
    canvasLastPresentedPts = null;
    canvasLatestOutputPts = null;
    playbackLongTaskCount = 0;
    playbackLongTaskMs = 0;
    playbackMaxLongTaskMs = 0;
    playbackLongTaskObserver?.disconnect();
    playbackLongTaskObserver = null;
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      playbackLongTaskObserver = new PerformanceObserver((list) => recordLongTasks(list.getEntries()));
      playbackLongTaskObserver.observe({ type: "longtask", buffered: false });
    }
    activeDecoder = new VideoDecoder({
      output(frame) {
        const outputAt = performance.now();
        if (lastDecoderOutputAt !== null) {
          const gap = outputAt - lastDecoderOutputAt;
          decoderOutputIntervalsMs.push(gap);
          telemetryMaxDecodeGapMs = Math.max(telemetryMaxDecodeGapMs, gap);
        }
        lastDecoderOutputAt = outputAt;
        const due = mediaDueMs(frame.timestamp / 1_000_000);
        const callbackDelay = outputAt - due;
        decodeCallbackDelaysMs.push(callbackDelay);
        if (callbackDelay > 42) lateFrames += 1;
        if (previousOutputTimestamp !== null) {
          const ptsGap = (frame.timestamp - previousOutputTimestamp) / 1000;
          if (ptsGap > 0) outputPtsGapsMs.push(ptsGap);
        }
        previousOutputTimestamp = frame.timestamp;
        presentQueue.push({ frame, dueMs: due });
        decodedOutputFrames += 1;
        seekInput.value = String(Math.min(durationSeconds, frame.timestamp / 1_000_000));
        $("#seek-time").textContent = `${clock(frame.timestamp / 1_000_000)} / ${clock(durationSeconds)}`;
        pushTelemetry(outputAt);
      },
      error(error) {
        event(`WebCodecs playback error: ${error.message}`, "error");
        stopVideoPlayback();
      },
    });
    activeDecoder.configure(videoTrack.config as VideoDecoderConfig);
    const videoDecoder = activeDecoder;
    if (!videoOnlyDiagnostic && audioTrack?.config && globalThis.AudioDecoder) {
      activeAudioDecoder = createAudioDecoder(audioTrack);
      activeAudioDecoder.configure(audioTrack.config as AudioDecoderConfig);
      await audioContext?.resume();
    }
    setState("decode-state", "A/V demux 与解码中", "warn");
    event(`开始 libav.js 分批 demux / WebCodecs，起点 ${clock(startAt)}，每批上限 ${formatBytes(playbackReadLimit)}。`, "ok");
    if (audioMuted) event("静音播放已启用：音频仍解码，但输出增益为 0。", "info");
    if (videoOnlyDiagnostic) event("诊断模式：跳过音频解码与字幕渲染。", "warn");
    requestAnimationFrame(observeCanvasPresentation);
    requestAnimationFrame(presentDueFrames);
    let pending: Packet[] = flattenPackets(startPackets);
    for (let batchIndex = 0; batchIndex < 200000 && !controller.signal.aborted; batchIndex += 1) {
      if (!pending.length) {
        const readStarted = performance.now();
        const batch = await session.readPackets(playbackReadLimit);
        packetReadDurationsMs.push(performance.now() - readStarted);
        pending = flattenPackets(batch);
        if (batch.result === session.libav.AVERROR_EOF && !pending.length) break;
      }
      for (const packet of pending) {
        if (controller.signal.aborted) break;
        if (videoTrack && packet.stream_index === videoTrack.index) {
          const seconds = packetSeconds(packet, videoTrack);
          const dts = packetDecodeSeconds(packet, videoTrack, session.libav);
          if (dts !== null) {
            if (videoDecodeBaseDts === null) {
              videoDecodeBaseDts = dts;
              videoDecodeBaseOffset = videoDecodeScheduleSeconds;
            }
            videoDecodeScheduleSeconds = Math.max(
              videoDecodeScheduleSeconds,
              videoDecodeBaseOffset + dts - videoDecodeBaseDts,
            );
          }
          const packetDue = mediaDueMs(playbackStartPts + videoDecodeScheduleSeconds) - DECODE_LEAD_MS;
          while (!controller.signal.aborted && packetDue > performance.now()) {
            await delay(Math.min(packetDue - performance.now(), 100));
          }
          while (!controller.signal.aborted && videoDecoder.state === "configured" && videoDecoder.decodeQueueSize > 24) {
            const waitStarted = performance.now();
            await delay(4);
            decodeQueueWaitMs += performance.now() - waitStarted;
            decodeQueueWaitEvents += 1;
          }
          if (!controller.signal.aborted && videoDecoder.state === "configured") {
            const submittedAt = performance.now();
            if (lastVideoPacketSubmitAt !== null) videoPacketSubmitIntervalsMs.push(submittedAt - lastVideoPacketSubmitAt);
            lastVideoPacketSubmitAt = submittedAt;
            if (packet.pts !== undefined && packet.pts !== null) {
              if (lastSubmittedVideoPacketPts !== null && seconds < lastSubmittedVideoPacketPts) videoPacketPtsRegressions += 1;
              lastSubmittedVideoPacketPts = seconds;
            }
            videoDecoder.decode(session.videoChunk(packet, videoTrack));
          }
          const packetDuration = packetDurationSeconds(packet, videoTrack);
          videoDecodeScheduleSeconds += packetDuration > 0 ? packetDuration : 1 / 30;
        } else if (audioTrack && packet.stream_index === audioTrack.index && activeAudioDecoder?.state === "configured") {
          activeAudioDecoder.decode(session.audioChunk(packet, audioTrack));
        } else if (!videoOnlyDiagnostic && subtitleTrack && packet.stream_index === subtitleTrack.index) {
          renderSubtitlePacket(packet, subtitleTrack);
        }
      }
      pending = [];
      if (source instanceof RangeFile) updateMetrics(source.metrics);
      if (Number(seekInput.value) >= durationSeconds - 0.25) break;
    }
    if (!controller.signal.aborted && activeDecoder?.state === "configured") await activeDecoder.flush();
    if (!controller.signal.aborted) {
      reportPlaybackSegment("播放片段结束");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "播放失败";
    event(message, "error");
    setState("decode-state", "播放失败", "error");
  } finally {
    if (controller.signal.aborted && decodedOutputFrames > 0) reportPlaybackSegment("播放片段已停止");
    stopVideoPlayback();
  }
}

function reportPlaybackSegment(label: string) {
  const elapsed = (performance.now() - playbackStartWall) / 1000;
  const rate = elapsed > 0 ? decodedOutputFrames / elapsed : 0;
  const latePercent = decodedOutputFrames > 0 ? lateFrames / decodedOutputFrames * 100 : 0;
  const sortedGaps = [...outputPtsGapsMs].sort((a, b) => a - b);
  const medianGap = percentile(sortedGaps, 0.5);
  const p95CallbackDelay = percentile([...decodeCallbackDelaysMs].sort((a, b) => a - b), 0.95);
  const sortedOutputIntervals = [...decoderOutputIntervalsMs].sort((a, b) => a - b);
  const p95DecoderOutputInterval = percentile([...decoderOutputIntervalsMs].sort((a, b) => a - b), 0.95);
  const sortedSubmitIntervals = [...videoPacketSubmitIntervalsMs].sort((a, b) => a - b);
  const sortedPacketReads = [...packetReadDurationsMs].sort((a, b) => a - b);
  const sortedCanvasDraws = [...canvasDrawDurationsMs].sort((a, b) => a - b);
  const sortedAudioLateness = [...audioOutputLatenessMs].sort((a, b) => a - b);
  const sortedAudioTimestampAge = [...audioOutputTimestampAgeMs].sort((a, b) => a - b);
  const sortedAudioAbsPtsGaps = audioOutputPtsGapsMs.map(Math.abs).sort((a, b) => a - b);
  const audioPtsDiscontinuities = audioOutputPtsGapsMs.filter((gap) => Math.abs(gap) > 5).length;
  const canvasP95Interval = percentile([...canvasPresentIntervalsMs].sort((a, b) => a - b), 0.95);
  const canvasMedianPtsGap = percentile([...canvasPresentedPtsGapsMs].sort((a, b) => a - b), 0.5);
  const maxGap = sortedGaps.at(-1) ?? 0;
  const largePtsGaps = medianGap > 0
    ? outputPtsGapsMs.filter((gap) => gap > medianGap * 1.5).length
    : 0;
  if (playbackLongTaskObserver) {
    recordLongTasks(playbackLongTaskObserver.takeRecords());
    playbackLongTaskObserver.disconnect();
    playbackLongTaskObserver = null;
  }
  $("#limitations").textContent = `${label}：${decodedOutputFrames} 解码帧 · ${rate.toFixed(1)} fps · 倍速 ×${playbackRate} · Canvas 绘制 ${canvasPresentedFrames} 帧 · 覆盖 ${canvasCoalescedFrames}`;
  setState("decode-state", label, "warn");
  event(`${label}：解码输出 ${decodedOutputFrames} 帧 (${rate.toFixed(1)} fps，倍速 ×${playbackRate})，回调延迟 P95 ${p95CallbackDelay.toFixed(1)} ms、输出间隔中位数/P95 ${percentile(sortedOutputIntervals, 0.5).toFixed(1)}/${p95DecoderOutputInterval.toFixed(1)} ms；视频包按 demux 解码顺序提交，提交间隔中位数/P95 ${percentile(sortedSubmitIntervals, 0.5).toFixed(1)}/${percentile(sortedSubmitIntervals, 0.95).toFixed(1)} ms，包序中的 PTS 回退 ${videoPacketPtsRegressions} 次；libav 取包耗时 P95/最大 ${percentile(sortedPacketReads, 0.95).toFixed(1)}/${sortedPacketReads.at(-1)?.toFixed(1) ?? "0.0"} ms；Canvas drawImage 路径耗时 P95/最大 ${percentile(sortedCanvasDraws, 0.95).toFixed(1)}/${sortedCanvasDraws.at(-1)?.toFixed(1) ?? "0.0"} ms；Canvas RAF 观察到 ${canvasPresentedFrames} 次更新，更新间隔 P95 ${canvasP95Interval.toFixed(1)} ms，绘制前被覆盖 ${canvasCoalescedFrames} 帧；Canvas 更新 PTS 中位间隔 ${canvasMedianPtsGap.toFixed(1)} ms。统一媒体时钟音频：排程 ${audioScheduledBuffers} 块，跳过过期块 ${audioDroppedBuffers} 块，输出迟到 P95/最大 ${percentile(sortedAudioLateness, 0.95).toFixed(1)}/${sortedAudioLateness.at(-1)?.toFixed(1) ?? "0.0"} ms，输出时间戳年龄 P95 ${percentile(sortedAudioTimestampAge, 0.95).toFixed(1)} ms，PCM PTS 间隙/重叠超过 5 ms ${audioPtsDiscontinuities} 次（绝对值 P95/最大 ${percentile(sortedAudioAbsPtsGaps, 0.95).toFixed(2)}/${sortedAudioAbsPtsGaps.at(-1)?.toFixed(2) ?? "0.0"} ms）。解码队列回压 ${decodeQueueWaitEvents} 次、累计 ${decodeQueueWaitMs.toFixed(1)} ms。主线程 Long Task ${playbackLongTaskCount} 次、累计 ${playbackLongTaskMs.toFixed(1)} ms、最大 ${playbackMaxLongTaskMs.toFixed(1)} ms；旧 42 ms 回调阈值命中 ${lateFrames}/${decodedOutputFrames} (${latePercent.toFixed(2)}%)；解码 PTS 中位间隔 ${medianGap.toFixed(1)} ms、最大 ${maxGap.toFixed(1)} ms，大于 1.5x 中位数的间隔 ${largePtsGaps}。RAF 是 Canvas 呈现代理，不是物理扫描输出证据。`, "warn");
}

function recordLongTasks(entries: PerformanceEntry[]) {
  for (const entry of entries) {
    playbackLongTaskCount += 1;
    playbackLongTaskMs += entry.duration;
    playbackMaxLongTaskMs = Math.max(playbackMaxLongTaskMs, entry.duration);
  }
}

function observeCanvasPresentation(now: number) {
  if (!playbackAbort) return;
  if (canvasRenderVersion > canvasObservedVersion) {
    canvasPresentedFrames += 1;
    if (canvasLastPresentedAt !== null) {
      const gap = now - canvasLastPresentedAt;
      canvasPresentIntervalsMs.push(gap);
      telemetryMaxRafGapMs = Math.max(telemetryMaxRafGapMs, gap);
    }
    if (canvasLastPresentedPts !== null && canvasLatestOutputPts !== null) {
      const gap = (canvasLatestOutputPts - canvasLastPresentedPts) / 1000;
      if (gap > 0) canvasPresentedPtsGapsMs.push(gap);
    }
    canvasLastPresentedAt = now;
    canvasLastPresentedPts = canvasLatestOutputPts;
    canvasObservedVersion = canvasRenderVersion;
  }
  requestAnimationFrame(observeCanvasPresentation);
}

/** Presents decoded frames at their due media time; frames that arrive in bursts are dropped down to the newest. */
function presentDueFrames(now: number) {
  if (!playbackAbort) return;
  let presented: { frame: VideoFrame; dueMs: number } | null = null;
  while (presentQueue.length && presentQueue[0].dueMs <= now + PRESENT_DUE_TOLERANCE_MS) {
    const next = presentQueue.shift()!;
    if (presented) {
      presented.frame.close();
      canvasCoalescedFrames += 1;
    }
    presented = next;
  }
  if (presented) {
    const drawStarted = performance.now();
    drawFrame(presented.frame);
    canvasDrawDurationsMs.push(performance.now() - drawStarted);
    canvasLatestOutputPts = presented.frame.timestamp;
    canvasRenderVersion += 1;
    presented.frame.close();
  }
  requestAnimationFrame(presentDueFrames);
}

/** Live playback-rate change (room 追帧 use): re-anchors the shared media→wall mapping without discontinuity.
 *  Video frames are re-due'd, packet pacing is rebased, audio blocks pick the new rate up from the next block;
 *  subtitles are frame-locked (manualRender uses the presented frame's mediaTime) so they follow automatically. */
function setPlaybackRate(value: number) {
  const next = Number(value);
  if (!Number.isFinite(next) || next < 0.5 || next > 2 || next === playbackRate) return playbackRate;
  const now = performance.now();
  const mediaNow = playbackStartPts + ((now - playbackStartWall) * playbackRate) / 1000;
  const scheduleNow = mediaNow - playbackStartPts;
  playbackRate = next;
  playbackStartPts = mediaNow;
  playbackStartWall = now;
  videoDecodeScheduleSeconds = Math.max(0, videoDecodeScheduleSeconds - scheduleNow);
  videoDecodeBaseDts = null;
  videoDecodeBaseOffset = videoDecodeScheduleSeconds;
  for (const item of presentQueue) item.dueMs = mediaDueMs(item.frame.timestamp / 1_000_000);
  event(`倍速切换 ×${next}：视频/音频/字幕统一时间轴联动`, "info");
  return playbackRate;
}
(globalThis as Record<string, unknown>).__pocSetRate = setPlaybackRate;
(globalThis as Record<string, unknown>).__pocGetRate = () => playbackRate;

function percentile(sortedValues: number[], percentileValue: number) {
  if (!sortedValues.length) return 0;
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor((sortedValues.length - 1) * percentileValue))];
}

/** Rolling 2s playback telemetry for verification runs; read from the page via CDP. */
function pushTelemetry(now: number) {
  if (now - pocTelemetry.lastAt < 2000) return;
  pocTelemetry.lastAt = now;
  pocTelemetry.ticks.push({
    t: Date.now(),
    decoded: decodedOutputFrames,
    coalesced: canvasCoalescedFrames,
    maxDecodeGapMs: Math.round(telemetryMaxDecodeGapMs),
    maxRafGapMs: Math.round(telemetryMaxRafGapMs),
  });
  telemetryMaxDecodeGapMs = 0;
  telemetryMaxRafGapMs = 0;
  if (pocTelemetry.ticks.length > 90) pocTelemetry.ticks.shift();
  (globalThis as Record<string, unknown>).__pocTelemetry = pocTelemetry;
}

function createAudioDecoder(track: MediaStream) {
  if (!audioContext) {
    audioContext = new AudioContext();
    audioGain = audioContext.createGain();
    audioGain.gain.value = audioMuted ? 0 : 1;
    audioGain.connect(audioContext.destination);
  }
  return new AudioDecoder({
    output(data) {
      try {
        const buffer = audioContext!.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
        for (let channel = 0; channel < data.numberOfChannels; channel += 1) {
          const samples = new Float32Array(data.numberOfFrames);
          data.copyTo(samples, { planeIndex: channel, format: "f32-planar" });
          buffer.copyToChannel(samples, channel);
        }
        const sourceNode = audioContext!.createBufferSource();
        sourceNode.buffer = buffer;
        sourceNode.playbackRate.value = playbackRate;
        sourceNode.connect(audioGain ?? audioContext!.destination);
        const timestamp = data.timestamp / 1_000_000;
        const timestampDuration = data.numberOfFrames / data.sampleRate;
        if (lastAudioOutputEndPts !== null) audioOutputPtsGapsMs.push((timestamp - lastAudioOutputEndPts) * 1000);
        lastAudioOutputEndPts = timestamp + timestampDuration;
        const duePerformanceTime = mediaDueMs(timestamp);
        const outputTimestamp = audioContext!.getOutputTimestamp();
        const outputContextTime = outputTimestamp.contextTime ?? Number.NaN;
        const outputPerformanceTime = outputTimestamp.performanceTime ?? Number.NaN;
        const hasOutputTimestamp = Number.isFinite(outputContextTime)
          && Number.isFinite(outputPerformanceTime)
          && outputPerformanceTime > 0;
        if (hasOutputTimestamp) audioOutputTimestampAgeMs.push(performance.now() - outputPerformanceTime);
        const mappedContextTime = hasOutputTimestamp
          ? outputContextTime + (duePerformanceTime - outputPerformanceTime) / 1000
          : audioContext!.currentTime + (duePerformanceTime - performance.now()) / 1000;
        const scheduledContextTime = Math.max(audioContext!.currentTime + 0.005, mappedContextTime);
        const scheduledPerformanceTime = hasOutputTimestamp
          ? outputPerformanceTime + (scheduledContextTime - outputContextTime) * 1000
          : performance.now() + (scheduledContextTime - audioContext!.currentTime) * 1000;
        const lateSeconds = Math.max(0, (scheduledPerformanceTime - duePerformanceTime) / 1000);
        const frameOffset = Math.min(data.numberOfFrames, Math.floor(lateSeconds * data.sampleRate * playbackRate));
        const duration = buffer.duration - frameOffset / data.sampleRate;
        audioOutputLatenessMs.push(lateSeconds * 1000);
        if (duration <= 0) {
          audioDroppedBuffers += 1;
          return;
        }
        sourceNode.start(scheduledContextTime, frameOffset / data.sampleRate);
        audioScheduledBuffers += 1;
      } catch (error) {
        event(`Audio output failed: ${error instanceof Error ? error.message : "copyTo failed"}`, "error");
      } finally {
        data.close();
      }
    },
    error(error) {
      event(`AudioDecoder error: ${error.message}`, "error");
    },
  });
}

function renderSubtitlePacket(packet: Packet, track: MediaStream) {
  if (track.codec === "hdmv_pgs_subtitle") return;
  const text = new TextDecoder().decode(packet.data).replace(/\0+$/g, "").trim();
  if (!text) return;
  const timecode = packetSeconds(packet, track);
  const duration = packetDurationSeconds(packet, track) || 4;
  if ((track.codec === "ass" || track.codec === "ssa") && jassub && jassubTrackIndex === track.index) {
    jassub.renderer.processChunk(text, timecode * 1000, duration * 1000);
    return;
  }
  activeCaption = text.replace(/\r?\n/g, " ");
  activeCaptionUntil = mediaDueMs(timecode + Math.max(1, duration));
}

async function activateSubtitleTrack(track: MediaStream) {
  if (jassub && jassubTrackIndex === track.index) return;
  subtitleRenderErrorReported = false;
  if (jassub) {
    await jassub.destroy();
    jassub = null;
    replaceSubtitleCanvas();
  }
  activeCaption = "";
  jassubTrackIndex = track.index;
  if (track.codec === "hdmv_pgs_subtitle") {
    $("#subtitle-note").textContent = "已选择 PGS 图像字幕。此 POC 识别轨道但不渲染图像字幕。";
    return;
  }
  if (track.codec !== "ass" && track.codec !== "ssa") return;
  const subtitleHeader = track.codecParameters.extradata
    ? new TextDecoder().decode(track.codecParameters.extradata).replace(/\0+$/g, "")
    : "";
  if (!subtitleHeader.includes("[Script Info]")) {
    event("ASS 轨道缺少可读 CodecPrivate，无法初始化样式渲染。", "warn");
    return;
  }
  const { default: JASSUB } = await import("jassub");
  const activeSession = session;
  const embeddedFonts = activeSession
    ? activeSession.streams.flatMap((candidate) => {
        const fontData = candidate.codec_type === activeSession.libav.AVMEDIA_TYPE_ATTACHMENT
          ? candidate.codecParameters.extradata
          : undefined;
        return fontData?.byteLength ? [fontData] : [];
      })
    : [];
  const embeddedFontBytes = embeddedFonts.reduce((total, font) => total + font.byteLength, 0);
  const renderer = new JASSUB({
    canvas: subtitleCanvas,
    subContent: subtitleHeader,
    fonts: embeddedFonts,
    queryFonts: false,
  });
  try {
    await renderer.ready;
    jassub = renderer;
    event(`JASSUB 已启用 ASS 轨道 ${track.index}，加载媒体内嵌字体 ${embeddedFonts.length} 个 (${formatBytes(embeddedFontBytes)})。`, embeddedFonts.length ? "ok" : "warn");
  } catch (error) {
    await renderer.destroy();
    replaceSubtitleCanvas();
    throw error;
  }
}

function replaceSubtitleCanvas() {
  const next = document.createElement("canvas");
  next.id = "subtitle-canvas";
  next.width = canvas.width;
  next.height = canvas.height;
  next.setAttribute("aria-hidden", "true");
  subtitleCanvas.replaceWith(next);
  subtitleCanvas = next;
}

function drawFrame(frame: VideoFrame) {
  context?.drawImage(frame, 0, 0, canvas.width, canvas.height);
  if (!context) return;
  if (activeCaption && performance.now() <= activeCaptionUntil) {
    context.font = "22px sans-serif";
    context.textAlign = "center";
    context.lineWidth = 4;
    context.strokeStyle = "#000";
    context.fillStyle = "#fff";
    context.strokeText(activeCaption, canvas.width / 2, canvas.height - 30, canvas.width - 80);
    context.fillText(activeCaption, canvas.width / 2, canvas.height - 30, canvas.width - 80);
  }
  if (jassub && jassubTrackIndex === subtitleTrack?.index) {
    if (subtitleRenderPending) return;
    subtitleRenderPending = true;
    void jassub.manualRender({
      expectedDisplayTime: performance.now(),
      width: canvas.width,
      height: canvas.height,
      mediaTime: frame.timestamp / 1_000_000,
    }).catch((error: unknown) => {
      if (subtitleRenderErrorReported) return;
      subtitleRenderErrorReported = true;
      event(`ASS 渲染失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    }).finally(() => {
      subtitleRenderPending = false;
    });
  }
}

function packetDurationSeconds(packet: Packet, stream: MediaStream) {
  const duration = packet.duration ?? 0;
  const high = packet.durationhi ?? 0;
  return (duration + high * 0x100000000) * stream.time_base_num / stream.time_base_den;
}

function flattenPackets(batch: { packets: Record<number, Packet[]> }) {
  return Object.values(batch.packets).flat();
}

function stopVideoPlayback() {
  playbackAbort?.abort();
  playbackAbort = null;
  while (presentQueue.length) presentQueue.shift()!.frame.close();
  if (activeDecoder && activeDecoder.state !== "closed") activeDecoder.close();
  activeDecoder = null;
  if (activeAudioDecoder && activeAudioDecoder.state !== "closed") activeAudioDecoder.close();
  activeAudioDecoder = null;
  const button = $("#play-toggle") as HTMLButtonElement;
  button.textContent = "▶";
  button.title = "播放视频轨";
  button.setAttribute("aria-label", "播放视频轨");
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

async function clearMedia() {
  stopVideoPlayback();
  if (session) await session.close();
  if (jassub) await jassub.destroy();
  jassub = null;
  jassubTrackIndex = -1;
  replaceSubtitleCanvas();
  subtitleRenderPending = false;
  subtitleRenderErrorReported = false;
  session = null;
  streams = [];
  source = null;
  videoTrack = null;
  audioTrack = null;
  subtitleTrack = null;
  durationSeconds = 0;
  seekInput.disabled = true;
  seekInput.value = "0";
  $("#tracks").replaceChildren();
  $("#tracks").classList.add("empty");
  $("#wasm-consent").classList.add("hidden");
  $("#metric-seek").textContent = "--";
  if (context) {
    context.fillStyle = "#06090b";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#68757b";
    context.textAlign = "center";
    context.font = "15px ui-monospace, monospace";
    context.fillText("等待 MKV 媒体源", canvas.width / 2, canvas.height / 2);
  }
  setState("range-state", "等待", "neutral");
  setState("demux-state", "等待", "neutral");
  setState("codec-state", "等待", "neutral");
}

document.querySelectorAll<HTMLButtonElement>(".mode").forEach((button) => button.addEventListener("click", () => {
  activeMode = button.dataset.mode === "file" ? "file" : "url";
  document.querySelectorAll(".mode").forEach((item) => item.classList.toggle("selected", item === button));
  $("#url-wrap").classList.toggle("hidden", activeMode !== "url");
  $("#file-wrap").classList.toggle("hidden", activeMode !== "file");
}));
document.addEventListener("poc-event", (detailEvent) => {
  const detail = (detailEvent as CustomEvent<{ message: string; tone: "warn" }>).detail;
  event(detail.message, detail.tone);
});
$("#inspect").addEventListener("click", () => void loadMedia());
$("#play-toggle").addEventListener("click", () => void toggleVideoPlayback());
$("#refresh-url").addEventListener("click", () => {
  urlInput.value = "";
  urlInput.focus();
  event("请粘贴更新后的短时签名 URL；本页不会保存旧值。", "info");
});
urlInput.addEventListener("change", () => {
  const value = urlInput.value.trim();
  if (pendingUrl && value) {
    window.clearTimeout(pendingUrl.timeout);
    pendingUrl.resolve(value);
    pendingUrl = null;
    event("已在内存中刷新签名 URL。", "ok");
  }
});
seekInput.addEventListener("change", () => void seekTo(Number(seekInput.value)));
$("#prev-frame").addEventListener("click", () => void seekTo(Math.max(0, Number(seekInput.value) - 10)));
$("#next-frame").addEventListener("click", () => void seekTo(Math.min(durationSeconds, Number(seekInput.value) + 10)));
$("#clear-events").addEventListener("click", () => eventList.replaceChildren());
$("#wasm-confirm").addEventListener("click", () => event("WASM 解码尚未启用：需要审完软解组件与音画输出接口。", "warn"));
$("#mpv-fallback").addEventListener("click", () => event("POC 环境尚未接入 MPV deep link；此动作不改变房间状态。", "warn"));

const isolated = crossOriginIsolated;
$("#isolation-dot").classList.toggle("ready", isolated);
$("#isolation-label").textContent = isolated ? "COOP / COEP 已生效" : "跨源隔离未生效";
const browserMatch = navigator.userAgent.match(/(Edg|Chrome)\/(\d+)/);
$("#browser-label").textContent = `${browserMatch?.[1] ?? "Browser"} ${browserMatch?.[2] ?? ""} · ${navigator.platform}`;
if (typeof SharedArrayBuffer !== "undefined") event("SharedArrayBuffer 可用，跨源隔离成立。", "ok");
else event("SharedArrayBuffer 不可用，WASM threads 无法验证。", "warn");
if (context) {
  context.fillStyle = "#06090b";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#68757b";
  context.textAlign = "center";
  context.font = "15px ui-monospace, monospace";
  context.fillText("等待 MKV 媒体源", canvas.width / 2, canvas.height / 2);
}
