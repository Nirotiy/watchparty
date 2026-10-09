/** Browser-only state. None of these fields belongs to the shared room snapshot. */
export type PlayerLocalState = {
  phase: "loading" | "ready" | "playing" | "paused" | "buffering" | "ended" | "error";
  audio: "none" | "blocked" | "running" | "muted" | "unknown";
  presentedTime: number;
  bufferedAheadSeconds: number;
};

export type PlayerCapabilities = {
  engine: "mkv" | "native" | "hls" | "youtube";
  embeddedTracks: boolean;
  audioUnlock: boolean;
  retry: boolean;
  bufferedAhead: boolean;
};

/** Only the contiguous range containing the current playhead is playable ahead. */
export function bufferedAheadSeconds(ranges: Pick<TimeRanges, "length" | "start" | "end">, time: number): number {
  for (let index = 0; index < ranges.length; index += 1) {
    if (ranges.start(index) <= time && ranges.end(index) >= time) return Math.max(0, ranges.end(index) - time);
  }
  return 0;
}

export type EmbeddedTrack = {
  id: number;
  kind: "audio" | "subtitle";
  codec: string;
  label: string;
  language?: string;
  supported: boolean;
  /**
   * 容器里的"媒体默认轨"标记（MKV FlagDefault）。
   * 当前 libav.js 6.10.9.0 构建不暴露 disposition，引擎恒为 undefined；
   * "跟随媒体默认"因此在有标记时优先它、无标记时按语言列表回退。
   */
  default?: boolean;
};

export type EmbeddedTracks = {
  items: EmbeddedTrack[];
  audioId: number | null;
  subtitleId: number | null;
};
