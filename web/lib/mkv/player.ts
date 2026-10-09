import type { Packet } from "@libav.js/types";
import { LibavSession, packetDecodeSeconds, packetSeconds, type MediaStream } from "./libav-session";
import { MediaClock } from "./media-clock";
import { RangeFile } from "./range-file";
import { paintSubtitleLines, subtitleMarginPx } from "./subtitle-paint";
import { hasDefaultDisposition, type EmbeddedTrack, type PlayerLocalState, type EmbeddedTracks } from "../player-local";
import { DEFAULT_SUBTITLE_APPEARANCE, type SubtitleAppearance } from "../player-preferences";

export type EmbeddedSubtitle = { header: string; fonts: Uint8Array[]; index: number };
type Caption = { start: number; end: number; text: string };

export type MkvPlayerOptions = {
  canvas: HTMLCanvasElement;
  refreshUrl?: () => Promise<string>;
  onReady: (duration: number) => void;
  onTimeUpdate: (time: number, duration: number, buffered: number) => void;
  onEnded: () => void;
  onError: (message: string, unsupported: boolean) => void;
  onFrame?: (mediaTime: number) => void;
  onSubtitle?: (subtitle: EmbeddedSubtitle | null) => void;
  onTracks?: (tracks: EmbeddedTracks) => void;
  onLocalState?: (state: PlayerLocalState) => void;
  onSubtitlePacket?: (text: string, start: number, duration: number) => void;
  onSubtitleReset?: () => void;
  subtitleStyle?: SubtitleAppearance;
};

/** Room-local decoder. Commands supersede older runs; only one run can touch the demuxer. */
export class MkvPlayer {
  private readonly clock = new MediaClock();
  private readonly lifetime = new AbortController();
  private session: LibavSession | null = null;
  private source: RangeFile | null = null;
  private video: MediaStream | null = null;
  private audio: MediaStream | null = null;
  private subtitle: MediaStream | null = null;
  private videoDecoder: VideoDecoder | null = null;
  private audioDecoder: AudioDecoder | null = null;
  private audioContext: AudioContext | null = null;
  private gain: GainNode | null = null;
  private audioBuffers: Array<{ buffer: AudioBuffer; start: number }> = [];
  private readonly audioNodes = new Set<AudioBufferSourceNode>();
  private readonly frames: VideoFrame[] = [];
  private captions: Caption[] = [];
  private version = 0;
  private wantedPlaying = false;
  private disposed = false;
  private run: Promise<void> = Promise.resolve();
  private raf = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private muted = false;
  private volume = 0.85;
  private externalCaptions: TextTrack | null = null;
  private externalSubtitle = false;
  private subtitleOffset = 0;
  private lastVideoTime = 0;
  private previewDone = false;
  private ended = false;
  private loaded = false;
  private tracks: EmbeddedTrack[] = [];
  private lastDrawWall = 0;
  private reportedState = "";

  constructor(private readonly options: MkvPlayerOptions) {}

  /** 外观即时生效：draw() 每帧读取；暂停态触发一次重绘（与 setExternalSubtitle 同一套路）。 */
  setSubtitleStyle(style: SubtitleAppearance) {
    this.options.subtitleStyle = style;
    if (this.loaded && !this.wantedPlaying && !this.disposed) this.restart();
  }

  get duration() { return this.session?.durationSeconds ?? 0; }
  get currentTime() { return Math.min(this.duration || Infinity, this.clock.currentTime); }
  get embeddedTracks(): EmbeddedTracks {
    return { items: this.tracks, audioId: this.audio?.index ?? null, subtitleId: this.subtitle?.index ?? null };
  }

