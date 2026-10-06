import { BlobSource, CustomSource, EncodedPacketSink, Input, MATROSKA, type InputAudioTrack, type InputVideoTrack } from "mediabunny";
import "./style.css";
import { RangeFile, type RangeMetrics } from "./range-file";

type TrackRow = {
  kind: string;
  codec: string;
  details: string;
  language: string;
};

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
          <canvas id="frame-canvas" width="960" height="540" aria-label="解码帧输出"></canvas>
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
    <footer><span>样本矩阵：H.264 Main 1080p30 / AAC stereo · HEVC Main 10 / FLAC · ASS / SRT</span><span>Mediabunny 1.61.3 · MPL-2.0</span><span>本页为隔离验证工具，不接入房间播放器</span></footer>
  </main>`;

const $ = <T extends HTMLElement>(selector: string) => {
  const element = app.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const canvas = $("#frame-canvas") as HTMLCanvasElement;
const context = canvas.getContext("2d");
const urlInput = $("#media-url") as HTMLInputElement;
const fileInput = $("#media-file") as HTMLInputElement;
const seekInput = $("#seek-range") as HTMLInputElement;
const eventList = $("#events");
let activeMode: "url" | "file" = "url";
let source: RangeFile | File | null = null;
let input: Input | null = null;
let videoTrack: InputVideoTrack | null = null;
let videoSink: EncodedPacketSink | null = null;
let durationSeconds = 0;
let eventCount = 0;
let playbackAbort: AbortController | null = null;
let activeDecoder: VideoDecoder | null = null;
let playbackStartWall = 0;
let playbackStartPts = 0;
let presentedFrames = 0;
let lateFrames = 0;

function event(message: string, kind: "ok" | "warn" | "error" | "info" = "info") {
  eventCount += 1;
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

function codecString(track: { codecID?: string; codecPrivate?: ArrayBuffer }): string | null {
  if (track.codecID === "V_MPEG4/ISO/AVC") {
    const bytes = track.codecPrivate ? new Uint8Array(track.codecPrivate) : null;
    if (!bytes || bytes.length < 4 || bytes[0] !== 1) return null;
    return `avc1.${[bytes[1], bytes[2], bytes[3]].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  if (track.codecID === "V_MPEGH/ISO/HEVC") return "hvc1.1.6.L93.B0";
  if (track.codecID === "A_AAC") return "mp4a.40.2";
  if (track.codecID === "A_FLAC") return "flac";
  return null;
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
    select.checked = !wrapper.querySelector(`input[name="local-${row.kind}"]`);
    select.setAttribute("aria-label", `选择本地${row.kind}轨道`);
    local.append(select, document.createTextNode("本地"));
    details.append(title, subtitle);
    item.append(label, details, local);
    wrapper.append(item);
  }
}

async function probeDecoder(track: { codecID?: string; codecPrivate?: ArrayBuffer; width?: number; height?: number; channels?: number; samplingFrequency?: number }, kind: "video" | "audio") {
  const codec = codecString(track);
  if (!codec) return { codec: "未知 codec", supported: false, reason: "尚未实现该 CodecPrivate 映射" };
  const Constructor = kind === "video" ? globalThis.VideoDecoder : globalThis.AudioDecoder;
  if (!Constructor || typeof Constructor.isConfigSupported !== "function") return { codec, supported: false, reason: `${kind} decoder API 不可用` };
  const config = kind === "video"
    ? { codec, codedWidth: track.width ?? 1920, codedHeight: track.height ?? 1080, ...(track.codecPrivate ? { description: new Uint8Array(track.codecPrivate) } : {}) }
    : { codec, sampleRate: track.samplingFrequency ?? 48000, numberOfChannels: track.channels ?? 2, ...(track.codecPrivate ? { description: new Uint8Array(track.codecPrivate) } : {}) };
  try {
    const result = await Constructor.isConfigSupported(config as VideoDecoderConfig & AudioDecoderConfig);
    return { codec, supported: result.supported === true, reason: result.supported ? "瀏覽器回報可用，尚未做實際解碼" : "瀏覽器回報不支援" };
  } catch (error) {
    return { codec, supported: false, reason: error instanceof Error ? error.message : "能力探測失敗" };
  }
}

