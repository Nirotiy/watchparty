import LibAV from "@libav.js/variant-webcodecs";
import type * as LibAVTypes from "@libav.js/types";
import {
  audioStreamToConfig,
  videoStreamToConfig,
  packetToEncodedAudioChunk,
  packetToEncodedVideoChunk,
} from "libavjs-webcodecs-bridge";
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
  private readonly windows: ReadWindow[] = [];
  private demandPosition = 0;
  private demandInflight: ReadWindowFetch | null = null;
  private readonly prefetchInflight = new Map<number, ReadWindowFetch>();
  private readonly prefetchParallel = 3;

  constructor(private readonly source: MediaSource) {}

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

/** Owns the libav worker, block device and Matroska format context for one POC run. */
export class LibavSession {
  readonly libav: LibAVTypes.LibAV;
  readonly streams: MediaStream[];
  readonly durationSeconds: number;
  private readonly formatContext: number;
  private readonly packetPointer: number;
  private readonly filename: string;
  private disposed = false;

  private constructor(
    libav: LibAVTypes.LibAV,
    filename: string,
    formatContext: number,
    packetPointer: number,
    streams: MediaStream[],
    durationSeconds: number,
  ) {
    this.libav = libav;
    this.filename = filename;
    this.formatContext = formatContext;
    this.packetPointer = packetPointer;
    this.streams = streams;
    this.durationSeconds = durationSeconds;
  }

  static async open(source: MediaSource) {
    const base = new URL("libav/", location.href).href;
    const factoryUrl = new URL("libav-6.10.9.0-webcodecs.wasm.mjs", base).href;
    const libav = await LibAV.LibAV({ base, toImport: factoryUrl });
    const filename = `media-${crypto.randomUUID()}.mkv`;
    const reader = new ReadAheadReader(source);
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
          ? await videoStreamToConfig(libav, stream)
          : stream.codec_type === libav.AVMEDIA_TYPE_AUDIO
            ? await audioStreamToConfig(libav, stream)
            : null;
        const config = bridgeConfig as BridgeDecoderConfig | null;
        return { ...stream, codec, config, codecParameters };
      });
      const mediaStreams = await Promise.all(packetRows);
      packetPointer = await libav.av_packet_alloc();
      const durationLo = await libav.AVFormatContext_duration(formatContext);
      const durationHi = await libav.AVFormatContext_durationhi(formatContext);
      const containerMicros = durationLo + durationHi * 4294967296;
      const streamDuration = Math.max(0, ...mediaStreams.map((stream) => stream.duration));
      // MKV often omits per-track Duration (AVStream.duration = N/A); container duration (AV_TIME_BASE) is authoritative there.
      const duration = containerMicros > 0 ? containerMicros / 1e6 : streamDuration;
      return new LibavSession(libav, filename, formatContext, packetPointer, mediaStreams, duration);
    } catch (error) {
      if (packetPointer !== undefined) await libav.av_packet_free(packetPointer);
      if (formatContext !== undefined) await libav.avformat_close_input_js(formatContext);
      libav.terminate();
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
    return packetToEncodedVideoChunk(packet, stream);
  }

  audioChunk(packet: LibAVTypes.Packet, stream: MediaStream) {
    return packetToEncodedAudioChunk(packet, stream);
  }

  async close() {
    if (this.disposed) return;
    this.disposed = true;
    await this.libav.av_packet_free(this.packetPointer);
    await this.libav.avformat_close_input_js(this.formatContext);
    await this.libav.unlink(this.filename);
    this.libav.terminate();
  }

  private ensureOpen() {
    if (this.disposed) throw new Error("libav session is closed");
  }
}

export function packetSeconds(packet: LibAVTypes.Packet, stream: MediaStream) {
  const timestamp = LibAV.i64tof64(packet.pts ?? 0, packet.ptshi ?? 0);
  return timestamp * stream.time_base_num / stream.time_base_den;
}

export function packetDecodeSeconds(packet: LibAVTypes.Packet, stream: MediaStream, libav: LibAVTypes.LibAV) {
  if (packet.dts === undefined || packet.dtshi === undefined) return null;
  if (packet.dts === libav.AV_NOPTS_VALUE_LO && packet.dtshi === libav.AV_NOPTS_VALUE_HI) return null;
  const timestamp = LibAV.i64tof64(packet.dts, packet.dtshi);
  return timestamp * stream.time_base_num / stream.time_base_den;
}
