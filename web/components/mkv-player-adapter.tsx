"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type JASSUB from "jassub";
import type { MkvPlayer, EmbeddedSubtitle } from "@/lib/mkv/player";
import type { PlayerAdapterHandle, PlayerAdapterProps } from "./player-adapter";
import { matchPreferredAudio } from "@/lib/player-preferences";

export const MkvPlayerAdapter = forwardRef<PlayerAdapterHandle, PlayerAdapterProps>(function MkvPlayerAdapter(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const subtitleHostRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLTrackElement>(null);
  const playerRef = useRef<MkvPlayer | null>(null);
  const rendererRef = useRef<JASSUB | null>(null);
  const renderPendingRef = useRef(false);
  const subtitlePackets = useRef<Array<{ text: string; start: number; duration: number }>>([]);
  const [embeddedSource, setEmbeddedSource] = useState<{ url: string; subtitle: EmbeddedSubtitle } | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const controls = useRef({ playing: false, position: 0, rate: 1, volume: 85, muted: false });
  const selectedTracks = useRef<{ audioId?: number; subtitleId?: number | null }>({});
  const callbacks = useRef(props);
  callbacks.current = props;
  const { streamUrl, refreshStreamUrl, subtitleVttUrl, assSubtitle, subtitleOffsetSeconds = 0 } = props;
  const embedded = embeddedSource?.url === streamUrl ? embeddedSource.subtitle : null;

  useImperativeHandle(ref, () => ({
    play: async () => { controls.current.playing = true; await playerRef.current?.play(); },
    pause: () => { controls.current.playing = false; playerRef.current?.pause(); },
    seek: (seconds) => { controls.current.position = seconds; playerRef.current?.seek(seconds); },
    setPlaybackRate: (rate) => { controls.current.rate = rate; playerRef.current?.setPlaybackRate(rate); },
    setVolume: (volume) => { controls.current.volume = volume; playerRef.current?.setVolume(volume); },
    setMuted: (muted) => { controls.current.muted = muted; playerRef.current?.setMuted(muted); },
    getCurrentTime: () => playerRef.current?.currentTime ?? controls.current.position,
    getDuration: () => playerRef.current?.duration ?? 0,
    unlockAudio: async () => { await playerRef.current?.unlockAudio(); },
    retry: () => { controls.current.position = playerRef.current?.currentTime ?? controls.current.position; setRetryVersion((value) => value + 1); },
    selectAudioTrack: async (id) => {
      if (!playerRef.current) return;
      await playerRef.current.selectAudioTrack(id);
      selectedTracks.current.audioId = id;
    },
    selectSubtitleTrack: (id) => {
      if (!playerRef.current) return;
      playerRef.current.selectSubtitleTrack(id);
      selectedTracks.current.subtitleId = id;
    },
    getEmbeddedTracks: () => playerRef.current?.embeddedTracks ?? { items: [], audioId: null, subtitleId: null },
  }), []);

  useEffect(() => {
    callbacks.current.onCapabilities?.({ engine: "mkv", embeddedTracks: true, audioUnlock: true, retry: true, bufferedAhead: true });
  }, []);

  // 字幕外观即时生效：偏好变化直接推给引擎（draw() 下一帧读取）；引擎懒创建后由 options 初值兜底。
  useEffect(() => {
    if (props.subtitleStyle) playerRef.current?.setSubtitleStyle(props.subtitleStyle);
  }, [props.subtitleStyle]);

  useEffect(() => {
    if (!streamUrl || !canvasRef.current) return;
    let cancelled = false;
    let player: MkvPlayer | null = null;
    const canvas = canvasRef.current;
    void import("@/lib/mkv/player").then(({ MkvPlayer }) => {
      if (cancelled) return;
      player = new MkvPlayer({
        canvas,
        subtitleStyle: callbacks.current.subtitleStyle,
        refreshUrl: refreshStreamUrl,
        onReady: (duration) => {
          if (cancelled) return;
          if (player) {
            const tracks = player.embeddedTracks;
            // 音轨自动选择在适配器内完成；字幕选择统一由 room-player 的决策函数驱动（需要跨外挂/内嵌候选）。
            const preferredAudioId = callbacks.current.preferredAudioLanguages
              ? matchPreferredAudio(tracks, callbacks.current.preferredAudioLanguages) : tracks.audioId;
            const selected = selectedTracks.current;
            const audioId = selected.audioId ?? preferredAudioId;
            const subtitleId = selected.subtitleId === undefined ? tracks.subtitleId : selected.subtitleId;
            if (audioId !== null && audioId !== tracks.audioId) {
              void player.selectAudioTrack(audioId).catch(() => {
                if (!cancelled) callbacks.current.onError?.({ code: "AUDIO_TRACK_RESTORE_ERROR", message: "Audio track could not be restored" });
              });
            }
            if (subtitleId !== tracks.subtitleId) {
              try { player.selectSubtitleTrack(subtitleId); }
              catch {
                callbacks.current.onError?.({ code: "SUBTITLE_TRACK_RESTORE_ERROR", message: "Subtitle track could not be restored" });
              }
            }
          }
          player?.setExternalSubtitle(Boolean(callbacks.current.assSubtitle || callbacks.current.subtitleVttUrl), trackRef.current?.track);
          player?.setSubtitleOffset(callbacks.current.subtitleOffsetSeconds ?? 0);
          callbacks.current.onLoadedMetadata?.(duration);
        },
        onTimeUpdate: (...args) => { if (!cancelled) callbacks.current.onTimeUpdate?.(...args); },
        onEnded: () => { if (!cancelled) callbacks.current.onEnded?.(); },
        onError: (message, unsupported) => {
          if (!cancelled) callbacks.current.onError?.({ code: unsupported ? "MKV_UNSUPPORTED" : "MKV_ERROR", message });
        },
        onSubtitle: (subtitle) => { if (!cancelled) setEmbeddedSource(subtitle ? { url: streamUrl, subtitle } : null); },
        onTracks: (tracks) => { if (!cancelled) callbacks.current.onEmbeddedTracks?.(tracks); },
        onLocalState: (state) => {
          if (cancelled) return;
          canvas.dataset.playerPhase = state.phase;
          canvas.dataset.audioState = state.audio;
          callbacks.current.onLocalState?.(state);
        },
        onSubtitleReset: () => {
          subtitlePackets.current = [];
          if (rendererRef.current && !callbacks.current.assSubtitle) {
            void rendererRef.current.renderer.freeTrack().catch(() => {});
            if (embeddedHeader.current) void rendererRef.current.renderer.setTrack(embeddedHeader.current).catch(() => {});
          }
        },
        onSubtitlePacket: (text, start, duration) => {
          if (callbacks.current.assSubtitle || callbacks.current.subtitleVttUrl) return;
          const renderer = rendererRef.current;
          if (renderer) {
            void renderer.renderer.processChunk(text, start * 1000, duration * 1000).then(async () => {
              if (cancelled || rendererRef.current !== renderer || canvas.dataset.playerPhase !== "paused") return;
              await renderer.manualRender({ expectedDisplayTime: performance.now(), width: canvas.width,
                height: canvas.height, mediaTime: Number(canvas.dataset.mediaTime ?? 0) }, true);
            }).catch(() => {});
          }
          else {
            subtitlePackets.current.push({ text, start, duration });
            if (subtitlePackets.current.length > 200) subtitlePackets.current.shift();
          }
        },
        onFrame: (mediaTime) => {
          const renderer = rendererRef.current;
          if (!renderer || renderPendingRef.current) return;
          renderPendingRef.current = true;
          void renderer.manualRender({ expectedDisplayTime: performance.now(), width: canvas.width,
            height: canvas.height, mediaTime }).catch(() => {}).finally(() => { renderPendingRef.current = false; });
        },
      });
      playerRef.current = player;
      const state = controls.current;
      player.seek(state.position);
      player.setPlaybackRate(state.rate);
      player.setVolume(state.volume);
      player.setMuted(state.muted);
      if (state.playing) void player.play();
      void player.load(streamUrl);
    }).catch(() => {
      if (!cancelled) callbacks.current.onError?.({ code: "MKV_LOAD_ERROR", message: "MKV 引擎加载失败" });
    });
    return () => { cancelled = true; player?.dispose(); if (playerRef.current === player) playerRef.current = null; };
  }, [streamUrl, refreshStreamUrl, retryVersion]);

  const embeddedHeader = useRef("");
  embeddedHeader.current = embedded?.header ?? "";

  useEffect(() => {
    const player = playerRef.current;
    player?.setSubtitleOffset(subtitleOffsetSeconds);
    player?.setExternalSubtitle(Boolean(assSubtitle || subtitleVttUrl), subtitleVttUrl ? trackRef.current?.track : null);
    if (trackRef.current) trackRef.current.track.mode = "hidden";
    const content = assSubtitle?.content ?? (subtitleVttUrl ? null : embedded?.header);
    const host = subtitleHostRef.current;
    if (!content || !host || !canvasRef.current) return;
    let cancelled = false;
    let renderer: JASSUB | null = null;
    let destroyed = false;
    const destroy = () => {
      if (!renderer || destroyed) return;
      destroyed = true;
      void renderer.destroy().catch(() => {});
    };
    const subtitleCanvas = document.createElement("canvas");
    subtitleCanvas.className = `pointer-events-none absolute inset-0 size-full ${callbacks.current.pictureFit === "cover" ? "object-cover" : "object-contain"}`;
    subtitleCanvas.width = canvasRef.current.width;
    subtitleCanvas.height = canvasRef.current.height;
    host.append(subtitleCanvas);
    const moduleUrl = "/vendor/jassub/jassub.js";
    void (import(/* webpackIgnore: true */ moduleUrl) as Promise<{ default: typeof JASSUB }>).then(async ({ default: Renderer }) => {
      if (cancelled) return;
      renderer = new Renderer({
        canvas: subtitleCanvas, subContent: content,
        timeOffset: -(assSubtitle?.offsetSeconds ?? subtitleOffsetSeconds),
        fonts: ["/vendor/jassub/default.woff2", ...(embedded?.fonts ?? [])], queryFonts: false,
        workerUrl: "/vendor/jassub/jassub-worker.js",
        wasmUrl: "/vendor/jassub/jassub-worker.wasm",
        modernWasmUrl: "/vendor/jassub/jassub-worker-modern.wasm",
        availableFonts: { "liberation sans": "/vendor/jassub/default.woff2" },
      });
      await renderer.ready;
      if (cancelled) return;
      rendererRef.current = renderer;
      if (!assSubtitle) {
        for (const packet of subtitlePackets.current.splice(0)) {
          if (cancelled) return;
          await renderer.renderer.processChunk(packet.text, packet.start * 1000, packet.duration * 1000);
        }
      }
      if (cancelled || !canvasRef.current) return;
      const canvas = canvasRef.current;
      await renderer.manualRender({ expectedDisplayTime: performance.now(), width: canvas.width,
        height: canvas.height, mediaTime: Number(canvas.dataset.mediaTime ?? 0) }, true);
    }).catch(() => {
      if (!cancelled) callbacks.current.onError?.({ code: "ASS_RENDERER_ERROR", message: "ASS 字幕引擎加载失败" });
    }).finally(() => { if (cancelled) destroy(); });
    return () => {
      cancelled = true;
      if (rendererRef.current === renderer) rendererRef.current = null;
      destroy();
      subtitleCanvas.remove();
    };
  }, [embedded, assSubtitle, subtitleVttUrl, streamUrl, subtitleOffsetSeconds]);

  // 画面缩放即时生效：主画布走 JSX 类名；JASSUB 覆盖画布是命令式创建，需要同步切换。
  useEffect(() => {
    const overlay = subtitleHostRef.current?.querySelector("canvas");
    if (overlay) overlay.className = `pointer-events-none absolute inset-0 size-full ${props.pictureFit === "cover" ? "object-cover" : "object-contain"}`;
  }, [props.pictureFit, embedded, assSubtitle, subtitleVttUrl]);

  return (
    <div className="relative flex size-full items-center justify-center overflow-hidden bg-black">
      <canvas ref={canvasRef} className={`size-full cursor-pointer ${props.pictureFit === "cover" ? "object-cover" : "object-contain"}`} aria-label="MKV 视频"
        onPointerUp={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          void playerRef.current?.unlockAudio().catch(() => {});
          callbacks.current.onPlayClick?.({ pointerType: event.pointerType });
        }} />
      <div ref={subtitleHostRef} className="pointer-events-none absolute inset-0" />
      {subtitleVttUrl && <video className="hidden" aria-hidden="true"><track ref={trackRef} src={subtitleVttUrl} kind="subtitles"
        onLoad={() => {
          if (trackRef.current) { trackRef.current.track.mode = "hidden"; playerRef.current?.setExternalSubtitle(true, trackRef.current.track); }
        }} /></video>}
    </div>
  );
});