  async load(url: string) {
    try {
      this.reportState("loading");
      if (!globalThis.VideoDecoder) throw new UnsupportedCodecError();
      this.source = new RangeFile(url, this.lifetime.signal, this.options.refreshUrl);
      await this.source.probe();
      this.session = await LibavSession.open(this.source, this.lifetime.signal);
      if (this.disposed) return;
      const session = this.session;
      for (const track of session.streams) {
        if (track.codec_type !== session.libav.AVMEDIA_TYPE_VIDEO || !track.config) continue;
        try {
          if ((await VideoDecoder.isConfigSupported(track.config as VideoDecoderConfig)).supported) {
            this.video = track;
            break;
          }
        } catch { /* Try the next local video track. */ }
      }
      if (!this.video) throw new UnsupportedCodecError();
      const audioTracks = session.streams.filter((track) => track.codec_type === session.libav.AVMEDIA_TYPE_AUDIO);
      if (audioTracks.length && !globalThis.AudioDecoder) throw new UnsupportedCodecError();
      for (const track of audioTracks) {
        let supported = false;
        try {
          supported = Boolean(track.config && (await AudioDecoder.isConfigSupported(track.config as AudioDecoderConfig)).supported);
        } catch { /* Try the next local audio track. */ }
        this.tracks.push(this.describeTrack(track, "audio", supported));
        if (supported && !this.audio) this.audio = track;
      }
      if (audioTracks.length && !this.audio) throw new UnsupportedCodecError();
      if (this.disposed) return;
      for (const track of session.streams.filter((track) => track.codec_type === session.libav.AVMEDIA_TYPE_SUBTITLE)) {
        const supported = ["ass", "ssa", "subrip", "webvtt"].includes(track.codec);
        this.tracks.push(this.describeTrack(track, "subtitle", supported));
        if (supported && !this.subtitle) this.subtitle = track;
      }
      this.notifySubtitle();
      const width = this.video.codecParameters.width;
      const height = this.video.codecParameters.height;
      this.options.canvas.width = width || 960;
      this.options.canvas.height = height || 540;
      if (this.audio) {
        this.audioContext = new AudioContext();
        this.gain = this.audioContext.createGain();
        this.updateGain();
        this.gain.connect(this.audioContext.destination);
      }
      this.loaded = true;
      this.notifyTracks();
      this.reportState();
      this.timer = setInterval(() => {
        this.options.onTimeUpdate(this.lastVideoTime, this.duration,
          this.duration ? Math.min(100, (this.lastVideoTime + this.bufferedAhead) / this.duration * 100) : 0);
        this.reportState();
      }, 250);
      this.options.onReady(this.duration);
      this.restart();
    } catch (error) {
      if (!this.disposed) this.fail(error);
    }
  }

  async unlockAudio() {
    if (this.audioContext?.state !== "suspended") return;
    await this.audioContext.resume();
    if (this.disposed) return;
    this.stopAudio();
    for (const block of this.audioBuffers) this.scheduleAudio(block.buffer, block.start);
    this.reportState();
  }

  async play() {
    if (this.disposed) return;
    void this.unlockAudio().catch(() => {});
    if (this.wantedPlaying) return;
    this.wantedPlaying = true;
    this.ended = false;
    this.clock.play();
    // Resume may require a gesture. Video and room state must not wait on that promise.
    this.restart();
    this.reportState();
  }

  pause() {
    if (this.disposed || !this.wantedPlaying) return;
    this.wantedPlaying = false;
    this.clock.pause();
    this.version += 1;
    this.clearRun();
    this.reportState();
  }

  seek(seconds: number) {
    if (this.disposed || !Number.isFinite(seconds)) return;
    this.clock.seek(Math.min(this.duration || Infinity, Math.max(0, seconds)));
    this.ended = false;
    this.restart();
  }

  setPlaybackRate(rate: number) {
    if (this.clock.rate === rate) return;
    this.clock.setRate(rate);
    // Reschedule both queued and playing PCM from their media PTS after re-anchoring.
    this.stopAudio();
    for (const block of this.audioBuffers) this.scheduleAudio(block.buffer, block.start);
  }

  setVolume(volume: number) { this.volume = Math.max(0, Math.min(100, volume)) / 100; this.updateGain(); }
  setMuted(muted: boolean) { this.muted = muted; this.updateGain(); }
  setSubtitleOffset(seconds: number) { if (Number.isFinite(seconds)) this.subtitleOffset = seconds; }
  setExternalSubtitle(enabled: boolean, captions: TextTrack | null = null) {
    this.externalSubtitle = enabled;
    this.externalCaptions = captions;
    // A VTT track may finish loading without another video frame arriving while paused.
    if (this.loaded && !this.wantedPlaying && !this.disposed) this.restart();
  }

