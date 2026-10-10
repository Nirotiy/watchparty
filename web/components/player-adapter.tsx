"use client";

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import Hls from "hls.js";
import type JASSUB from "jassub";
import type { MediaSource, SubtitleTrack } from "@/lib/contracts";
import { MkvPlayerAdapter } from "./mkv-player-adapter";
import { isMkvSource } from "@/lib/mkv/compatibility";
import { bufferedAheadSeconds, type PlayerLocalState, type EmbeddedTracks, type PlayerCapabilities } from "@/lib/player-local";
import { DEFAULT_SUBTITLE_APPEARANCE, type PictureFit, type SubtitleAppearance } from "@/lib/player-preferences";
import { parseSubtitleCues } from "@/lib/subtitle-parser";
import { paintSubtitleLines, subtitleMarginPx } from "@/lib/mkv/subtitle-paint";
import { youtubeErrorCode, youtubeErrorMessage } from "@/lib/youtube";

type YouTubePlayer = {
  destroy: () => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getVideoLoadedFraction: () => number;
  mute: () => void;
  pauseVideo: () => void;
  playVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  setPlaybackRate: (rate: number) => void;
  setVolume: (volume: number) => void;
  unMute: () => void;
};

type YouTubePlayerEvent = { target: YouTubePlayer };
type YouTubeStateEvent = YouTubePlayerEvent & { data: number };
type YouTubeErrorEvent = YouTubePlayerEvent & { data?: unknown };
type YouTubeNamespace = {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      playerVars: Record<string, number>;
      events: {
        onReady: (event: YouTubePlayerEvent) => void;
        onStateChange: (event: YouTubeStateEvent) => void;
        onError: (event: YouTubeErrorEvent) => void;
        onAutoplayBlocked: () => void;
      };
    },
  ) => YouTubePlayer;
};

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let youtubeApiPromise: Promise<YouTubeNamespace> | null = null;

function loadYouTubeApi(): Promise<YouTubeNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApiPromise) return youtubeApiPromise;

  const pendingApi = new Promise<YouTubeNamespace>((resolve, reject) => {
    const fail = (message: string) => {
      document.querySelector('script[src="https://www.youtube.com/iframe_api"]')?.remove();
      window.clearTimeout(timeout);
      if (window.onYouTubeIframeAPIReady === ready) window.onYouTubeIframeAPIReady = previousReady;
      reject(new Error(message));
    };
    const timeout = window.setTimeout(() => fail("YouTube IFrame API 加载超时"), 10_000);
    const previousReady = window.onYouTubeIframeAPIReady;
    const ready = () => {
      previousReady?.();
      window.clearTimeout(timeout);
      if (window.onYouTubeIframeAPIReady === ready) window.onYouTubeIframeAPIReady = previousReady;
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error("YouTube IFrame API 不可用"));
    };
    window.onYouTubeIframeAPIReady = ready;

    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => fail("YouTube IFrame API 加载失败");
      document.head.appendChild(script);
    }
  }).catch((error: unknown) => {
    youtubeApiPromise = null;
    throw error;
  });

  youtubeApiPromise = pendingApi;
  return pendingApi;
}

export interface PlayerAdapterHandle {
  play: () => Promise<void>;
  pause: () => void;
  seek: (seconds: number) => void;
  setPlaybackRate: (rate: number) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  unlockAudio?: () => Promise<void>;
  retry?: () => void;
  selectAudioTrack?: (id: number) => Promise<void>;
  selectSubtitleTrack?: (id: number | null) => void;
  getEmbeddedTracks?: () => EmbeddedTracks;
}

