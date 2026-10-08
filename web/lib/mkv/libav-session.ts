import type * as LibAVTypes from "@libav.js/types";
import type * as WebCodecsBridge from "./libavjs-webcodecs-bridge";
import type { RangeFile } from "./range-file";

export type MediaSource = RangeFile | File;
export type BridgeDecoderConfig = (VideoDecoderConfig | AudioDecoderConfig) & { codec: string };
export type MediaStream = LibAVTypes.Stream & {
  codec: string;
  config: BridgeDecoderConfig | null;
  codecParameters: LibAVTypes.CodecParameters;
};
export type PacketBatch = { result: number; packets: Record<number, LibAVTypes.Packet[]> };

const READAHEAD_BYTES = 4 * 1024 * 1024;
const READAHEAD_WINDOW_LIMIT = 10;
const PREFETCH_RUNWAY = 6 * READAHEAD_BYTES;

type ReadWindow = { start: number; bytes: Uint8Array };
type ReadWindowFetch = { start: number; end: number; promise: Promise<ReadWindow> };

/** Coalesces FFmpeg's small block reads into fewer, larger range requests; per-request latency dominates on remote sources. */
class ReadAheadReader {
  private closed = false;
  private readonly windows: ReadWindow[] = [];
  private demandPosition = 0;
  private demandInflight: ReadWindowFetch | null = null;
  private readonly prefetchInflight = new Map<number, ReadWindowFetch>();
  private readonly prefetchParallel = 3;

  constructor(private readonly source: MediaSource) {}

  close() {
    this.closed = true;
    this.windows.length = 0;
    this.prefetchInflight.clear();
    this.demandInflight = null;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    // A read far from the last one is a jump (seek/metadata tail): move the prefetch frontier there instead of max()-ing.
    this.demandPosition = Math.abs(start - this.demandPosition) <= READAHEAD_BYTES ? Math.max(this.demandPosition, end) : end;
    const cached = this.serveFromCache(start, end);
    if (cached) {
      this.prefetchAfter();
      return cached;
    }
    const inflight = this.findInflight(start, end);
    const w = inflight
      ? await inflight.promise
      : await this.startFetch(start, Math.min(this.source.size, Math.max(end, start + READAHEAD_BYTES)), false);
    this.prefetchAfter();
    return w.bytes.subarray(start - w.start, end - w.start);
  }

  /** Serves a range from the union of cached windows; reads that span two adjacent windows are assembled. */
  private serveFromCache(start: number, end: number): Uint8Array | null {
    let cursor = start;
    const parts: Array<{ offset: number; bytes: Uint8Array }> = [];
    while (cursor < end) {
      const w = this.windows.find((x) => cursor >= x.start && cursor < x.start + x.bytes.byteLength);
      if (!w) return null;
      const pieceEnd = Math.min(end, w.start + w.bytes.byteLength);
      parts.push({ offset: cursor - start, bytes: w.bytes.subarray(cursor - w.start, pieceEnd - w.start) });
      cursor = pieceEnd;
    }
    if (parts.length === 1) return parts[0].bytes;
    const assembled = new Uint8Array(end - start);
    for (const part of parts) assembled.set(part.bytes, part.offset);
    return assembled;
  }

  /** Finds an in-flight read (demand or prefetch) that fully covers the requested range. */
  private findInflight(start: number, end: number): ReadWindowFetch | null {
    if (this.demandInflight && start >= this.demandInflight.start && end <= this.demandInflight.end) return this.demandInflight;
    for (const fetch of this.prefetchInflight.values()) {
      if (start >= fetch.start && end <= fetch.end) return fetch;
    }
    return null;
  }

  /** Finds an in-flight read that covers a single frontier position. */
  private findInflightAt(position: number): ReadWindowFetch | null {
    if (this.demandInflight && position >= this.demandInflight.start && position < this.demandInflight.end) return this.demandInflight;
    for (const fetch of this.prefetchInflight.values()) {
      if (position >= fetch.start && position < fetch.end) return fetch;
    }
    return null;
  }

  /** Keeps up to `prefetchParallel` fetches busy, but never further ahead than `PREFETCH_RUNWAY` beyond the consumed position. */
  private prefetchAfter() {
    if (this.closed) return;
    if (this.source instanceof File) return;
    const limit = Math.min(this.source.size, this.demandPosition + PREFETCH_RUNWAY);
    let cursor = this.demandPosition;
    for (let guard = 0; guard < 32 && cursor < limit; guard += 1) {
      const covering = this.windows.find((x) => cursor >= x.start && cursor < x.start + x.bytes.byteLength);
      if (covering) {
        cursor = covering.start + covering.bytes.byteLength;
        continue;
      }
      const inFlight = this.findInflightAt(cursor);
      if (inFlight) {
        cursor = inFlight.end;
        continue;
      }
      if (this.prefetchInflight.size >= this.prefetchParallel) return;
      this.startFetch(cursor, Math.min(this.source.size, cursor + READAHEAD_BYTES), true);
      return;
    }
  }

