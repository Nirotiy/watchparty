"use client";

import React, { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import Hls from "hls.js";
import type JASSUB from "jassub";
import type { MediaSource } from "@/lib/contracts";

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
type YouTubeNamespace = {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      playerVars: Record<string, number>;
      events: {
        onReady: (event: YouTubePlayerEvent) => void;
        onStateChange: (event: YouTubeStateEvent) => void;
        onError: () => void;
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
    const timeout = window.setTimeout(() => reject(new Error("YouTube IFrame API 加载超时")), 10_000);
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      window.clearTimeout(timeout);
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error("YouTube IFrame API 不可用"));
    };

    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("YouTube IFrame API 加载失败"));
      };
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
}

interface PlayerAdapterProps {
  source: MediaSource | null;
  streamUrl: string | null;
  subtitleVttUrl?: string | null;
  assSubtitle?: { content: string; offsetSeconds: number } | null;
  onTimeUpdate?: (currentTime: number, duration: number, bufferedPercent: number) => void;
  onLoadedMetadata?: (duration: number) => void;
  onEnded?: () => void;
  onPlayClick?: () => void;
  onError?: (error: { code: string; message: string; isStreamExpired?: boolean }) => void;
}

export const PlayerAdapter = forwardRef<PlayerAdapterHandle, PlayerAdapterProps>(
  function PlayerAdapter(props, ref) {
    const {
      source,
      streamUrl,
      subtitleVttUrl,
      assSubtitle,
      onTimeUpdate,
      onLoadedMetadata,
      onEnded,
      onPlayClick,
      onError,
    } = props;
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const hlsRef = useRef<Hls | null>(null);
    const youtubeContainerRef = useRef<HTMLDivElement | null>(null);
    const youtubePlayerRef = useRef<YouTubePlayer | null>(null);
    const youtubeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const assRendererRef = useRef<JASSUB | null>(null);
    const callbacksRef = useRef({ onTimeUpdate, onLoadedMetadata, onEnded, onPlayClick, onError });
    callbacksRef.current = { onTimeUpdate, onLoadedMetadata, onEnded, onPlayClick, onError };

    const isYouTube = source?.kind === "youtube";
    const sourceKind = source?.kind;
    const youtubeVideoId = source?.kind === "youtube" ? source.videoId : null;

    useImperativeHandle(
      ref,
      () => ({
        play: async () => {
          if (isYouTube) {
            youtubePlayerRef.current?.playVideo();
            return;
          }
          try {
            await videoRef.current?.play();
          } catch {
            // Browser autoplay policy can still require a user gesture.
          }
        },
        pause: () => {
          if (isYouTube) youtubePlayerRef.current?.pauseVideo();
          else videoRef.current?.pause();
        },
        seek: (seconds) => {
          if (isYouTube) youtubePlayerRef.current?.seekTo(seconds, true);
          else if (videoRef.current) videoRef.current.currentTime = seconds;
        },
        setPlaybackRate: (rate) => {
          if (isYouTube) youtubePlayerRef.current?.setPlaybackRate(rate);
          else if (videoRef.current) videoRef.current.playbackRate = rate;
        },
        setVolume: (volume) => {
          const normalizedVolume = Math.max(0, Math.min(100, volume));
          if (isYouTube) youtubePlayerRef.current?.setVolume(normalizedVolume);
          else if (videoRef.current) videoRef.current.volume = normalizedVolume / 100;
        },
        setMuted: (muted) => {
          if (isYouTube) {
            if (muted) youtubePlayerRef.current?.mute();
            else youtubePlayerRef.current?.unMute();
          } else if (videoRef.current) {
            videoRef.current.muted = muted;
          }
        },
        getCurrentTime: () =>
          isYouTube
            ? (youtubePlayerRef.current?.getCurrentTime() ?? 0)
            : (videoRef.current?.currentTime ?? 0),
        getDuration: () =>
          isYouTube
            ? (youtubePlayerRef.current?.getDuration() ?? 0)
            : (videoRef.current?.duration ?? 0),
      }),
      [isYouTube],
    );

    useEffect(() => {
      if (!isYouTube || !youtubeVideoId || !youtubeContainerRef.current) return;
      let cancelled = false;

      void loadYouTubeApi()
        .then((youtube) => {
          if (cancelled || !youtubeContainerRef.current) return;
          youtubePlayerRef.current = new youtube.Player(youtubeContainerRef.current, {
            videoId: youtubeVideoId,
            playerVars: {
              autoplay: 1,
              controls: 0,
              disablekb: 1,
              fs: 0,
              modestbranding: 1,
              rel: 0,
              enablejsapi: 1,
            },
            events: {
              onReady: ({ target }) => {
                callbacksRef.current.onLoadedMetadata?.(target.getDuration() || 0);
                youtubeTimerRef.current = setInterval(() => {
                  const player = youtubePlayerRef.current;
                  if (!player) return;
                  callbacksRef.current.onTimeUpdate?.(
                    player.getCurrentTime() || 0,
                    player.getDuration() || 0,
                    (player.getVideoLoadedFraction() || 0) * 100,
                  );
                }, 250);
              },
              onStateChange: ({ data }) => {
                if (data === 0) callbacksRef.current.onEnded?.();
              },
              onError: () =>
                callbacksRef.current.onError?.({
                  code: "YOUTUBE_ERROR",
                  message: "YouTube 视频无法播放或受地区限制",
                }),
            },
          });
        })
        .catch((error: unknown) => {
          callbacksRef.current.onError?.({
            code: "YOUTUBE_API_ERROR",
            message: error instanceof Error ? error.message : "YouTube IFrame API 加载失败",
          });
        });

      return () => {
        cancelled = true;
        if (youtubeTimerRef.current) clearInterval(youtubeTimerRef.current);
        youtubeTimerRef.current = null;
        youtubePlayerRef.current?.destroy();
        youtubePlayerRef.current = null;
      };
    }, [isYouTube, youtubeVideoId]);

    useEffect(() => {
      if (isYouTube || !streamUrl || !videoRef.current) return;
      const video = videoRef.current;
      const isHls = sourceKind === "hls" || streamUrl.toLowerCase().includes(".m3u8");

      if (isHls && Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          callbacksRef.current.onError?.({
            code: `HLS_FATAL_${data.type}`,
            message: `HLS 流播放异常: ${data.details}`,
            isStreamExpired: data.response?.code === 403 || data.response?.code === 410,
          });
        });
        hlsRef.current = hls;
      } else {
        video.src = streamUrl;
        video.load();
      }

      return () => {
        hlsRef.current?.destroy();
        hlsRef.current = null;
        video.removeAttribute("src");
        video.load();
      };
    }, [isYouTube, sourceKind, streamUrl]);

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

    const handleTimeUpdate = () => {
      const video = videoRef.current;
      if (!video) return;
      const duration = video.duration || 0;
      const buffered =
        video.buffered.length > 0 && duration > 0
          ? (video.buffered.end(video.buffered.length - 1) / duration) * 100
          : 0;
      callbacksRef.current.onTimeUpdate?.(video.currentTime, duration, buffered);
    };

    const handleVideoError = () => {
      const mediaError = videoRef.current?.error;
      if (!mediaError) return;
      callbacksRef.current.onError?.({
        code: `MEDIA_ERROR_${mediaError.code}`,
        message: mediaError.message || "媒体加载失败，请检查直链有效性",
        isStreamExpired: mediaError.code === MediaError.MEDIA_ERR_NETWORK,
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
          <video
            ref={videoRef}
            playsInline
            onClick={() => callbacksRef.current.onPlayClick?.()}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={() =>
              callbacksRef.current.onLoadedMetadata?.(videoRef.current?.duration || 0)
            }
            onEnded={() => callbacksRef.current.onEnded?.()}
            onError={handleVideoError}
            className="size-full cursor-pointer object-contain"
          >
            {subtitleVttUrl && (
              <track
                kind="subtitles"
                src={subtitleVttUrl}
                srcLang="zh"
                label="本地字幕"
                default
              />
            )}
          </video>
        )}
      </div>
    );
  },
);