export interface PlayerAdapterProps {
  source: MediaSource | null;
  streamUrl: string | null;
  refreshStreamUrl?: () => Promise<string>;
  subtitleVttUrl?: string | null;
  assSubtitle?: { content: string; offsetSeconds: number } | null;
  subtitleOffsetSeconds?: number;
  /** 普通字幕外观（即时生效；ASS 原样式与 YouTube 自身能力不适用）。 */
  subtitleStyle?: SubtitleAppearance;
  /** 画面缩放：完整显示/铺满画面（仅浏览器原生与 MKV 路径；YouTube 由调用方标记不适用）。 */
  pictureFit?: PictureFit;
  /** 原生路径 VTT/SRT 覆盖层的数据源（MKV 路径走 subtitleVttUrl 隐藏轨，互不干扰）。 */
  subtitleText?: string | null;
  subtitleFormat?: SubtitleTrack["format"] | null;
  onTimeUpdate?: (currentTime: number, duration: number, bufferedPercent: number) => void;
  onLoadedMetadata?: (duration: number) => void;
  onEnded?: () => void;
  onPlayClick?: (info?: { pointerType?: string }) => void;
  onError?: (error: { code: string; message: string; isStreamExpired?: boolean }) => void;
  onLocalState?: (state: PlayerLocalState) => void;
  onEmbeddedTracks?: (tracks: EmbeddedTracks) => void;
  onCapabilities?: (capabilities: PlayerCapabilities) => void;
  preferredAudioLanguages?: string[];
}

export const PlayerAdapter = forwardRef<PlayerAdapterHandle, PlayerAdapterProps>(function PlayerAdapter(props, ref) {
  return isMkvSource(props.source)
    ? <MkvPlayerAdapter {...props} ref={ref} key={props.source?.kind === "openlist" ? props.source.mediaId : props.streamUrl} />
    : <NativePlayerAdapter {...props} ref={ref} />;
});

