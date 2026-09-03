"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { OpenListModal } from "./openlist-modal";
import { PlaylistModal } from "./playlist-modal";
import { MembersModal } from "./members-modal";
import { MpvLaunchModal } from "./mpv-launch-modal";
import { PlayerAdapter, PlayerAdapterHandle } from "./player-adapter";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
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

const CONTROLS_HIDE_DELAY_MS = 2400;

/** Material Symbols 图标；sizePx 控制字号，filled 启用填充变体。 */
function MsIcon({ name, className, filled }: { name: string; className?: string; filled?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("material-symbols-outlined select-none leading-none", filled && "[font-variation-settings:'FILL'_1]", className)}
    >
      {name}
    </span>
  );
}

/** 图标按钮 + Tooltip 的统一封装（呼出层内所有 icon-only 控件都用它）。 */
function IconControl({
  icon,
  label,
  onClick,
  active,
  filled,
  badge,
  className,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  active?: boolean;
  filled?: boolean;
  badge?: number | string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          aria-label={label}
          aria-pressed={active}
          className={cn(
            "relative text-white/85 hover:bg-white/15 hover:text-white",
            active && "text-sky-400 hover:text-sky-300",
            className,
          )}
        >
          <MsIcon name={icon} filled={filled ?? active} className="text-[20px]" />
          {badge !== undefined && badge !== 0 && (
            <span className="pointer-events-none absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-sky-600 px-1 text-center text-[9px] leading-4 font-medium text-white">
              {badge}
            </span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="bg-neutral-900 text-neutral-100 border border-neutral-700">{label}</TooltipContent>
    </Tooltip>
  );
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
  const [areControlsVisible, setAreControlsVisible] = useState(true);
  const [seekPreview, setSeekPreview] = useState<number | null>(null);

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
  const [isMpvModalOpen, setIsMpvModalOpen] = useState(false);

  // 8. 实时 Socket 客户端实例引用
  const socketRef = useRef<WatchPartySocket | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const controlsHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shouldPinControls =
    !snapshot?.source ||
    snapshot.paused !== false ||
    showSubtitleMenu ||
    isOpenListModalOpen ||
    isPlaylistModalOpen ||
    isMembersModalOpen;

  const clearControlsHideTimer = useCallback(() => {
    if (!controlsHideTimerRef.current) return;
    clearTimeout(controlsHideTimerRef.current);
    controlsHideTimerRef.current = null;
  }, []);

  const scheduleControlsHide = useCallback(() => {
    clearControlsHideTimer();
    if (shouldPinControls) return;
    controlsHideTimerRef.current = setTimeout(() => {
      controlsHideTimerRef.current = null;
      if (controlsRef.current?.contains(document.activeElement)) return;
      setAreControlsVisible(false);
    }, CONTROLS_HIDE_DELAY_MS);
  }, [clearControlsHideTimer, shouldPinControls]);

  const revealControls = useCallback(() => {
    setAreControlsVisible(true);
    scheduleControlsHide();
  }, [scheduleControlsHide]);

  // 顶部与底部呼出层共用的指针/焦点处理：停留时保持显示，移开后计时收起。
  const overlayPointerHandlers = {
    onPointerEnter: () => {
      clearControlsHideTimer();
      setAreControlsVisible(true);
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      clearControlsHideTimer();
      setAreControlsVisible(true);
    },
    onPointerLeave: () => {
      scheduleControlsHide();
    },
    onFocusCapture: () => {
      clearControlsHideTimer();
      setAreControlsVisible(true);
    },
    onBlurCapture: (event: React.FocusEvent<HTMLDivElement>) => {
      const nextFocusedElement = event.relatedTarget;
      if (nextFocusedElement instanceof Node && event.currentTarget.contains(nextFocusedElement)) return;
      scheduleControlsHide();
    },
  };

  const controlsOverlayProps = {
    ref: controlsRef,
    "data-controls-pinned": shouldPinControls,
    "data-controls-state": shouldPinControls || areControlsVisible ? "visible" : "hidden",
    ...overlayPointerHandlers,
  };

  useEffect(() => {
    if (shouldPinControls) {
      clearControlsHideTimer();
      return;
    }
    scheduleControlsHide();
    return clearControlsHideTimer;
  }, [clearControlsHideTimer, scheduleControlsHide, shouldPinControls]);

  // 隐藏后根节点通常没有焦点，Tab/方向键等事件不会冒泡到播放器。
  // 在组件存活期间监听文档级键盘输入，确保键盘也能重新呼出控制层。
  useEffect(() => {
    const handleDocumentKeyDown = () => revealControls();
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => document.removeEventListener("keydown", handleDocumentKeyDown);
  }, [revealControls]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

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

  const handleSeekCommit = async (values: number[]) => {
    setSeekPreview(null);
    if (!snapshot || !socketRef.current || totalDuration === 0) return;
    if (!canControl) {
      triggerLockWarning("调整播放进度");
      return;
    }
    const targetSecs = values[0] ?? 0;
    await runCommand((socket, revision) => socket.seek(targetSecs, revision));
  };

  const toggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    playerRef.current?.setMuted(nextMuted);
  };

  const handlePrevTrack = async () => {
    if (!snapshot || !socketRef.current) return;
    if (!canControl) {
      triggerLockWarning("切换播放条目");
      return;
    }
    const playlist = snapshot.playlist;
    const currentIndex = playlist.findIndex((item) => item.id === snapshot.currentPlaylistItemId);
    const previous = currentIndex > 0 ? playlist[currentIndex - 1] : undefined;
    if (!previous) return;
    await runCommand((socket, revision) => socket.playlistPlay(previous.id, revision));
  };

  const handleNextTrack = async () => {
    if (!snapshot || !socketRef.current) return;
    if (!canControl) {
      triggerLockWarning("切换播放条目");
      return;
    }
    await runCommand((socket, revision) => socket.playlistNext(revision));
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

  const toggleFullscreen = async () => {
    if (document.fullscreenElement === containerRef.current) {
      await document.exitFullscreen();
      return;
    }
    await containerRef.current?.requestFullscreen();
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const currentMediaTitle =
    snapshot?.source && "title" in snapshot.source && snapshot.source.title
      ? snapshot.source.title
      : "暂未载入媒体";

  return (
    <TooltipProvider>
    <div
      ref={containerRef}
      onPointerMove={revealControls}
      onPointerDown={revealControls}
      onKeyDown={revealControls}
      className="relative flex h-dvh w-screen flex-col overflow-hidden bg-black font-sans text-white select-none"
    >
      {/* ================= 1. 顶部呼出层：房间状态 + 锁/成员/媒体库 + 标题来源 ================= */}
      <div
        data-controls-state={shouldPinControls || areControlsVisible ? "visible" : "hidden"}
        className={cn(
          "absolute inset-x-0 top-0 z-30 bg-gradient-to-b from-black/85 via-black/60 to-transparent px-4 pt-3 pb-10 transition-opacity duration-150 ease-out motion-reduce:transition-none",
          shouldPinControls || areControlsVisible ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        {...overlayPointerHandlers}
      >
        <div className="flex items-center gap-3">
          <span className="font-mono text-[11px] text-neutral-400">/{roomId}</span>
          <span
            className={cn(
              "flex items-center gap-1.5 font-mono text-[11px]",
              isSocketConnected ? "text-emerald-400" : "text-rose-400",
            )}
          >
            <span className={cn("size-1.5 rounded-full", isSocketConnected ? "bg-emerald-400" : "bg-rose-500")} />
            {isSocketConnected ? "已连接" : "重连中..."}
          </span>
          <span className="flex-1" />
          <IconControl
            icon={isLocked ? "lock" : "lock_open"}
            label={isLocked ? "房主锁已开启" : "自由控制"}
            onClick={handleToggleLock}
            active={isLocked}
          />
          <IconControl
            icon="group"
            label={`在线成员 (${members.length})`}
            onClick={() => setIsMembersModalOpen(true)}
            badge={members.length}
          />
          <IconControl icon="video_library" label="点播媒体库" onClick={() => setIsOpenListModalOpen(true)} />
          <IconControl icon="tv" label="发射到 MPV" onClick={() => setIsMpvModalOpen(true)} />
        </div>
        <div className="mt-1.5 flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-medium text-white text-shadow-md [text-shadow:_0_1px_3px_rgb(0_0_0_/_80%)]">
            {currentMediaTitle}
          </span>
          {snapshot?.source && (
            <Badge
              variant="outline"
              className="h-4 shrink-0 border-sky-500/40 bg-sky-500/10 px-1.5 font-mono text-[9px] font-normal text-sky-400"
            >
              {snapshot.source.kind.toUpperCase()}
            </Badge>
          )}
        </div>
      </div>

      {/* ================= 2. 真实视频播放区域 (Video Stage) ================= */}
      <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-black">

        {/* 房主锁警告拦截提示 */}
        {lockWarning && (
          <div className="absolute top-16 z-40 rounded border border-amber-500/40 bg-amber-950/90 px-4 py-2 text-xs font-semibold text-amber-300 shadow-xl backdrop-blur-sm">
            🔒 {lockWarning}
          </div>
        )}

        {/* 全局异常提示 */}
        {globalError && (
          <div className="absolute top-16 z-40 flex items-center gap-2 rounded border border-rose-900/60 bg-rose-950/90 px-4 py-2 text-xs text-rose-300 shadow-xl backdrop-blur-sm">
            <MsIcon name="error" className="shrink-0 text-[16px]" />
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
            <div className="mb-3 flex size-16 items-center justify-center rounded-full border border-neutral-800 bg-neutral-950/80">
              <MsIcon name="play_arrow" filled className="text-[32px] text-neutral-500" />
            </div>
            <span className="text-xs">房间当前无播放媒体，点击此处打开媒体库点播</span>
          </div>
        )}
      </div>

      {/* ================= 3. 自动隐藏的底部控制浮层 ================= */}
      <div
        {...controlsOverlayProps}
        className={cn(
          "absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black via-black/95 to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-8 transition-opacity duration-150 ease-out motion-reduce:transition-none",
          shouldPinControls || areControlsVisible ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {/* 进度行：当前时间 / 进度 / 总时长 */}
        <div className="flex items-center gap-3">
          <span className="w-12 text-right font-mono text-xs text-neutral-300 tabular-nums">
            {formatTime(seekPreview ?? currentTime)}
          </span>
          <div className="relative flex-1">
            {bufferedPercent > 0 && (
              <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-white/15">
                <div className="h-full bg-white/25" style={{ width: `${bufferedPercent}%` }} />
              </div>
            )}
            <Slider
              value={[Math.min(seekPreview ?? currentTime, totalDuration || 0)]}
              max={totalDuration || 1}
              step={1}
              disabled={!canControl || totalDuration === 0}
              onValueChange={(values) => setSeekPreview(values[0] ?? null)}
              onValueCommit={handleSeekCommit}
              aria-label="播放进度"
              className="cursor-pointer"
            />
          </div>
          <span className="w-12 font-mono text-xs text-neutral-300 tabular-nums">{formatTime(totalDuration)}</span>
        </div>

        {/* 控制行：左（音量/字幕）· 中（传输）· 右（倍速/清单/循环/全屏） */}
        <div className="relative mt-1 flex items-center">
          <div className="flex flex-1 items-center gap-1">
            <IconControl
              icon={isMuted || volume === 0 ? "volume_off" : "volume_up"}
              label={isMuted || volume === 0 ? "取消静音" : "静音"}
              onClick={toggleMute}
              active={isMuted || volume === 0}
            />
            <Slider
              value={[isMuted ? 0 : volume]}
              max={100}
              onValueChange={(values) => {
                const v = values[0] ?? 0;
                setVolume(v);
                playerRef.current?.setVolume(v);
                playerRef.current?.setMuted(false);
                setIsMuted(false);
              }}
              aria-label="音量"
              className="w-20"
            />
            <Popover open={showSubtitleMenu} onOpenChange={setShowSubtitleMenu}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="字幕"
                  className="text-white/85 hover:bg-white/15 hover:text-white"
                >
                  <MsIcon name="subtitles" className="text-[20px]" />
                </Button>
              </PopoverTrigger>
              <PopoverContent side="top" align="start" className="w-64 p-3">
                <div className="space-y-3">
                  <div className="text-[11px] font-semibold text-neutral-300">本地字幕控制</div>
                  {subtitleTracks.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[10px] text-neutral-500">选择字幕轨</div>
                      {subtitleTracks.map((tr) => (
                        <Button
                          key={tr.id}
                          variant="ghost"
                          onClick={() => void selectSubtitleTrack(tr)}
                          className={cn(
                            "h-8 w-full justify-between px-2 text-xs",
                            activeSubtitleId === tr.id
                              ? "bg-sky-500/20 text-sky-400 hover:bg-sky-500/20 hover:text-sky-400"
                              : "font-normal text-neutral-400 hover:bg-neutral-900 hover:text-white",
                          )}
                        >
                          <span className="truncate">{tr.label}</span>
                          <span className="font-mono text-[9px] uppercase">{tr.format}</span>
                        </Button>
                      ))}
                    </div>
                  )}
                  <div className="space-y-1">
                    <div className="text-[10px] text-neutral-500">时间轴对齐 (仅本机生效)</div>
                    <div className="flex items-center justify-between font-mono text-xs">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSubtitleOffset((prev) => +(prev - 0.1).toFixed(1))}
                      >
                        -0.1s
                      </Button>
                      <span className="font-semibold text-sky-400">{subtitleOffset.toFixed(1)}s</span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSubtitleOffset((prev) => +(prev + 0.1).toFixed(1))}
                      >
                        +0.1s
                      </Button>
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            {(activeSubtitleTrack || subtitleOffset !== 0) && (
              <span className="font-mono text-[11px] text-sky-400">
                {subtitleOffset >= 0 ? `+${subtitleOffset.toFixed(1)}s` : `${subtitleOffset.toFixed(1)}s`}
              </span>
            )}
          </div>

          {/* 中置传输控制 */}
          <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1">
            <IconControl icon="skip_previous" label="上一项" onClick={handlePrevTrack} />
            <Button
              variant="ghost"
              size="icon"
              onClick={handleTogglePlay}
              aria-label={snapshot?.paused ? "播放" : "暂停"}
              className="text-white hover:bg-white/15"
            >
              <MsIcon name={snapshot?.paused ? "play_arrow" : "pause"} filled className="text-[26px]" />
            </Button>
            <IconControl icon="skip_next" label="下一项" onClick={handleNextTrack} />
          </div>

          <div className="flex flex-1 items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleRateChange}
              aria-label="倍速"
              className="font-mono text-xs text-white/85 hover:bg-white/15 hover:text-white"
            >
              {(snapshot?.playbackRate || 1).toFixed(2)}x
            </Button>
            <IconControl
              icon="playlist_play"
              label={`播放清单 (${snapshot?.playlist.length || 0})`}
              onClick={() => setIsPlaylistModalOpen(true)}
              badge={snapshot?.playlist.length || 0}
            />
            <IconControl
              icon="repeat"
              label={snapshot?.loop ? "循环播放已开启" : "循环播放"}
              onClick={handleToggleLoop}
              active={snapshot?.loop}
            />
            <IconControl
              icon={isFullscreen ? "close_fullscreen" : "open_in_full"}
              label={isFullscreen ? "退出全屏" : "进入全屏"}
              onClick={() => void toggleFullscreen()}
            />
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

      <MpvLaunchModal
        isOpen={isMpvModalOpen}
        onClose={() => setIsMpvModalOpen(false)}
        roomId={roomId}
        accessToken={accessToken}
      />
    </div>
    </TooltipProvider>
  );
}