  private startFetch(start: number, end: number, isPrefetch: boolean): Promise<ReadWindow> {
    const promise = (async (): Promise<ReadWindow> => {
      const bytes = this.source instanceof File
        ? new Uint8Array(await this.source.slice(start, end).arrayBuffer())
        : new Uint8Array(await this.source.read(start, end));
      const w = { start, bytes };
      if (this.closed) return w;
      this.windows.unshift(w);
      if (this.windows.length > READAHEAD_WINDOW_LIMIT) this.windows.pop();
      return w;
    })();
    const task: ReadWindowFetch = { start, end, promise };
    if (isPrefetch) {
      this.prefetchInflight.set(start, task);
      void promise.then(
        () => {
          this.prefetchInflight.delete(start);
          this.prefetchAfter();
        },
        () => { this.prefetchInflight.delete(start); },
      );
    } else {
      this.demandInflight = task;
      void promise.catch(() => { /* errors surface through the awaiting read() */ }).finally(() => {
        if (this.demandInflight === task) this.demandInflight = null;
      });
    }
    return promise;
  }
}

/** Owns the libav worker and bounded read cache for one room media source. */
export class LibavSession {
  readonly libav: LibAVTypes.LibAV;
  readonly streams: MediaStream[];
  readonly durationSeconds: number;
  private readonly formatContext: number;
  private readonly packetPointer: number;
  private readonly filename: string;
  private disposed = false;
  private readonly release: () => void;
  private readonly bridge: typeof WebCodecsBridge;

  private constructor(
    libav: LibAVTypes.LibAV,
    filename: string,
    formatContext: number,
    packetPointer: number,
    streams: MediaStream[],
    durationSeconds: number,
    release: () => void,
    bridge: typeof WebCodecsBridge,
  ) {
    this.libav = libav;
    this.filename = filename;
    this.formatContext = formatContext;
    this.packetPointer = packetPointer;
    this.streams = streams;
    this.durationSeconds = durationSeconds;
    this.release = release;
    this.bridge = bridge;
  }

  static async open(source: MediaSource, signal: AbortSignal) {
    signal.throwIfAborted();
    // Keep the loader outside webpack: its typeof process check must see the browser,
    // not Next's injected process shim, or it selects main-thread Node mode.
    const loaderUrl = "/vendor/libav/libav-webcodecs.mjs";
    const { default: LibAV } = await import(/* webpackIgnore: true */ loaderUrl) as { default: typeof import("@libav.js/variant-webcodecs") };
    const bridgeUrl = "/vendor/libav/bridge.mjs";
    const bridge = await import(/* webpackIgnore: true */ bridgeUrl) as typeof WebCodecsBridge;
    signal.throwIfAborted();
    const base = new URL("/vendor/libav/", location.href).href;
    const factoryUrl = new URL("libav-6.10.9.0-webcodecs.wasm.mjs", base).href;
    const libav = await createLibavWorker(LibAV.LibAV, factoryUrl, signal);
    const filename = `media-${crypto.randomUUID()}.mkv`;
    const reader = new ReadAheadReader(source);
    let terminated = false;
    const terminate = () => {
      if (terminated) return;
      terminated = true;
      reader.close();
      libav.terminate();
    };
    const release = () => { signal.removeEventListener("abort", terminate); terminate(); };
    signal.addEventListener("abort", terminate, { once: true });
    if (signal.aborted) { release(); signal.throwIfAborted(); }
    let formatContext: number | undefined;
    let packetPointer: number | undefined;

    libav.onblockread = async (name, position, length) => {
      try {
        if (position >= source.size) {
          await libav.ff_block_reader_dev_send(name, position, new Uint8Array());
          return;
        }
        const end = Math.min(source.size, position + length);
        const bytes = await reader.read(position, end);
        await libav.ff_block_reader_dev_send(name, position, bytes);
      } catch (error) {
        if (signal.aborted) return;
        await libav.ff_block_reader_dev_send(name, position, null, {
          errorCode: libav.EIO,
          error: error instanceof Error ? error.message : "媒体 Range 读取失败",
        });
      }
    };

    try {
      await libav.mkblockreaderdev(filename, source.size);
      const [openedContext, streams] = await libav.ff_init_demuxer_file(filename);
      formatContext = openedContext;
      const packetRows = streams.map(async (stream): Promise<MediaStream> => {
        const codecParameters = await libav.ff_copyout_codecpar(stream.codecpar);
        const codec = await libav.avcodec_get_name(stream.codec_id);
        const bridgeConfig = stream.codec_type === libav.AVMEDIA_TYPE_VIDEO
          ? await bridge.videoStreamToConfig(libav, stream)
          : stream.codec_type === libav.AVMEDIA_TYPE_AUDIO
            ? await bridge.audioStreamToConfig(libav, stream)
            : null;
        const config = bridgeConfig as BridgeDecoderConfig | null;
        return { ...stream, codec, config, codecParameters };
      });
      const mediaStreams = await Promise.all(packetRows);
      packetPointer = await libav.av_packet_alloc();
      const durationLo = await libav.AVFormatContext_duration(formatContext);
      const durationHi = await libav.AVFormatContext_durationhi(formatContext);
      const containerMicros = libav.i64tof64(durationLo, durationHi);
      const streamDuration = Math.max(0, ...mediaStreams.map((stream) => stream.duration));
      // MKV often omits per-track Duration (AVStream.duration = N/A); container duration (AV_TIME_BASE) is authoritative there.
      const duration = containerMicros > 0 ? containerMicros / 1e6 : streamDuration;
      signal.throwIfAborted();
      return new LibavSession(libav, filename, formatContext, packetPointer, mediaStreams, duration, release, bridge);
    } catch (error) {
      release();
      throw error;
    }
  }