const NativePlayerAdapter = forwardRef<PlayerAdapterHandle, PlayerAdapterProps>(
  function PlayerAdapter(props, ref) {
    const {
      source,
      streamUrl,
      assSubtitle,
      subtitleOffsetSeconds = 0,
      subtitleStyle,
      pictureFit,
      subtitleText,
      subtitleFormat,
    } = props;
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const hlsRef = useRef<Hls | null>(null);
    const youtubeContainerRef = useRef<HTMLDivElement | null>(null);
    const subtitleCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const youtubePlayerRef = useRef<YouTubePlayer | null>(null);
    const youtubeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    /** 本机 YouTube 是否已确定不可用（接口加载失败/构造失败）；控制调用据此上报 CONTROL_UNAVAILABLE。 */
    const youtubeFailedRef = useRef(false);
    const youtubeControlReportedRef = useRef(false);
    const assRendererRef = useRef<JASSUB | null>(null);
    const callbacksRef = useRef(props);
    callbacksRef.current = props;
    const controls = useRef({ playing: false, position: 0, rate: 1, volume: 85, muted: false });
    const local = useRef<PlayerLocalState>({ phase: "loading", audio: "unknown", presentedTime: 0, bufferedAheadSeconds: 0 });
    const [retryVersion, setRetryVersion] = useState(0);
    const [retryUrl, setRetryUrl] = useState<{ sourceKey: string | null; originalUrl: string | null; url: string } | null>(null);
    const retryPending = useRef<object | null>(null);
    const audioBlocked = useRef(false);
    const sourceGeneration = useRef(0);

    const isYouTube = source?.kind === "youtube";
    const fitClass = pictureFit === "cover" ? "object-cover" : "object-contain";
    const sourceKind = source?.kind;
    const youtubeVideoId = source?.kind === "youtube" ? source.videoId : null;
    const sourceKey = source?.kind === "openlist" ? `openlist:${source.mediaId}`
      : source?.kind === "youtube" ? `youtube:${source.videoId}` : source ? `${source.kind}:${source.url}` : null;
    const previousSourceKey = useRef(sourceKey);
    const effectiveStreamUrl = retryUrl?.sourceKey === sourceKey && retryUrl.originalUrl === streamUrl ? retryUrl.url : streamUrl;

    const reportState = useCallback((patch: Partial<PlayerLocalState> = {}) => {
      const video = videoRef.current;
      const player = youtubePlayerRef.current;
      const position = player?.getCurrentTime() ?? video?.currentTime ?? 0;
      local.current = { ...local.current, presentedTime: Number.isFinite(position) ? position : 0,
        bufferedAheadSeconds: player ? 0 : video ? bufferedAheadSeconds(video.buffered, video.currentTime) : 0, ...patch };
      callbacksRef.current.onLocalState?.({ ...local.current });
    }, []);

    const reportAudio = useCallback(() => {
      const muted = controls.current.muted || controls.current.volume === 0;
      reportState({ audio: muted ? "muted" : audioBlocked.current ? "blocked"
        : local.current.phase === "playing" ? "running" : "unknown" });
    }, [reportState]);

    /** 只在本机播放器已确定不可用时上报（加载窗口内的控制在 onReady 后会重放，不算失败），每次挂载至多一次。 */
    const reportYouTubeControlUnavailable = useCallback(() => {
      if (youtubePlayerRef.current || !youtubeFailedRef.current || youtubeControlReportedRef.current) return;
      youtubeControlReportedRef.current = true;
      callbacksRef.current.onError?.({
        code: "YOUTUBE_CONTROL_UNAVAILABLE",
        message: youtubeErrorMessage("YOUTUBE_CONTROL_UNAVAILABLE"),
      });
    }, []);

    const playLocal = useCallback(async () => {
      if (isYouTube) {
        if (youtubePlayerRef.current) youtubePlayerRef.current.playVideo();
        else reportYouTubeControlUnavailable();
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      const generation = sourceGeneration.current;
      try { await video.play(); }
      catch (error: unknown) {
        if (generation !== sourceGeneration.current) return;
        if (error instanceof DOMException && error.name === "NotAllowedError") { audioBlocked.current = true; reportAudio(); }
        else if (!(error instanceof DOMException && error.name === "AbortError")) {
          reportState({ phase: "error" });
          callbacksRef.current.onError?.({ code: "MEDIA_PLAY_ERROR", message: error instanceof Error ? error.message : "Playback failed" });
        }
      }
    }, [isYouTube, reportState, reportAudio, reportYouTubeControlUnavailable]);

    useEffect(() => {
      if (previousSourceKey.current !== sourceKey) {
        controls.current.position = 0;
        previousSourceKey.current = sourceKey;
      }
      callbacksRef.current.onEmbeddedTracks?.({ items: [], audioId: null, subtitleId: null });
      callbacksRef.current.onCapabilities?.({ engine: isYouTube ? "youtube"
        : sourceKind === "hls" || streamUrl?.toLowerCase().includes(".m3u8") ? "hls" : "native",
        embeddedTracks: false, audioUnlock: true, retry: true, bufferedAhead: !isYouTube });
    }, [sourceKey, sourceKind, streamUrl, isYouTube]);

    useImperativeHandle(
      ref,
      () => ({
        play: async () => {
          controls.current.playing = true;
          await playLocal();
        },
        pause: () => {
          controls.current.playing = false;
          if (isYouTube) {
            if (youtubePlayerRef.current) youtubePlayerRef.current.pauseVideo();
            else reportYouTubeControlUnavailable();
          } else videoRef.current?.pause();
        },
        seek: (seconds) => {
          if (!Number.isFinite(seconds)) return;
          controls.current.position = Math.max(0, seconds);
          if (isYouTube) {
            if (youtubePlayerRef.current) youtubePlayerRef.current.seekTo(seconds, true);
            else reportYouTubeControlUnavailable();
          } else if (videoRef.current?.readyState) videoRef.current.currentTime = Math.max(0, seconds);
        },
        setPlaybackRate: (rate) => {
          controls.current.rate = rate;
          if (isYouTube) {
            if (youtubePlayerRef.current) youtubePlayerRef.current.setPlaybackRate(rate);
            else reportYouTubeControlUnavailable();
          } else if (videoRef.current) videoRef.current.playbackRate = rate;
        },
        setVolume: (volume) => {
          const normalizedVolume = Math.max(0, Math.min(100, volume));
          controls.current.volume = normalizedVolume;
          if (isYouTube) youtubePlayerRef.current?.setVolume(normalizedVolume);
          else if (videoRef.current) videoRef.current.volume = normalizedVolume / 100;
          reportAudio();
        },
        setMuted: (muted) => {
          controls.current.muted = muted;
          if (isYouTube) {
            if (muted) youtubePlayerRef.current?.mute();
            else youtubePlayerRef.current?.unMute();
          } else if (videoRef.current) {
            videoRef.current.muted = muted;
          }
          reportAudio();
        },
        getCurrentTime: () =>
          isYouTube
            ? (youtubePlayerRef.current?.getCurrentTime() ?? 0)
            : (videoRef.current?.currentTime ?? 0),
        getDuration: () =>
          isYouTube
            ? (youtubePlayerRef.current?.getDuration() ?? 0)
            : (videoRef.current?.duration ?? 0),
        unlockAudio: async () => { if (controls.current.playing) await playLocal(); },
        retry: () => {
          if (retryPending.current) return;
          const position = isYouTube ? youtubePlayerRef.current?.getCurrentTime() : videoRef.current?.currentTime;
          if (position !== undefined && Number.isFinite(position)) controls.current.position = position;
          const refresh = callbacksRef.current.refreshStreamUrl;
          if (isYouTube || sourceKind !== "openlist" || !refresh) {
            setRetryVersion((value) => value + 1);
            return;
          }
          const retry = {};
          retryPending.current = retry;
          const generation = sourceGeneration.current;
          reportState({ phase: "loading" });
          void refresh().then((url) => {
            if (generation !== sourceGeneration.current) return;
            setRetryUrl({ sourceKey, originalUrl: streamUrl, url });
            setRetryVersion((value) => value + 1);
          }).catch(() => {
            if (generation !== sourceGeneration.current) return;
            reportState({ phase: "error" });
            callbacksRef.current.onError?.({ code: "MEDIA_RETRY_ERROR", message: "Media URL could not be refreshed" });
          }).finally(() => { if (retryPending.current === retry) retryPending.current = null; });
        },
      }),
      [isYouTube, playLocal, reportAudio, reportState, reportYouTubeControlUnavailable, sourceKey, sourceKind, streamUrl],
    );

    useEffect(() => {
      if (!isYouTube || !youtubeVideoId || !youtubeContainerRef.current) return;
      let cancelled = false;
      const container = youtubeContainerRef.current;
      const mount = document.createElement("div");
      container.replaceChildren(mount);
      sourceGeneration.current += 1;
      retryPending.current = null;
      audioBlocked.current = false;
      youtubeFailedRef.current = false;
      youtubeControlReportedRef.current = false;
      reportState({ phase: "loading", audio: "unknown", presentedTime: 0, bufferedAheadSeconds: 0 });

      void loadYouTubeApi()
        .then((youtube) => {
          if (cancelled || !youtubeContainerRef.current) return;
          try {
            youtubePlayerRef.current = new youtube.Player(mount, {
              videoId: youtubeVideoId,
              playerVars: {
                autoplay: 0,
                controls: 0,
                disablekb: 1,
                fs: 0,
                modestbranding: 1,
                rel: 0,
                enablejsapi: 1,
              },
              events: {
                onReady: ({ target }) => {
                  if (cancelled) return;
                  const state = controls.current;
                  target.setVolume(state.volume);
                  if (state.muted) target.mute(); else target.unMute();
                  target.setPlaybackRate(state.rate);
                  if (state.position) target.seekTo(state.position, true);
                  reportState({ phase: "ready" });
                  callbacksRef.current.onLoadedMetadata?.(target.getDuration() || 0);
                  if (controls.current.playing) target.playVideo(); else target.pauseVideo();
                  youtubeTimerRef.current = setInterval(() => {
                    const player = youtubePlayerRef.current;
                    if (!player) return;
                    callbacksRef.current.onTimeUpdate?.(
                      player.getCurrentTime() || 0,
                      player.getDuration() || 0,
                      (player.getVideoLoadedFraction() || 0) * 100,
                    );
                    reportState();
                  }, 250);
                },
                onStateChange: ({ data }) => {
                  if (cancelled) return;
                  const phase = data === 0 ? "ended" : data === 1 ? "playing" : data === 2 ? "paused"
                    : data === 3 ? "buffering" : data === 5 ? "ready" : "loading";
                  if (data === 1) audioBlocked.current = false;
                  reportState({ phase });
                  reportAudio();
                  if (data === 0) { controls.current.playing = false; callbacksRef.current.onEnded?.(); }
                },
                onAutoplayBlocked: () => { if (!cancelled) { audioBlocked.current = true; reportAudio(); } },
                onError: ({ data }) => {
                  if (cancelled) return;
                  // IFrame 错误码 → 契约错误码；未知码一律 UNKNOWN，不臆断地区限制/网络故障。
                  const code = youtubeErrorCode(data);
                  reportState({ phase: "error" });
                  callbacksRef.current.onError?.({ code, message: youtubeErrorMessage(code) });
                },
              },
            });
          } catch {
            if (cancelled) return;
            youtubeFailedRef.current = true;
            reportState({ phase: "error" });
            callbacksRef.current.onError?.({
              code: "YOUTUBE_UNKNOWN_ERROR",
              message: youtubeErrorMessage("YOUTUBE_UNKNOWN_ERROR"),
            });
          }
        })
        .catch(() => {
          if (cancelled) return;
          youtubeFailedRef.current = true;
          reportState({ phase: "error" });
          callbacksRef.current.onError?.({
            code: "YOUTUBE_API_UNAVAILABLE",
            message: youtubeErrorMessage("YOUTUBE_API_UNAVAILABLE"),
          });
        });

      return () => {
        cancelled = true;
        sourceGeneration.current += 1;
        if (youtubeTimerRef.current) clearInterval(youtubeTimerRef.current);
        youtubeTimerRef.current = null;
        youtubePlayerRef.current?.destroy();
        youtubePlayerRef.current = null;
        container.replaceChildren();
      };
    }, [isYouTube, youtubeVideoId, retryVersion, reportState, reportAudio]);

    useEffect(() => {
      if (isYouTube || !effectiveStreamUrl || !videoRef.current) return;
      const video = videoRef.current;
      let cancelled = false;
      sourceGeneration.current += 1;
      retryPending.current = null;
      audioBlocked.current = false;
      reportState({ phase: "loading", audio: "unknown", presentedTime: 0, bufferedAheadSeconds: 0 });
      const isHls = sourceKind === "hls" || effectiveStreamUrl.toLowerCase().includes(".m3u8");

      if (isHls && Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
        hls.loadSource(effectiveStreamUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (cancelled || !data.fatal) return;
          reportState({ phase: "error" });
          callbacksRef.current.onError?.({
            code: `HLS_FATAL_${data.type}`,
            message: `HLS 流播放异常: ${data.details}`,
            isStreamExpired: data.response?.code === 403 || data.response?.code === 410,
          });
        });
        hlsRef.current = hls;
      } else {
        video.src = effectiveStreamUrl;
        video.load();
      }

      return () => {
        cancelled = true;
        sourceGeneration.current += 1;
        hlsRef.current?.destroy();
        hlsRef.current = null;
        video.removeAttribute("src");
        video.load();
      };
    }, [isYouTube, sourceKey, sourceKind, effectiveStreamUrl, retryVersion, reportState]);

    useEffect(() => {
      if (isYouTube || !assSubtitle || !videoRef.current) return;
      let cancelled = false;
      let renderer: JASSUB | null = null;

      const jassubModuleUrl = "/vendor/jassub/jassub.js";
      void (import(/* webpackIgnore: true */ jassubModuleUrl) as Promise<{
        default: typeof import("jassub").default;
      }>)
        .then(async ({ default: JASSUBRenderer }) => {
          if (cancelled || !videoRef.current) return;
          renderer = new JASSUBRenderer({
            video: videoRef.current,
            subContent: assSubtitle.content,
            timeOffset: -assSubtitle.offsetSeconds,
            queryFonts: "local",
            workerUrl: "/vendor/jassub/jassub-worker.js",
            wasmUrl: "/vendor/jassub/jassub-worker.wasm",
            modernWasmUrl: "/vendor/jassub/jassub-worker-modern.wasm",
            availableFonts: {
              "liberation sans": "/vendor/jassub/default.woff2",
            },
          });
          assRendererRef.current = renderer;
          await renderer.ready;
          if (cancelled) await renderer.destroy();
        })
        .catch((error: unknown) => {
          callbacksRef.current.onError?.({
            code: "ASS_RENDERER_ERROR",
            message: error instanceof Error ? error.message : "ASS 字幕引擎加载失败",
          });
        });

      return () => {
        cancelled = true;
        if (renderer) void renderer.destroy();
        if (assRendererRef.current === renderer) assRendererRef.current = null;
      };
    }, [assSubtitle, isYouTube]);

    // 原生路径 VTT/SRT 覆盖层：与 MKV 画布共用绘制器，外观/偏移即时生效（ASS 走 JASSUB 不动）。
    const subtitleCues = React.useMemo(
      () => subtitleText && subtitleFormat ? parseSubtitleCues(subtitleText, subtitleFormat) : [],
      [subtitleText, subtitleFormat],
    );
    useEffect(() => {
      if (isYouTube) return;
      const canvas = subtitleCanvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) return;
      let raf = 0;
      let lastKey: string | null = null;
      const tick = () => {
        raf = requestAnimationFrame(tick);
        if (video.videoWidth && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          lastKey = null;
        }
        const time = video.currentTime - subtitleOffsetSeconds;
        const active = subtitleCues.filter((cue) => cue.start <= time && cue.end > time);
        const key = `${active.map((cue) => cue.text).join("|")}::${JSON.stringify(subtitleStyle ?? null)}::${canvas.width}x${canvas.height}`;
        if (key === lastKey) return;
        lastKey = key;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.clearRect(0, 0, canvas.width, canvas.height);
        if (active.length === 0) return;
        paintSubtitleLines(context, active.flatMap((cue) => cue.text.split("\n")), subtitleStyle ?? DEFAULT_SUBTITLE_APPEARANCE,
          canvas.width, canvas.height,
          subtitleMarginPx(canvas.width, canvas.height, canvas.clientWidth, canvas.clientHeight));
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, [isYouTube, subtitleCues, subtitleOffsetSeconds, subtitleStyle]);

    const handleTimeUpdate = () => {
      const video = videoRef.current;
      if (!video) return;
      const duration = video.duration || 0;
      const buffered =
        video.buffered.length > 0 && duration > 0
          ? (video.buffered.end(video.buffered.length - 1) / duration) * 100
          : 0;
      callbacksRef.current.onTimeUpdate?.(video.currentTime, duration, buffered);
      reportState();
    };

    const handleVideoError = () => {
      const mediaError = videoRef.current?.error;
      if (!mediaError) return;
      reportState({ phase: "error" });
      callbacksRef.current.onError?.({
        code: `MEDIA_ERROR_${mediaError.code}`,
        message: mediaError.message || "媒体加载失败，请检查直链有效性",
        // Native media errors cannot establish HTTP status or signed URL expiry.
        isStreamExpired: false,
      });
    };

    return (
      <div className="relative flex size-full items-center justify-center overflow-hidden bg-black">
        {isYouTube ? (
          <button
            type="button"
            className="relative size-full cursor-pointer border-0 bg-black p-0"
            onClick={() => callbacksRef.current.onPlayClick?.()}
          >
            <div ref={youtubeContainerRef} className="pointer-events-none size-full" />
          </button>
        ) : (
          <>
            <video
              ref={videoRef}
              playsInline
              onPointerUp={(event) => {
                if (event.pointerType === "mouse" && event.button !== 0) return;
                callbacksRef.current.onPlayClick?.({ pointerType: event.pointerType });
              }}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={() => {
                const video = videoRef.current;
                if (!video) return;
                const state = controls.current;
                video.volume = state.volume / 100;
                video.muted = state.muted;
                video.playbackRate = state.rate;
                if (state.position) video.currentTime = state.position;
                reportState({ phase: "ready" });
                callbacksRef.current.onLoadedMetadata?.(video.duration || 0);
                if (controls.current.playing) void playLocal(); else video.pause();
              }}
              onPlaying={() => { audioBlocked.current = false; reportState({ phase: "playing" }); reportAudio(); }}
              onPause={() => { if (!videoRef.current?.ended && local.current.phase !== "error") reportState({ phase: "paused" }); reportAudio(); }}
              onWaiting={() => { if (controls.current.playing) reportState({ phase: "buffering" }); }}
              onSeeking={() => { if (controls.current.playing) reportState({ phase: "buffering" }); }}
              onSeeked={() => { reportState({ phase: videoRef.current?.paused ? "paused" : "playing" }); reportAudio(); }}
              onProgress={() => reportState()}
              onVolumeChange={reportAudio}
              onEnded={() => { controls.current.playing = false; reportState({ phase: "ended" }); reportAudio(); callbacksRef.current.onEnded?.(); }}
              onError={handleVideoError}
              className={`size-full cursor-pointer ${fitClass}`}
            />
            <canvas
              ref={subtitleCanvasRef}
              aria-hidden="true"
              className={`pointer-events-none absolute inset-0 size-full ${fitClass}`}
            />
          </>
        )}
      </div>
    );
  },
);
