"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Play,
  Pause,
  Repeat,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Lock,
  Unlock,
  Users,
  Folder,
  ListVideo,
  Subtitles,
  AlertCircle,
} from "lucide-react";
import { OpenListModal } from "./openlist-modal";
import { PlaylistModal } from "./playlist-modal";
import { MembersModal } from "./members-modal";
import { PlayerAdapter, PlayerAdapterHandle } from "./player-adapter";
import {
  CommandAck,
  MediaSource,
  RoomMember,
  RoomSnapshot,
  SubtitleTrack,
} from "@/lib/contracts";
import { WatchPartySocket } from "@/lib/socket";
import { api } from "@/lib/api";
import { createVttBlobUrl } from "@/lib/subtitle-parser";

interface RoomPlayerProps {
  roomId: string;
  accessToken?: string;
}

function mediaSourceKey(source: MediaSource): string {
  if (source.kind === "openlist") return `openlist:${source.mediaId}`;
  if (source.kind === "youtube") return `youtube:${source.videoId}`;
  return `${source.kind}:${source.url}`;
}

export default function RoomPlayer({ roomId, accessToken }: RoomPlayerProps) {
  // 1. 本地客户端标识与 Token 准备
  const [clientId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    let id = localStorage.getItem("watchparty_client_id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("watchparty_client_id", id);
    }
    return id;
  });
  const [ownerToken, setOwnerToken] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(`owner_${roomId}`);
  });

  // 2. 权威快照与派生状态 (来自服务端，绝不写死)
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const snapshotRef = useRef<RoomSnapshot | null>(null);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const [members, setMembers] = useState<RoomMember[]>([]);
  const [isSocketConnected, setIsSocketConnected] = useState<boolean>(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  // 3. 真实视频播放器 Adapter 句柄与直链状态
  const playerRef = useRef<PlayerAdapterHandle | null>(null);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState<boolean>(false);
  const hasRetriedResolveRef = useRef<boolean>(false);
  const sourceKeyRef = useRef<string | null>(null);
  const resolvedMediaRef = useRef<{ mediaId: string; url: string } | null>(null);
  const resolveSequenceRef = useRef(0);

  // 4. 本地播放控制 UI 状态 (音量、全屏、字幕纯本地，不广播)
  const [volume, setVolume] = useState(85);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);
  const [bufferedPercent, setBufferedPercent] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // 5. 字幕核心状态 (本地隔离，支持 SRT 动态转 VTT)
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const [activeSubtitleId, setActiveSubtitleId] = useState<string | null>(null);
  const [rawSubtitleContent, setRawSubtitleContent] = useState<string | null>(null);
  const [subtitleOffset, setSubtitleOffset] = useState<number>(0.0);
  const [showSubtitleMenu, setShowSubtitleMenu] = useState<boolean>(false);

  const activeSubtitleTrack = subtitleTracks.find((track) => track.id === activeSubtitleId) ?? null;

  // SRT/VTT use the native text track. ASS/SSA is rendered by JASSUB in PlayerAdapter.
  const subtitleVttUrl = React.useMemo(() => {
    if (!rawSubtitleContent || !activeSubtitleTrack) return null;
    return createVttBlobUrl(rawSubtitleContent, activeSubtitleTrack.format, subtitleOffset);
  }, [activeSubtitleTrack, rawSubtitleContent, subtitleOffset]);

  useEffect(
    () => () => {
      if (subtitleVttUrl) URL.revokeObjectURL(subtitleVttUrl);
    },
    [subtitleVttUrl],
  );

  const assSubtitle = React.useMemo(() => {
    if (
      !rawSubtitleContent ||
      !activeSubtitleTrack ||
      (activeSubtitleTrack.format !== "ass" && activeSubtitleTrack.format !== "ssa")
    ) {
      return null;
    }
    return { content: rawSubtitleContent, offsetSeconds: subtitleOffset };
  }, [activeSubtitleTrack, rawSubtitleContent, subtitleOffset]);

  // 6. 房主锁与操作拦截提示
  const [lockWarning, setLockWarning] = useState<string | null>(null);
  const lockWarningTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 7. Pop-up 模态弹窗控制
  const [isOpenListModalOpen, setIsOpenListModalOpen] = useState(false);
  const [isPlaylistModalOpen, setIsPlaylistModalOpen] = useState(false);
  const [isMembersModalOpen, setIsMembersModalOpen] = useState(false);

  // 8. 实时 Socket 客户端实例引用
  const socketRef = useRef<WatchPartySocket | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 房主锁操作拦截气泡
  const triggerLockWarning = useCallback((actionText: string) => {
    setLockWarning(`房主已开启控制锁：仅房主可${actionText}`);
    if (lockWarningTimerRef.current) clearTimeout(lockWarningTimerRef.current);
    lockWarningTimerRef.current = setTimeout(() => setLockWarning(null), 2500);
  }, []);

  const clearSubtitles = useCallback(() => {
    setSubtitleTracks([]);
    setActiveSubtitleId(null);
    setRawSubtitleContent(null);
    setSubtitleOffset(0);
  }, []);

  // Resolve OpenList URLs without coupling media state to the Socket lifecycle.
  const resolveAndLoadMedia = useCallback(
    async (source: MediaSource, token: string, isRetry = false) => {
      const sourceKey = mediaSourceKey(source);
      if (sourceKeyRef.current !== sourceKey) {
        sourceKeyRef.current = sourceKey;
        resolvedMediaRef.current = null;
        hasRetriedResolveRef.current = false;
        setStreamUrl(null);
        clearSubtitles();
      }

      if (source.kind === "http" || source.kind === "hls" || source.kind === "youtube") {
        setStreamUrl(source.kind === "youtube" ? null : source.url);
        return;
      }

      if (!isRetry && resolvedMediaRef.current?.mediaId === source.mediaId) return;
      const sequence = ++resolveSequenceRef.current;
      setIsResolving(true);
      try {
        const result = await api.resolveMedia(roomId, source.mediaId, token);
        if (sequence !== resolveSequenceRef.current) return;
        if (result.requiresCustomHeaders) {
          setGlobalError("该媒体要求自定义请求头，网页端暂无法直接播放");
          return;
        }
        resolvedMediaRef.current = { mediaId: source.mediaId, url: result.url };
        setStreamUrl(result.url);
        setGlobalError(null);

        try {
          const tracks = await api.getSubtitleTracks(roomId, source.mediaId, token);
          if (sequence !== resolveSequenceRef.current) return;
          setSubtitleTracks(tracks);
          const firstTrack = tracks[0];
          if (!firstTrack) return;
          const subtitleContent = await api.getSubtitleContent(
            roomId,
            firstTrack.mediaId,
            token,
          );
          if (sequence !== resolveSequenceRef.current) return;
          setActiveSubtitleId(firstTrack.id);
          setSubtitleOffset(firstTrack.offsetSeconds ?? 0);
          setRawSubtitleContent(subtitleContent);
        } catch {
          if (sequence === resolveSequenceRef.current) clearSubtitles();
        }
      } catch (error: unknown) {
        if (sequence !== resolveSequenceRef.current) return;
        setGlobalError(
          `解析媒体直链失败: ${error instanceof Error ? error.message : "未知错误"}`,
        );
      } finally {
        if (sequence === resolveSequenceRef.current) setIsResolving(false);
      }
    },
    [clearSubtitles, roomId],
  );

  // 建立真实 Socket.io 长连接
  useEffect(() => {
    if (!clientId || !accessToken) return;

    const socket = new WatchPartySocket({
      roomId,
      clientId,
      accessToken,
      ownerToken: ownerToken || undefined,
      onConnect: () => {
        setIsSocketConnected(true);
        setGlobalError(null);
      },
      onDisconnect: () => {
        setIsSocketConnected(false);
      },
      onSnapshot: (newSnapshot) => {
        if (ownerToken && newSnapshot.ownerClientId !== clientId) {
          localStorage.removeItem(`owner_${roomId}`);
          setOwnerToken(null);
        }
        setSnapshot(newSnapshot);
        // 若当前有媒体且与当前解析源不一致，拉取并解析
        if (newSnapshot.source) {
          resolveAndLoadMedia(newSnapshot.source, accessToken);
        } else {
          sourceKeyRef.current = null;
          resolvedMediaRef.current = null;
          resolveSequenceRef.current += 1;
          hasRetriedResolveRef.current = false;
          setStreamUrl(null);
          clearSubtitles();
        }
      },
      onMembers: (newMembers) => {
        setMembers(
          newMembers.map((m) => ({
            ...m,
            isSelf: m.clientId === clientId,
          }))
        );
      },
      onOwnerToken: (newOwnerToken) => {
        setOwnerToken(newOwnerToken);
        localStorage.setItem(`owner_${roomId}`, newOwnerToken);
      },
      onError: (err) => {
        setGlobalError(err.message);
      },
    });

    socketRef.current = socket;
    socket.connect();

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId, clientId, accessToken, ownerToken, resolveAndLoadMedia, clearSubtitles]);

  // 权威时钟 NTP 追帧同步逻辑
  useEffect(() => {
    if (!snapshot || !playerRef.current || isResolving) return;
    const player = playerRef.current;

    // 播放/暂停状态对齐
    if (snapshot.paused) {
      player.pause();
    } else {
      player.play().catch(() => {});
    }

    // 倍速对齐
    player.setPlaybackRate(snapshot.playbackRate);

    // 计算权威理论播放时间
    const clockOffset = socketRef.current?.getClockOffset() || 0;
    const nowMs = Date.now();
    const elapsedSeconds = snapshot.paused
      ? 0
      : ((nowMs + clockOffset - snapshot.serverTimeMs) / 1000) * snapshot.playbackRate;
    const expectedTime = Math.max(0, snapshot.positionSeconds + elapsedSeconds);
    const deltaSeconds = player.getCurrentTime() - expectedTime;

    // 三段式追帧：<0.25s 不动；0.25s~1s 微调倍速；>1s seek
    if (Math.abs(deltaSeconds) > 1.0) {
      player.seek(expectedTime);
    } else if (Math.abs(deltaSeconds) > 0.25 && !snapshot.paused) {
      player.setPlaybackRate(deltaSeconds > 0 ? snapshot.playbackRate * 0.95 : snapshot.playbackRate * 1.05);
    }
  }, [snapshot, isResolving]);

  // 权限与房主判定
  const isOwner = snapshot?.ownerClientId === clientId;
  const isLocked = snapshot?.locked ?? false;
  const canControl = !isLocked || isOwner;

  const waitForNewerRevision = useCallback(async (revision: number): Promise<number | null> => {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const currentRevision = snapshotRef.current?.revision;
      if (currentRevision !== undefined && currentRevision > revision) return currentRevision;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  }, []);

  const runCommand = useCallback(
    async (
      command: (socket: WatchPartySocket, revision: number) => Promise<CommandAck>,
    ): Promise<CommandAck> => {
      const socket = socketRef.current;
      const initialRevision = snapshotRef.current?.revision;
      if (!socket || initialRevision === undefined) {
        const unavailable: CommandAck = {
          ok: false,
          error: { code: "NOT_CONNECTED", message: "房间连接尚未就绪" },
        };
        setGlobalError(unavailable.error.message);
        return unavailable;
      }

      let revision = initialRevision;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const acknowledgement = await command(socket, revision);
        if (acknowledgement.ok) {
          setGlobalError(null);
          return acknowledgement;
        }
        if (acknowledgement.error.code !== "REVISION_CONFLICT" || attempt === 1) {
          setGlobalError(acknowledgement.error.message);
          return acknowledgement;
        }
        const newerRevision = await waitForNewerRevision(revision);
        if (newerRevision === null) {
          const timeout: CommandAck = {
            ok: false,
            error: { code: "REVISION_SYNC_TIMEOUT", message: "未收到最新房间状态，请重试" },
          };
          setGlobalError(timeout.error.message);
          return timeout;
        }
        revision = newerRevision;
      }

      return { ok: false, error: { code: "COMMAND_FAILED", message: "指令执行失败" } };
    },
    [waitForNewerRevision],
  );

  const selectSubtitleTrack = useCallback(
    async (track: SubtitleTrack) => {
      if (!accessToken) return;
      try {
        const content = await api.getSubtitleContent(roomId, track.mediaId, accessToken);
        setActiveSubtitleId(track.id);
        setSubtitleOffset(track.offsetSeconds ?? 0);
        setRawSubtitleContent(content);
        setGlobalError(null);
      } catch (error: unknown) {
        setGlobalError(error instanceof Error ? error.message : "字幕加载失败");
      }
    },
    [accessToken, roomId],
  );

  // 播放器流过期 / 403 异常拦截：单次自动重新解析
  const handlePlayerError = (err: { code: string; message: string; isStreamExpired?: boolean }) => {
    if (
      err.isStreamExpired &&
      snapshot?.source?.kind === "openlist" &&
      accessToken &&
      !hasRetriedResolveRef.current
    ) {
      hasRetriedResolveRef.current = true;
      resolveAndLoadMedia(snapshot.source, accessToken, true);
    } else {
      setGlobalError(err.message);
    }
  };

  // 交互控制 (全部发送至服务端等待 Ack 回执)
  const handleTogglePlay = async () => {
    if (!snapshot || !socketRef.current) return;
    if (!canControl) {
      triggerLockWarning("暂停/播放");
      return;
    }
    if (snapshot.paused) {
      await runCommand((socket, revision) => socket.play(revision));
    } else {
      await runCommand((socket, revision) => socket.pause(revision));
    }
  };

  const handleSeek = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!snapshot || !socketRef.current || totalDuration === 0) return;
    if (!canControl) {
      triggerLockWarning("调整播放进度");
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetSecs = ratio * totalDuration;
    await runCommand((socket, revision) => socket.seek(targetSecs, revision));
  };

  const handleToggleLock = async () => {
    if (!snapshot || !socketRef.current || !isOwner) {
      triggerLockWarning("修改房主控制锁");
      return;
    }
    await runCommand((socket, revision) => socket.lock(!snapshot.locked, revision));
  };

  const handleRateChange = async () => {
    if (!snapshot || !socketRef.current) return;
    if (!canControl) {
      triggerLockWarning("调整倍速");
      return;
    }
    const nextRate =
      snapshot.playbackRate === 1 ? 1.25 : snapshot.playbackRate === 1.25 ? 1.5 : snapshot.playbackRate === 1.5 ? 2.0 : 1.0;
    await runCommand((socket, revision) => socket.rate(nextRate, revision));
  };

  const handleToggleLoop = async () => {
    if (!snapshot || !socketRef.current) return;
    if (!canControl) {
      triggerLockWarning("切换循环");
      return;
    }
    await runCommand((socket, revision) => socket.loop(!snapshot.loop, revision));
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const progressPercent = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;
  const currentMediaTitle =
    snapshot?.source && "title" in snapshot.source && snapshot.source.title
      ? snapshot.source.title
      : "暂未载入媒体";

  return (
    <div
      ref={containerRef}
      className="relative flex h-screen w-screen flex-col overflow-hidden bg-black font-sans text-white select-none"
    >
      {/* ================= 1. 顶部精密导航栏 (保留发丝线与设计体系) ================= */}
      <div className="z-30 flex h-12 shrink-0 items-center justify-between border-b border-white/10 bg-black/85 px-4 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-white tracking-tight">WatchParty</span>
          <span className="font-mono text-xs text-neutral-400">/{roomId}</span>
          <div className="flex items-center gap-1.5 rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 font-mono text-[11px] text-neutral-300">
            <div
              className={`size-1.5 rounded-full ${
                isSocketConnected ? "bg-emerald-400" : "bg-rose-500"
              }`}
            ></div>
            <span>{isSocketConnected ? "已连接" : "重连中..."}</span>
          </div>
        </div>

        {/* 右侧动作入口 */}
        <div className="flex items-center gap-2">
          {/* 房主锁 */}
          <button
            onClick={handleToggleLock}
            className={`flex items-center gap-1 rounded border px-2.5 py-1 font-mono text-xs transition ${
              isLocked
                ? "border-sky-500/40 bg-sky-950/30 text-sky-400 hover:bg-sky-900/40"
                : "border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-white"
            }`}
          >
            {isLocked ? <Lock className="size-3.5 text-sky-400" /> : <Unlock className="size-3.5" />}
            <span>{isLocked ? "房主锁开启" : "自由控制"}</span>
          </button>

          {/* 媒体库点播 */}
          <button
            onClick={() => setIsOpenListModalOpen(true)}
            className="flex items-center gap-1.5 rounded border border-neutral-800 bg-neutral-900 px-3 py-1 text-xs text-neutral-200 transition hover:border-sky-500 hover:text-white"
          >
            <Folder className="size-3.5 text-sky-400" />
            <span>点播媒体库</span>
          </button>

          {/* 播放清单 */}
          <button
            onClick={() => setIsPlaylistModalOpen(true)}
            className="flex items-center gap-1.5 rounded border border-neutral-800 bg-neutral-900 px-3 py-1 text-xs text-neutral-200 transition hover:border-sky-500 hover:text-white"
          >
            <ListVideo className="size-3.5 text-neutral-400" />
            <span>播放清单 ({snapshot?.playlist.length || 0})</span>
          </button>

          {/* 在线成员 */}
          <button
            onClick={() => setIsMembersModalOpen(true)}
            className="flex items-center gap-1.5 rounded border border-neutral-800 bg-neutral-900 px-3 py-1 text-xs text-neutral-200 transition hover:border-sky-500 hover:text-white"
          >
            <Users className="size-3.5 text-emerald-400" />
            <span>在线 ({members.length})</span>
          </button>
        </div>
      </div>

      {/* ================= 2. 真实视频播放区域 (Video Stage) ================= */}
      <div className="relative flex flex-1 items-center justify-center bg-black">
        {/* 片名标签浮层 */}
        <div className="absolute left-4 top-4 z-20 flex items-center gap-2 rounded border border-white/10 bg-black/70 px-3 py-1.5 backdrop-blur-sm">
          <span className="font-medium text-xs text-white">{currentMediaTitle}</span>
          {snapshot?.source && (
            <span className="rounded bg-sky-500/20 px-1 font-mono text-[10px] text-sky-400">
              {snapshot.source.kind.toUpperCase()}
            </span>
          )}
        </div>

        {/* 房主锁警告拦截提示 */}
        {lockWarning && (
          <div className="absolute top-16 z-40 rounded border border-amber-500/40 bg-amber-950/90 px-4 py-2 text-xs font-semibold text-amber-300 shadow-xl backdrop-blur-sm">
            🔒 {lockWarning}
          </div>
        )}

        {/* 全局异常提示 */}
        {globalError && (
          <div className="absolute top-16 z-40 flex items-center gap-2 rounded border border-rose-900/60 bg-rose-950/90 px-4 py-2 text-xs text-rose-300 shadow-xl backdrop-blur-sm">
            <AlertCircle className="size-4 shrink-0" />
            <span>{globalError}</span>
          </div>
        )}

        {/* 真实多内核 PlayerAdapter 渲染 */}
        {snapshot?.source ? (
          <PlayerAdapter
            ref={playerRef}
            source={snapshot.source}
            streamUrl={streamUrl}
            subtitleVttUrl={subtitleVttUrl}
            assSubtitle={assSubtitle}
            onTimeUpdate={(c, d, b) => {
              setCurrentTime(c);
              setTotalDuration(d);
              setBufferedPercent(b);
            }}
            onLoadedMetadata={(d) => setTotalDuration(d)}
            onEnded={() => {
              // 自动切播下一首
              if (snapshot && socketRef.current && canControl) {
                void runCommand((socket, revision) => socket.playlistNext(revision));
              }
            }}
            onPlayClick={handleTogglePlay}
            onError={handlePlayerError}
          />
        ) : (
          <div
            onClick={() => setIsOpenListModalOpen(true)}
            className="flex size-full cursor-pointer flex-col items-center justify-center bg-radial from-neutral-900 to-black text-neutral-600 hover:text-neutral-400"
          >
            <div className="flex size-16 items-center justify-center rounded-full border border-neutral-800 bg-neutral-950/80 mb-3">
              <Play className="size-7 fill-current ml-1" />
            </div>
            <span className="text-xs">房间当前无播放媒体，点击此处打开媒体库点播</span>
          </div>
        )}
      </div>

      {/* ================= 3. 底部 mpv 控制岛 (100% 保持既有视觉设计) ================= */}
      <div className="z-30 flex shrink-0 flex-col gap-2 bg-gradient-to-t from-black via-black/95 to-transparent px-4 pb-4 pt-2">
        {/* 进度条 */}
        <div
          onClick={handleSeek}
          className="group relative h-2 w-full cursor-pointer rounded bg-white/20"
        >
          <div
            className="absolute left-0 top-0 h-full rounded bg-white/30"
            style={{ width: `${bufferedPercent}%` }}
          ></div>
          <div
            className="absolute left-0 top-0 h-full rounded bg-white"
            style={{ width: `${progressPercent}%` }}
          ></div>
          <div
            className="absolute -top-1 size-4 -translate-x-1/2 rounded-full border-2 border-white bg-sky-400 opacity-90 transition-transform group-hover:scale-125"
            style={{ left: `${progressPercent}%` }}
          ></div>
        </div>

        {/* 控制按钮与时间块 */}
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-3">
            <button
              onClick={handleTogglePlay}
              className="flex size-7 items-center justify-center rounded text-white hover:bg-neutral-800"
            >
              {snapshot?.paused ? <Play className="size-4 fill-white" /> : <Pause className="size-4" />}
            </button>

            {/* 深青高对比时间块 */}
            <div className="flex items-center gap-1.5 font-mono">
              <span className="rounded bg-[#113349] px-1.5 py-0.5 font-bold text-white">
                {formatTime(currentTime)}
              </span>
              <span className="text-neutral-500">/</span>
              <span className="text-neutral-400">{formatTime(totalDuration)}</span>
            </div>

            {/* 音量控制 */}
            <div className="flex items-center gap-1 text-neutral-400">
              <button
                onClick={() => {
                  const nextMuted = !isMuted;
                  setIsMuted(nextMuted);
                  playerRef.current?.setMuted(nextMuted);
                }}
                className="hover:text-white"
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="size-4 text-rose-400" />
                ) : (
                  <Volume2 className="size-4" />
                )}
              </button>
              <input
                type="range"
                min="0"
                max="100"
                value={isMuted ? 0 : volume}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setVolume(v);
                  playerRef.current?.setVolume(v);
                  playerRef.current?.setMuted(false);
                  setIsMuted(false);
                }}
                className="h-1 w-16 accent-white"
              />
            </div>

            {/* 字幕菜单与轨选择 */}
            <div className="relative flex items-center gap-1">
              <button
                onClick={() => setShowSubtitleMenu(!showSubtitleMenu)}
                className="flex items-center gap-1 rounded border border-neutral-800 bg-black px-2 py-0.5 font-mono text-[11px] text-sky-400 hover:border-sky-500"
              >
                <Subtitles className="size-3" />
                <span>
                  字幕 ({subtitleOffset >= 0 ? `+${subtitleOffset.toFixed(1)}s` : `${subtitleOffset.toFixed(1)}s`})
                </span>
              </button>

              {showSubtitleMenu && (
                <div className="absolute bottom-8 left-0 z-50 w-56 rounded border border-neutral-800 bg-neutral-950 p-3 shadow-2xl space-y-3">
                  <div className="flex items-center justify-between border-b border-neutral-800 pb-1.5">
                    <span className="text-[11px] font-semibold text-neutral-300">本地字幕控制</span>
                    <button
                      onClick={() => setShowSubtitleMenu(false)}
                      className="text-neutral-500 hover:text-white"
                    >
                      ✕
                    </button>
                  </div>

                  {/* 字幕轨选择 */}
                  {subtitleTracks.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[10px] text-neutral-500">选择字幕轨</div>
                      <div className="space-y-1">
                        {subtitleTracks.map((tr) => (
                          <button
                            key={tr.id}
                            onClick={() => void selectSubtitleTrack(tr)}
                            className={`flex w-full items-center justify-between rounded px-2 py-1 text-xs transition ${
                              activeSubtitleId === tr.id
                                ? "bg-sky-500/20 text-sky-400"
                                : "text-neutral-400 hover:bg-neutral-900"
                            }`}
                          >
                            <span className="truncate">{tr.label}</span>
                            <span className="font-mono text-[9px] uppercase">{tr.format}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 毫秒级时间轴微调 */}
                  <div className="space-y-1">
                    <div className="text-[10px] text-neutral-500">时间轴对齐 (仅本机生效)</div>
                    <div className="flex items-center justify-between text-xs font-mono">
                      <button
                        onClick={() => setSubtitleOffset((prev) => +(prev - 0.1).toFixed(1))}
                        className="rounded border border-neutral-800 px-2 py-0.5 hover:bg-neutral-800"
                      >
                        -0.1s
                      </button>
                      <span className="text-sky-400 font-bold">{subtitleOffset.toFixed(1)}s</span>
                      <button
                        onClick={() => setSubtitleOffset((prev) => +(prev + 0.1).toFixed(1))}
                        className="rounded border border-neutral-800 px-2 py-0.5 hover:bg-neutral-800"
                      >
                        +0.1s
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 右侧：倍速 + 循环 + 全屏 */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleRateChange}
              className="rounded border border-neutral-800 bg-black px-2 py-0.5 font-mono text-xs text-neutral-300 hover:border-neutral-700"
            >
              {(snapshot?.playbackRate || 1).toFixed(2)}x
            </button>
            <button
              onClick={handleToggleLoop}
              className={`hover:text-white ${snapshot?.loop ? "text-sky-400" : "text-neutral-500"}`}
            >
              <Repeat className="size-4" />
            </button>
            <button onClick={toggleFullscreen} className="text-neutral-400 hover:text-white">
              {isFullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
            </button>
          </div>
        </div>
      </div>

      {/* ================= 4. 挂载三大 Pop-up 弹窗 ================= */}
      <OpenListModal
        isOpen={isOpenListModalOpen}
        onClose={() => setIsOpenListModalOpen(false)}
        onPlayNow={async (media) => {
          if (!snapshot || !socketRef.current) return;
          if (!canControl) {
            triggerLockWarning("切换播放媒体");
            return;
          }
          await runCommand((socket, revision) => socket.mediaSet(media, revision));
        }}
        onAddToQueue={async (media) => {
          if (!snapshot || !socketRef.current) return;
          if (!canControl) {
            triggerLockWarning("修改播放清单");
            return;
          }
          await runCommand((socket, revision) => socket.playlistAdd(media, revision));
        }}
        onBatchAdd={async (medias) => {
          if (!snapshotRef.current || !socketRef.current) return;
          if (!canControl) {
            triggerLockWarning("修改播放清单");
            return;
          }
          let revision = snapshotRef.current.revision;
          for (const media of medias) {
            let acknowledgement = await socketRef.current.playlistAdd(media, revision);
            if (!acknowledgement.ok && acknowledgement.error.code === "REVISION_CONFLICT") {
              const newerRevision = await waitForNewerRevision(revision);
              if (newerRevision !== null) {
                revision = newerRevision;
                acknowledgement = await socketRef.current.playlistAdd(media, revision);
              }
            }
            if (!acknowledgement.ok) {
              setGlobalError(acknowledgement.error.message);
              break;
            }
            revision = acknowledgement.revision;
          }
        }}
      />

      <PlaylistModal
        isOpen={isPlaylistModalOpen}
        onClose={() => setIsPlaylistModalOpen(false)}
        playlist={snapshot?.playlist || []}
        currentPlaylistItemId={snapshot?.currentPlaylistItemId}
        onPlayItem={async (itemId) => {
          if (!snapshot || !socketRef.current) return;
          if (!canControl) {
            triggerLockWarning("切换播放条目");
            return;
          }
          await runCommand((socket, revision) => socket.playlistPlay(itemId, revision));
        }}
        onRemoveItem={async (itemId) => {
          if (!snapshot || !socketRef.current) return;
          if (!canControl) {
            triggerLockWarning("移除播放条目");
            return;
          }
          await runCommand((socket, revision) => socket.playlistRemove(itemId, revision));
        }}
        onMoveItem={async (itemId, targetIndex) => {
          if (!snapshot || !socketRef.current) return;
          if (!canControl) {
            triggerLockWarning("调整播放列表顺序");
            return;
          }
          await runCommand((socket, revision) =>
            socket.playlistMove(itemId, targetIndex, revision),
          );
        }}
        onOpenMediaSelector={() => setIsOpenListModalOpen(true)}
        isLocked={isLocked}
        isOwner={isOwner}
      />

      <MembersModal
        isOpen={isMembersModalOpen}
        onClose={() => setIsMembersModalOpen(false)}
        members={members}
        isOwner={isOwner}
        onTransferOwnership={async (targetClientId) => {
          if (!snapshot || !socketRef.current || !isOwner) return;
          await runCommand((socket, revision) =>
            socket.transferOwner(targetClientId, revision),
          );
        }}
      />
    </div>
  );
}