  async readPackets(limit = 512 * 1024): Promise<PacketBatch> {
    this.ensureOpen();
    const [result, packets] = await this.libav.ff_read_frame_multi(this.formatContext, this.packetPointer, {
      limit,
      unify: true,
      copyoutPacket: "default",
    });
    return { result, packets };
  }

  async seek(seconds: number, stream: MediaStream) {
    this.ensureOpen();
    const timestamp = BigInt(Math.max(0, Math.floor(seconds / (stream.time_base_num / stream.time_base_den))));
    const [low, high] = this.libav.bigIntToi64(timestamp);
    const result = await this.libav.av_seek_frame(
      this.formatContext,
      stream.index,
      low,
      high,
      this.libav.AVSEEK_FLAG_BACKWARD,
    );
    if (result < 0) throw new Error(`libav seek failed: ${await this.libav.strerror(-result)}`);
    await this.libav.avformat_flush(this.formatContext);
  }

  videoChunk(packet: LibAVTypes.Packet, stream: MediaStream) {
    return this.bridge.packetToEncodedVideoChunk(packet, stream);
  }

  audioChunk(packet: LibAVTypes.Packet, stream: MediaStream) {
    return this.bridge.packetToEncodedAudioChunk(packet, stream);
  }

  async close() {
    if (this.disposed) return;
    this.disposed = true;
    // Termination releases worker-owned FFmpeg allocations even during a blocked read.
    this.release();
  }

  private ensureOpen() {
    if (this.disposed) throw new Error("libav session is closed");
  }
}

/** Own the Worker before libav resolves, including aborts and failed initialization. */
export async function createLibavWorker(
  factory: (options: { toImport: string; worker: Worker }) => Promise<LibAVTypes.LibAV>,
  factoryUrl: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const worker = new Worker(factoryUrl, { type: "module" });
  let accepted = false;
  let rejectStartup: (error: unknown) => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => { rejectStartup = reject; });
  const abort = () => rejectStartup(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => rejectStartup(new Error("MKV 解码引擎初始化超时")), 15000);
  try {
    const pending = factory({ toImport: factoryUrl, worker });
    void pending.then((libav) => { if (!accepted && signal.aborted) libav.terminate(); }, () => {});
    const libav = await Promise.race([pending, interrupted]);
    signal.throwIfAborted();
    accepted = true;
    return libav;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    if (!accepted) worker.terminate();
  }
}

export function packetSeconds(packet: LibAVTypes.Packet, stream: MediaStream) {
  const low = packet.pts ?? 0;
  const timestamp = (packet.ptshi ?? 0) * 4294967296 + low + (low < 0 ? 4294967296 : 0);
  return timestamp * stream.time_base_num / stream.time_base_den;
}

export function packetDecodeSeconds(packet: LibAVTypes.Packet, stream: MediaStream, libav: LibAVTypes.LibAV) {
  if (packet.dts === undefined || packet.dtshi === undefined) return null;
  if (packet.dts === libav.AV_NOPTS_VALUE_LO && packet.dtshi === libav.AV_NOPTS_VALUE_HI) return null;
  const timestamp = libav.i64tof64(packet.dts, packet.dtshi);
  return timestamp * stream.time_base_num / stream.time_base_den;
}