  async selectAudioTrack(id: number) {
    if (this.disposed || !this.session) return;
    const track = this.tracks.find((item) => item.id === id && item.kind === "audio");
    if (!track?.supported) throw new Error("Audio track is not supported");
    if (this.audio?.index === id) return;
    this.audio = this.session.streams.find((item) => item.index === id) ?? null;
    this.restart();
    this.notifyTracks();
  }

  selectSubtitleTrack(id: number | null) {
    if (this.disposed || !this.session) return;
    if (id !== null && !this.tracks.some((item) => item.id === id && item.kind === "subtitle" && item.supported)) {
      throw new Error("Subtitle track is not supported");
    }
    this.subtitle = id === null ? null : this.session.streams.find((item) => item.index === id) ?? null;
    this.notifySubtitle();
    this.restart();
    this.notifyTracks();
  }

  private describeTrack(track: MediaStream, kind: EmbeddedTrack["kind"], supported: boolean): EmbeddedTrack {
    return { id: track.index, kind, codec: track.codec, label: track.metadata?.title ?? `${kind} ${track.index}`,
      language: track.metadata?.language, supported,
      ...(hasDefaultDisposition(track) ? { default: true } : {}) };
  }

  private notifyTracks() {
    this.options.onTracks?.(this.embeddedTracks);
  }

  private notifySubtitle() {
    const track = this.subtitle;
    const session = this.session;
    this.options.onSubtitleReset?.();
    this.options.onSubtitle?.(track && session && ["ass", "ssa"].includes(track.codec) ? {
      index: track.index, header: new TextDecoder().decode(track.codecParameters.extradata).replace(/\0+$/g, ""),
      fonts: session.streams.flatMap((item) => item.codec_type === session.libav.AVMEDIA_TYPE_ATTACHMENT
        && item.codecParameters.extradata?.byteLength ? [item.codecParameters.extradata] : []),
    } : null);
  }

  private get bufferedAhead() {
    const videoEnd = this.frames.at(-1)?.timestamp;
    const videoAhead = videoEnd === undefined ? 0 : Math.max(0, videoEnd / 1e6 - this.currentTime);
    if (!this.audio) return videoAhead;
    const block = this.audioBuffers.at(-1);
    return Math.min(videoAhead, block ? Math.max(0, block.start + block.buffer.duration - this.currentTime) : 0);
  }