async function loadMedia() {
  clearMedia();
  const id = `POC-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  $("#run-id").textContent = `RUN / ${id}`;
  try {
    if (activeMode === "url") {
      const input = urlInput.value.trim();
      if (!input) throw new Error("请粘贴有效的短时签名 URL");
      const parsed = new URL(input);
      if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") throw new Error("远程媒体源必须使用 HTTPS");
      source = new RangeFile(input, updateMetrics);
      setState("source-state", "内存态", "ok");
    } else {
      const picked = fileInput.files?.[0];
      if (!picked) throw new Error("请选择一个 MKV 文件");
      source = picked;
      setState("source-state", "本机文件", "ok");
    }
    $("#source-detail").textContent = activeMode === "url" ? "短时 URL 在本页内存；刷新时由操作者重新粘贴" : "本机文件对照，不上传文件";
    event("媒体源已载入内存，本次运行不会写入浏览器存储。", "ok");

    const rangeStart = performance.now();
    const firstRange = activeMode === "url" ? await (source as RangeFile).probe() : { ok: true, status: 0, size: source.size, reason: "本机 File.slice 对照" };
    updateMetrics(activeMode === "url" ? (source as RangeFile).metrics : { requests: 0, bytes: 0, coveredBytes: 0, size: source.size, fullBodyRejected: false });
    if (firstRange.ok) {
      const elapsed = Math.round(performance.now() - rangeStart);
      setState("range-state", activeMode === "url" ? "206 / Range OK" : "slice OK", "ok");
      setState("cors-state", activeMode === "url" ? "可讀" : "本機", "ok");
      $("#range-detail").textContent = `${firstRange.status || "Blob"} · 首區間 ${elapsed} ms`;
      event(`Range 首段檢查成功，狀態 ${firstRange.status || "File.slice"}，${elapsed} ms。`, "ok");
    } else {
      setState("range-state", "不可用", "error");
      setState("cors-state", "源不符合", "error");
      $("#range-detail").textContent = firstRange.reason;
      event(`源不可直接播放：${firstRange.reason}`, "error");
      throw new Error(firstRange.reason);
    }

    const selectedSource = source;
    const mediaSource = selectedSource instanceof RangeFile
      ? new CustomSource({
          getSize: () => selectedSource.size,
          read: async (start, end) => new Uint8Array(await selectedSource.read(start, end)),
          maxCacheSize: 8 * 1024 * 1024,
          prefetchProfile: "none",
        })
      : new BlobSource(selectedSource, { maxCacheSize: 8 * 1024 * 1024 });
    input = new Input({ formats: [MATROSKA], source: mediaSource });
    if (!(await input.canRead())) throw new Error("Mediabunny 無法辨識此 Matroska 文件");
    const allTracks = await input.getTracks();
    const video = allTracks.find((track): track is InputVideoTrack => track.type === "video") ?? null;
    videoTrack = video;
    videoSink = video ? new EncodedPacketSink(video) : null;
    const audioTracks = allTracks.filter((track): track is InputAudioTrack => track.type === "audio");
    const subtitleTracks = allTracks.filter((track) => track.type === "subtitle");
    durationSeconds = (await input.getDurationFromMetadata()) ?? 0;
    seekInput.disabled = false;
    $("#play-toggle").removeAttribute("disabled");
    seekInput.max = String(Math.max(1, Math.floor(durationSeconds)));
    $("#seek-time").textContent = `00:00 / ${durationSeconds ? clock(durationSeconds) : "--:--"}`;

    const trackRows: TrackRow[] = [];
    if (video) {
      const config = await video.getDecoderConfig();
      const codec = await video.getCodecParameterString() ?? await video.getCodec() ?? "unknown";
      const supported = await video.canDecode();
      const reason = supported ? "WebCodecs canDecode 回報可用，尚未實際解碼" : "瀏覽器不支援或 CodecPrivate 無效";
      const info = `${config?.codedWidth ?? "?"} × ${config?.codedHeight ?? "?"} · ${reason}`;
      trackRows.push({ kind: "VIDEO", codec: `${await video.getInternalCodecId() ?? codec} / ${codec}`, details: info, language: await video.getLanguageCode() });
      setState("codec-state", supported ? "Video API 可用" : "需回退", supported ? "ok" : "warn");
      $("#codec-detail").textContent = `${codec} · ${reason}`;
      setState("decode-state", supported ? "能力回報可用，待實際解碼" : "需要確認軟解回退", "warn");
      $("#wasm-consent").classList.toggle("hidden", supported);
      event(`WebCodecs video: ${codec}; ${reason}`, supported ? "ok" : "warn");
    } else {
      setState("codec-state", "無視頻軌", "error");
    }
    for (const audio of audioTracks) {
      const config = await audio.getDecoderConfig();
      const codec = await audio.getCodecParameterString() ?? await audio.getCodec() ?? "unknown";
      const supported = await audio.canDecode();
      const reason = supported ? "WebCodecs canDecode 回報可用" : "瀏覽器不支援或 CodecPrivate 無效";
      trackRows.push({ kind: "AUDIO", codec: `${await audio.getInternalCodecId() ?? codec} / ${codec}`, details: `${config?.numberOfChannels ?? "?"} ch · ${config?.sampleRate ?? "?"} Hz · ${reason}`, language: await audio.getLanguageCode() });
      event(`WebCodecs audio: ${codec}; ${reason}`, supported ? "ok" : "warn");
    }
    for (const subtitle of subtitleTracks) {
      const codec = await subtitle.getInternalCodecId();
      trackRows.push({ kind: "SUB", codec: String(codec ?? "subtitle"), details: "Mediabunny Matroska subtitle track 支援待實測", language: await subtitle.getLanguageCode() });
    }
    renderTracks(trackRows);
    $("#demux-detail").textContent = `${trackRows.length} 條軌道 · lazy packet sink ready`;
    $("#subtitle-note").classList.toggle("hidden", subtitleTracks.length > 0);
    $("#subtitle-note").textContent = subtitleTracks.length ? "字幕轨道已列出，时间文本提取和 ASS 样式渲染仍待接线。" : "Mediabunny 目前未暴露 Matroska 字幕轨道；需评估轻量 EBML 字幕解析或 web-demuxer-mini。";
    setState("demux-state", "Tracks 已解析 · lazy", "ok");
    setState("decode-state", "選擇位置測試關鍵幀 seek", "neutral");
    event(`Mediabunny Matroska tracks 已解析：${trackRows.length} 軌；lazy packet sink 已就緒；時長 ${clock(durationSeconds)}。`, "ok");
    updateMetrics(activeMode === "url" ? (source as RangeFile).metrics : { requests: 0, bytes: 0, coveredBytes: 0, size: source.size, fullBodyRejected: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "載入失敗";
    event(message, "error");
    if (!source) setState("source-state", "錯誤", "error");
  }
}

function clock(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

async function seekTo(seconds: number) {
  if (!input || !videoSink || !videoTrack || !source) return;
  const started = performance.now();
  try {
    const packet = await videoSink.getKeyPacket(seconds);
    const elapsed = Math.round(performance.now() - started);
    $("#metric-seek").textContent = `${elapsed} ms`;
    updateMetrics(source instanceof RangeFile ? source.metrics : { requests: 0, bytes: 0, coveredBytes: 0, size: source.size, fullBodyRejected: false });
    if (!packet) throw new Error("找不到 seek 關鍵包；檢查該 MKV 的 Cues 索引");
    const config = await videoTrack.getDecoderConfig();
    if (!config || !globalThis.VideoDecoder) throw new Error("此視頻軌尚無 WebCodecs DecoderConfig");
    await new Promise<void>((resolve, reject) => {
      let decoder: VideoDecoder;
      decoder = new VideoDecoder({
        output(frameOutput) {
          context?.drawImage(frameOutput, 0, 0, canvas.width, canvas.height);
          frameOutput.close();
          decoder.close();
          resolve();
        },
        error(error) {
          decoder.close();
          reject(error);
        },
      });
      decoder.configure(config);
      decoder.decode(new EncodedVideoChunk({
        type: packet.type,
        timestamp: packet.microsecondTimestamp,
        data: packet.data,
      }));
      void decoder.flush().catch(reject);
      window.setTimeout(() => {
        if (decoder.state !== "closed") decoder.close();
        reject(new Error("關鍵幀解碼超時"));
      }, 5000);
    });
    seekInput.value = String(Math.floor(seconds));
    $("#seek-time").textContent = `${clock(seconds)} / ${durationSeconds ? clock(durationSeconds) : "--:--"}`;
    $("#limitations").textContent = `已完成單關鍵包 seek / decode 探針 · ${formatBytes(packet.byteLength)} packet · 連續播放門檻仍未測`;
    setState("decode-state", "單幀原生解碼成功", "ok");
    event(`Seek ${clock(seconds)} → encoded packet ${formatBytes(packet.byteLength)} → WebCodecs 輸出；${elapsed} ms。`, elapsed < 3000 ? "ok" : "warn");
    if (source instanceof RangeFile) event(`seek 取回單一關鍵包 ${formatBytes(packet.byteLength)}；Range 累計覆蓋率 ${Math.round(source.metrics.coveredBytes / source.size * 100)}%。`, "info");
    updateMetrics(source instanceof RangeFile ? source.metrics : { requests: 0, bytes: 0, coveredBytes: 0, size: source.size, fullBodyRejected: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "seek 失敗";
    setState("decode-state", "seek / 解碼失敗", "error");
    event(message, "error");
  }
}

async function toggleVideoPlayback() {
  if (playbackAbort) {
    stopVideoPlayback();
    return;
  }
  if (!videoSink || !videoTrack || !source) return;
  const controller = new AbortController();
  playbackAbort = controller;
  const button = $("#play-toggle") as HTMLButtonElement;
  button.textContent = "Ⅱ";
  button.title = "暫停視頻軌";
  button.setAttribute("aria-label", "暫停視頻軌");
  const startAt = Number(seekInput.value);
  try {
    const firstPacket = await videoSink.getKeyPacket(startAt);
    if (!firstPacket) throw new Error("找不到播放起點之前的關鍵包");
    const config = await videoTrack.getDecoderConfig();
    if (!config) throw new Error("視頻軌沒有 WebCodecs DecoderConfig");
    playbackStartPts = firstPacket.timestamp;
    playbackStartWall = performance.now();
    presentedFrames = 0;
    lateFrames = 0;
    activeDecoder = new VideoDecoder({
      output(frame) {
        const due = playbackStartWall + (frame.timestamp / 1000 - playbackStartPts) * 1000;
        if (performance.now() - due > 42) lateFrames += 1;
        context?.drawImage(frame, 0, 0, canvas.width, canvas.height);
        presentedFrames += 1;
        seekInput.value = String(Math.min(durationSeconds, frame.timestamp / 1_000_000));
        $("#seek-time").textContent = `${clock(frame.timestamp / 1_000_000)} / ${clock(durationSeconds)}`;
        frame.close();
      },
      error(error) {
        event(`WebCodecs playback error: ${error.message}`, "error");
        stopVideoPlayback();
      },
    });
    activeDecoder.configure(config);
    setState("decode-state", "視頻連續解碼中 · 無音頻輸出", "warn");
    event(`開始視頻軌連續 Range demux / WebCodecs；起點 ${clock(startAt)}。`, "ok");
    for await (const packet of videoSink.packets(firstPacket)) {
      if (controller.signal.aborted) break;
      const due = playbackStartWall + (packet.timestamp - playbackStartPts) * 1000;
      const wait = due - performance.now();
      if (wait > 0) await delay(Math.min(wait, 100));
      if (controller.signal.aborted || activeDecoder?.state !== "configured") break;
      while (!controller.signal.aborted && activeDecoder && activeDecoder.decodeQueueSize > 6) await delay(4);
      if (controller.signal.aborted || !activeDecoder) break;
      activeDecoder.decode(packet.toEncodedVideoChunk());
      if (source instanceof RangeFile) updateMetrics(source.metrics);
    }
    if (!controller.signal.aborted && activeDecoder?.state === "configured") await activeDecoder.flush();
    if (!controller.signal.aborted) {
      const elapsed = (performance.now() - playbackStartWall) / 1000;
      const rate = elapsed > 0 ? presentedFrames / elapsed : 0;
      $("#limitations").textContent = `視頻包探測：${presentedFrames} 幀 · ${rate.toFixed(1)} fps · 遲到 ${lateFrames} 幀；未輸出音頻，不能計作 A/V 通過`;
      setState("decode-state", "視頻段落完成 · A/V 未測", "warn");
      event(`視頻連續讀取結束：${presentedFrames} 幀，${rate.toFixed(1)} fps，${lateFrames} 幀晚於預定時鐘。`, "warn");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "視頻播放失敗";
    event(message, "error");
    setState("decode-state", "視頻播放失敗", "error");
  } finally {
    stopVideoPlayback();
  }
}

function stopVideoPlayback() {
  playbackAbort?.abort();
  playbackAbort = null;
  if (activeDecoder && activeDecoder.state !== "closed") activeDecoder.close();
  activeDecoder = null;
  const button = $("#play-toggle") as HTMLButtonElement;
  button.textContent = "▶";
  button.title = "播放視頻軌";
  button.setAttribute("aria-label", "播放視頻軌");
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function clearMedia() {
  stopVideoPlayback();
  input?.dispose();
  input = null;
  videoTrack = null;
  videoSink = null;
  source = null;
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
    context.fillText("等待 MKV 媒體源", canvas.width / 2, canvas.height / 2);
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
  event("請貼上更新後的短時簽名 URL；本頁不會保存舊值。", "info");
});
seekInput.addEventListener("change", () => void seekTo(Number(seekInput.value)));
$("#prev-frame").addEventListener("click", () => void seekTo(Math.max(0, Number(seekInput.value) - 10)));
$("#next-frame").addEventListener("click", () => void seekTo(Math.min(durationSeconds, Number(seekInput.value) + 10)));
$("#clear-events").addEventListener("click", () => eventList.replaceChildren());
$("#wasm-confirm").addEventListener("click", () => event("WASM 解碼未啟用：尚無完成 LGPL 編碼器 / 音畫輸出接口審核的組件。", "warn"));
$("#mpv-fallback").addEventListener("click", () => event("POC 環境尚未接入 MPV deep link；此動作不會寫入或改變房間狀態。", "warn"));

const isolated = crossOriginIsolated;
$("#isolation-dot").classList.toggle("ready", isolated);
$("#isolation-label").textContent = isolated ? "COOP / COEP 已生效" : "跨源隔離未生效";
const browserMatch = navigator.userAgent.match(/(Edg|Chrome)\/(\d+)/);
$("#browser-label").textContent = `${browserMatch?.[1] ?? "Browser"} ${browserMatch?.[2] ?? ""} · ${navigator.platform}`;
if (typeof SharedArrayBuffer !== "undefined") event("SharedArrayBuffer 可用，跨源隔離成立。", "ok");
else event("SharedArrayBuffer 不可用，WASM threads 無法驗證。", "warn");
if (context) {
  context.fillStyle = "#06090b";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#68757b";
  context.textAlign = "center";
  context.font = "15px ui-monospace, monospace";
  context.fillText("等待 MKV 媒體源", canvas.width / 2, canvas.height / 2);
}