  private reportState(phase?: PlayerLocalState["phase"]) {
    if (this.disposed && phase !== "error") return;
    const state: PlayerLocalState = {
      phase: phase ?? (!this.loaded ? "loading" : this.ended ? "ended" : !this.wantedPlaying ? "paused"
        : performance.now() - this.lastDrawWall > 500 ? "buffering" : "playing"),
      audio: !this.audioContext ? "none" : this.audioContext.state === "running" ? "running" : "blocked",
      presentedTime: this.lastVideoTime, bufferedAheadSeconds: this.bufferedAhead,
    };
    const key = JSON.stringify(state);
    if (key !== this.reportedState) { this.reportedState = key; this.options.onLocalState?.(state); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.version += 1;
    this.lifetime.abort();
    this.clearRun();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.session?.close();
    this.session = null;
    if (this.audioContext) void this.audioContext.close().catch(() => {});
    this.audioContext = null;
    this.gain = null;
    this.source = null;
  }

  private restart() {
    const version = ++this.version;
    this.clearRun();
    if (!this.session || this.disposed) return;
    this.run = this.run.then(async () => {
      if (this.isCurrent(version)) await this.decode(version);
    }).catch((error: unknown) => { if (this.isCurrent(version)) this.fail(error); });
  }

  private isCurrent(version: number) { return !this.disposed && this.version === version; }

  private async decode(version: number) {
    const session = this.session;
    const video = this.video;
    if (!session || !video?.config) return;
    const target = this.currentTime;
    const playing = this.wantedPlaying;
    await session.seek(target, video);
    if (!this.isCurrent(version)) return;
    this.previewDone = false;
    this.options.onSubtitleReset?.();
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (!this.isCurrent(version) || frame.timestamp / 1e6 < target - 0.02) { frame.close(); return; }
        if (!playing) {
          if (!this.previewDone) this.draw(frame);
          this.previewDone = true;
          frame.close();
          return;
        }
        this.frames.push(frame);
      },
      error: (error) => { if (this.isCurrent(version)) this.fail(error); },
    });
    this.videoDecoder = decoder;
    decoder.configure(video.config as VideoDecoderConfig);
    if (this.audio?.config && this.audioContext) {
      this.audioDecoder = new AudioDecoder({
        output: (data) => {
          try {
            if (!this.isCurrent(version) || !playing || !this.audioContext) return;
            const buffer = this.audioContext.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
            for (let channel = 0; channel < data.numberOfChannels; channel += 1) {
              const samples = new Float32Array(data.numberOfFrames);
              data.copyTo(samples, { planeIndex: channel, format: "f32-planar" });
              buffer.copyToChannel(samples, channel);
            }
            const start = data.timestamp / 1e6;
            this.audioBuffers.push({ buffer, start });
            this.scheduleAudio(buffer, start);
          } catch (error) { if (this.isCurrent(version)) this.fail(error); }
          finally { data.close(); }
        },
        error: (error) => { if (this.isCurrent(version)) this.fail(error); },
      });
      this.audioDecoder.configure(this.audio.config as AudioDecoderConfig);
    }
    if (playing) this.raf = requestAnimationFrame(() => this.present(version));
    let baseDts: number | null = null;
    let basePts: number | null = null;
    let schedule = 0;
    let eof = false;
    while (this.isCurrent(version) && !this.previewDone) {
      const batch = await session.readPackets();
      if (!this.isCurrent(version)) return;
      const packets = Object.values(batch.packets).flat();
      eof = batch.result === session.libav.AVERROR_EOF;
      // A paused decoder can present its first frame before later stream packets are visited.
      if (!playing && this.subtitle) {
        for (const packet of packets) if (packet.stream_index === this.subtitle.index) this.subtitlePacket(packet, this.subtitle);
      }
      for (const packet of packets) {
        if (!this.isCurrent(version) || this.previewDone) break;
        if (packet.stream_index === video.index) {
          basePts ??= packetSeconds(packet, video);
          const dts = packetDecodeSeconds(packet, video, session.libav);
          if (dts !== null) { baseDts ??= dts; schedule = Math.max(schedule, dts - baseDts); }
          // Recompute the mapping while waiting: a room snapshot can change the rate mid-wait.
          while (playing && this.isCurrent(version) && this.clock.dueMs(basePts + schedule) - 600 > performance.now()) {
            await delay(20);
          }
          while (this.isCurrent(version) && !this.previewDone && (decoder.decodeQueueSize > 24 || this.frames.length > 120)) await delay(4);
          if (!this.isCurrent(version) || this.previewDone) break;
          decoder.decode(session.videoChunk(packet, video));
          schedule += packetDuration(packet, video) || 1 / 30;
        } else if (this.audio && packet.stream_index === this.audio.index && this.audioDecoder?.state === "configured" && playing) {
          while (this.isCurrent(version) && (this.audioDecoder?.decodeQueueSize ?? 0) > 32) await delay(4);
          if (!this.isCurrent(version)) break;
          this.audioDecoder?.decode(session.audioChunk(packet, this.audio));
        } else if (playing && this.subtitle && packet.stream_index === this.subtitle.index) {
          this.subtitlePacket(packet, this.subtitle);
        }
      }
      if (eof) break;
    }
    if (!this.isCurrent(version)) return;
    if (decoder.state === "configured") await decoder.flush();
    if (!this.isCurrent(version)) return;
    if (this.audioDecoder?.state === "configured") await this.audioDecoder.flush();
    if (playing && eof) {
      const end = this.duration || this.lastVideoTime;
      while (this.isCurrent(version) && this.currentTime < end) await delay(20);
      if (this.isCurrent(version) && !this.ended) {
        this.ended = true;
        this.pause();
        this.options.onEnded();
        this.reportState("ended");
      }
    } else if (this.isCurrent(version)) this.clearRun();
  }

  private present(version: number) {
    if (!this.isCurrent(version)) return;
    const now = performance.now();
    let frame: VideoFrame | undefined;
    while (this.frames.length && this.clock.dueMs(this.frames[0].timestamp / 1e6) <= now + 10) {
      frame?.close();
      frame = this.frames.shift();
    }
    if (frame) { this.draw(frame); frame.close(); }
    const current = this.currentTime;
    this.audioBuffers = this.audioBuffers.filter((block) => block.start + block.buffer.duration > current);
    this.captions = this.captions.filter((cue) => cue.end > current);
    this.raf = requestAnimationFrame(() => this.present(version));
  }

  private draw(frame: VideoFrame) {
    const { canvas } = this.options;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(frame, 0, 0, canvas.width, canvas.height);
    const mediaTime = frame.timestamp / 1e6;
    this.lastVideoTime = mediaTime;
    this.lastDrawWall = performance.now();
    canvas.dataset.mediaTime = String(mediaTime);
    canvas.dataset.playbackRate = String(this.clock.rate);
    const cues = this.externalCaptions?.cues;
    const lines = this.externalSubtitle
      ? Array.from(cues ?? []).filter((cue) => cue.startTime <= mediaTime && cue.endTime > mediaTime)
        .map((cue) => cue instanceof VTTCue ? cue.getCueAsHTML().textContent ?? "" : "")
      : this.captions.filter((cue) => cue.start <= mediaTime - this.subtitleOffset
        && cue.end > mediaTime - this.subtitleOffset).map((cue) => cue.text);
    if (lines.length) {
      const style = this.options.subtitleStyle ?? DEFAULT_SUBTITLE_APPEARANCE;
      paintSubtitleLines(context, lines.join("\n").split("\n"), style, canvas.width, canvas.height,
        subtitleMarginPx(canvas.width, canvas.height, canvas.clientWidth, canvas.clientHeight));
    }
    this.options.onFrame?.(mediaTime);
  }

  private subtitlePacket(packet: Packet, track: MediaStream) {
    const text = new TextDecoder().decode(packet.data).replace(/\0+$/g, "").trim();
    if (!text) return;
    const start = packetSeconds(packet, track);
    const duration = packetDuration(packet, track) || 4;
    if (["ass", "ssa"].includes(track.codec)) this.options.onSubtitlePacket?.(text, start, duration);
    else this.captions.push({ start, end: start + duration, text });
  }

  private scheduleAudio(buffer: AudioBuffer, mediaStart: number) {
    const context = this.audioContext;
    if (!context || !this.wantedPlaying || context.state !== "running") return;
    const due = this.clock.dueMs(mediaStart);
    const output = context.getOutputTimestamp();
    const hasOutput = Number.isFinite(output.contextTime) && (output.performanceTime ?? 0) > 0;
    const contextTime = hasOutput ? output.contextTime! : context.currentTime;
    const wallTime = hasOutput ? output.performanceTime! : performance.now();
    const when = Math.max(context.currentTime + 0.005, contextTime + (due - wallTime) / 1000);
    const late = Math.max(0, (wallTime + (when - contextTime) * 1000 - due) / 1000);
    const offset = Math.floor(late * buffer.sampleRate * this.clock.rate) / buffer.sampleRate;
    if (offset >= buffer.duration) return;
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = this.clock.rate;
    node.connect(this.gain ?? context.destination);
    this.audioNodes.add(node);
    node.onended = () => { this.audioNodes.delete(node); node.disconnect(); };
    node.start(when, offset);
  }

  private updateGain() { if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume; }
  private stopAudio() {
    for (const node of this.audioNodes) { node.onended = null; node.stop(); node.disconnect(); }
    this.audioNodes.clear();
  }
  private clearRun() {
    cancelAnimationFrame(this.raf);
    for (const frame of this.frames.splice(0)) frame.close();
    if (this.videoDecoder?.state !== "closed") this.videoDecoder?.close();
    if (this.audioDecoder?.state !== "closed") this.audioDecoder?.close();
    this.videoDecoder = null;
    this.audioDecoder = null;
    this.stopAudio();
    this.audioBuffers = [];
    this.captions = [];
  }
  private fail(error: unknown) {
    const unsupported = error instanceof UnsupportedCodecError
      || error instanceof DOMException && error.name === "NotSupportedError";
    const message = unsupported ? "当前浏览器不支持该媒体编码，请使用桌面端播放"
      : error instanceof Error ? error.message : "MKV 播放失败";
    this.dispose();
    this.reportState("error");
    this.options.onError(message, unsupported);
  }
}

class UnsupportedCodecError extends Error {}
function packetDuration(packet: Packet, stream: MediaStream) {
  return ((packet.duration ?? 0) + (packet.durationhi ?? 0) * 0x100000000) * stream.time_base_num / stream.time_base_den;
}
function delay(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, ms)); }
