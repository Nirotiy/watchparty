"use client";

import React, { useState, useEffect, useRef, useCallback, useSyncExternalStore } from "react";
import { OpenListModal } from "./openlist-modal";
import { PlaylistModal } from "./playlist-modal";
import { MembersModal } from "./members-modal";
import { MpvLaunchModal } from "./mpv-launch-modal";
import { PlayerSettingsDialog } from "./player-settings-dialog";
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
import { mediaErrorText } from "@/lib/media-error-text";
import { synchronizePlayback } from "@/lib/playback-sync";
import type { EmbeddedTrack, EmbeddedTracks, PlayerLocalState, PlayerCapabilities } from "@/lib/player-local";
import { DEFAULT_PLAYER_PREFERENCES, DEFAULT_SUBTITLE_APPEARANCE,
  clearAllSubtitleOffsets, clampSubtitleOffset, getPreferenceMediaKey, preferredExternalSubtitle, readPlayerPreferences,
  readSubtitleOffset, savePlayerPreferences, saveSubtitleOffset, trackPreferencePatch,
  type PlayerPreferences, type SubtitleAppearance } from "@/lib/player-preferences";
import { operationResult, runBatchOperation, reconcilePlaylistAdd, confirmStoppedBatchItem,
  type BatchOperationResult, type PlaylistAddAttempt } from "@/lib/media-operation-result";

interface RoomPlayerProps {
  roomId: string;
  accessToken?: string;
  /** Token 失效（服务端重启/房间重建）时回调：页面层清除本地凭据并重新走门禁。 */
  onAuthInvalid?: () => void;
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
      <TooltipContent className="bg-secondary text-foreground border border-ring">{label}</TooltipContent>
    </Tooltip>
  );
}

function mediaSourceKey(source: MediaSource): string {
  if (source.kind === "openlist") return `openlist:${source.mediaId}`;
  if (source.kind === "youtube") return `youtube:${source.videoId}`;
  return `${source.kind}:${source.url}`;
}

const subscribeToHydration = () => () => {};

export default function RoomPlayer(props: RoomPlayerProps) {
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  return hydrated ? <HydratedRoomPlayer {...props} /> : <div className="h-dvh w-screen bg-black" />;
}

function HydratedRoomPlayer({ roomId, accessToken, onAuthInvalid }: RoomPlayerProps) {
  // 1. 本地客户端标识与 Token 准备
  const [clientId] = useState<string>(() => {
    const fallback = crypto.randomUUID();
    try {
      const saved = localStorage.getItem("watchparty_client_id");
      if (saved) return saved;
      localStorage.setItem("watchparty_client_id", fallback);
    } catch { /* A session identity still works when browser storage is disabled. */ }
    return fallback;
  });
  const [ownerToken, setOwnerToken] = useState<string | null>(() => {
    try { return localStorage.getItem(`owner_${roomId}`); } catch { return null; }
  });

  // 2. 权威快照与派生状态 (来自服务端，绝不写死)
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const snapshotRef = useRef<RoomSnapshot | null>(null);
  const commandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const uncertainQueueAddRef = useRef<PlaylistAddAttempt | null>(null);
  const [queueResult, setQueueResult] = useState<BatchOperationResult<MediaSource> | null>(null);

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
  const subtitleSequenceRef = useRef(0);
  const failedPlayerKeyRef = useRef<string | null>(null);
  const reconnectRecoveryRef = useRef(false);

  // 4. 本地播放控制 UI 状态 (音量、全屏、字幕纯本地，不广播)
  const [preferences, setPreferences] = useState<PlayerPreferences>(readPlayerPreferences);
  const preferencesRef = useRef(preferences);
  const [volume, setVolume] = useState(preferences.volume);
  const [isMuted, setIsMuted] = useState(preferences.muted);
  const persistPreferences = useCallback((patch: Partial<PlayerPreferences>) => {
    const next = savePlayerPreferences({ ...preferencesRef.current, ...patch });
    preferencesRef.current = next;
    setPreferences(next);
  }, []);
  const [currentTime, setCurrentTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);
  const [bufferedPercent, setBufferedPercent] = useState(0);
  const [playerReady, setPlayerReady] = useState(0);
  const [desktopFallbackKey, setDesktopFallbackKey] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [areControlsVisible, setAreControlsVisible] = useState(true);
  const [seekPreview, setSeekPreview] = useState<number | null>(null);

  // 本机状态和能力由当前内核报告，不进入房间快照。
  const [localState, setLocalState] = useState<PlayerLocalState | null>(null);
  const [playerCapabilities, setPlayerCapabilities] = useState<PlayerCapabilities | null>(null);
  const [embeddedTracks, setEmbeddedTracks] = useState<EmbeddedTracks | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [desktopFallbackNote, setDesktopFallbackNote] = useState<string | null>(null);
  const touchPressedWhileHiddenRef = useRef(false);

  // 5. 字幕核心状态 (本地隔离，支持 SRT 动态转 VTT)
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const [activeSubtitleId, setActiveSubtitleId] = useState<string | null>(null);
  const [rawSubtitleContent, setRawSubtitleContent] = useState<string | null>(null);
  const [subtitleOffset, setSubtitleOffset] = useState<number>(0.0);
  const [showSubtitleMenu, setShowSubtitleMenu] = useState<boolean>(false);
  const [showAudioMenu, setShowAudioMenu] = useState<boolean>(false);
  const [showMoreMenu, setShowMoreMenu] = useState<boolean>(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState<boolean>(false);
  // 字幕上传（媒体级持久；契约 temp-html/subtitle-upload-contract-2026-10-08.md）
  const [subtitleUploadBusy, setSubtitleUploadBusy] = useState(false);
  const [subtitleUploadError, setSubtitleUploadError] = useState<string | null>(null);
  const subtitleFileRef = useRef<HTMLInputElement | null>(null);

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

  // 6. 房主专属操作提示
  const [lockWarning, setLockWarning] = useState<string | null>(null);
  const lockWarningTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 7. Pop-up 模态弹窗控制
  const [isOpenListModalOpen, setIsOpenListModalOpen] = useState(false);
  // 裁决 ②：媒体库默认按"快速挑一个"的弹窗打开，可以摊成整页做浏览与整理。
  const [isLibraryFullPage, setIsLibraryFullPage] = useState(false);
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
    showAudioMenu ||
    showMoreMenu ||
    showSettingsMenu ||
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
      setIsFullscreen(document.fullscreenElement !== null);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  // 房主专属操作的提示气泡
  const triggerLockWarning = useCallback((actionText: string) => {
    setLockWarning(`仅房主可${actionText}`);
    if (lockWarningTimerRef.current) clearTimeout(lockWarningTimerRef.current);
    lockWarningTimerRef.current = setTimeout(() => setLockWarning(null), 2500);
  }, []);

  const clearSubtitles = useCallback(() => {
    subtitleSequenceRef.current += 1;
    setSubtitleTracks([]);
    setActiveSubtitleId(null);
    setRawSubtitleContent(null);
  }, []);

  // Resolve OpenList URLs without coupling media state to the Socket lifecycle.
  const resolveAndLoadMedia = useCallback(
    async (source: MediaSource, token: string, isRetry = false) => {
      const sourceKey = mediaSourceKey(source);
      if (sourceKeyRef.current !== sourceKey) {
        failedPlayerKeyRef.current = null;
        resolveSequenceRef.current += 1;
        sourceKeyRef.current = sourceKey;
        resolvedMediaRef.current = null;
        hasRetriedResolveRef.current = false;
        setStreamUrl(null);
        clearSubtitles();
        setSubtitleOffset(readSubtitleOffset(getPreferenceMediaKey(source)));
        setTotalDuration(0);
        setCurrentTime(0);
        setBufferedPercent(0);
        setLocalState(null);
        setPlayerCapabilities(null);
        setEmbeddedTracks(null);
        setPlayerError(null);
        setIsRetrying(false);
        setDesktopFallbackNote(null);
      }

      if (source.kind === "http" || source.kind === "hls" || source.kind === "youtube") {
        setIsResolving(false);
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
          setGlobalError(null);
          setDesktopFallbackNote("该媒体要求自定义请求头，网页端无法直接播放。");
          setDesktopFallbackKey(sourceKey);
          return;
        }
        resolvedMediaRef.current = { mediaId: source.mediaId, url: result.url };
        setStreamUrl(result.url);
        setGlobalError(null);

        const subtitleSequence = ++subtitleSequenceRef.current;
        try {
          const tracks = await api.getSubtitleTracks(roomId, source.mediaId, token);
          if (sequence !== resolveSequenceRef.current || subtitleSequence !== subtitleSequenceRef.current) return;
          setSubtitleTracks(tracks);
          const saved = preferencesRef.current;
          // 来源偏好：外挂优先时自动挑外挂（语言列表命中/默认轨）；内嵌优先时交给引擎内嵌路径。
          const firstTrack = saved.subtitlesOff || saved.subtitleSourcePreference !== "external"
            ? undefined
            : preferredExternalSubtitle(tracks, saved.subtitleLanguages);
          if (!firstTrack) return;
          const subtitleContent = await (firstTrack.source === "upload"
            ? api.getSubtitleTrackContent(roomId, firstTrack.id, token)
            : api.getSubtitleContent(roomId, firstTrack.mediaId, token));
          if (sequence !== resolveSequenceRef.current || subtitleSequence !== subtitleSequenceRef.current) return;
          setActiveSubtitleId(firstTrack.id);
          setSubtitleOffset(readSubtitleOffset(getPreferenceMediaKey(source), undefined, firstTrack.offsetSeconds ?? 0));
          setRawSubtitleContent(subtitleContent);
        } catch {
          if (sequence === resolveSequenceRef.current && subtitleSequence === subtitleSequenceRef.current) clearSubtitles();
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
        reconnectRecoveryRef.current = failedPlayerKeyRef.current !== null;
      },
      onDisconnect: () => {
        setIsSocketConnected(false);
      },
      onSnapshot: (newSnapshot) => {
        if (ownerToken && newSnapshot.ownerClientId !== clientId) {
          try { localStorage.removeItem(`owner_${roomId}`); } catch { /* Session state remains authoritative. */ }
          setOwnerToken(null);
        }
        snapshotRef.current = newSnapshot;
        setSnapshot(newSnapshot);
        // 若当前有媒体且与当前解析源不一致，拉取并解析
        if (newSnapshot.source) {
          resolveAndLoadMedia(newSnapshot.source, accessToken);
          if (reconnectRecoveryRef.current && failedPlayerKeyRef.current === mediaSourceKey(newSnapshot.source)) {
            reconnectRecoveryRef.current = false;
            failedPlayerKeyRef.current = null;
            playerRef.current?.retry?.();
          }
        } else {
          failedPlayerKeyRef.current = null;
          reconnectRecoveryRef.current = false;
          sourceKeyRef.current = null;
          resolvedMediaRef.current = null;
          resolveSequenceRef.current += 1;
          hasRetriedResolveRef.current = false;
          setStreamUrl(null);
          setIsResolving(false);
          setTotalDuration(0);
          setCurrentTime(0);
          setBufferedPercent(0);
          setLocalState(null);
          setPlayerCapabilities(null);
          setEmbeddedTracks(null);
          setPlayerError(null);
          setIsRetrying(false);
          setDesktopFallbackNote(null);
          clearSubtitles();
          setSubtitleOffset(0);
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
        try { localStorage.setItem(`owner_${roomId}`, newOwnerToken); } catch { /* Keep the token in this session. */ }
      },
      onError: (err) => {
        // 握手鉴权失败：旧 token 已失效，交回页面层降级到门禁/重入流程。
        if (err.code === "ACCESS_TOKEN_INVALID" || err.code === "ROOM_NOT_FOUND") {
          onAuthInvalid?.();
          return;
        }
        setGlobalError(err.message);
      },
    });

    socketRef.current = socket;
    socket.connect();

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId, clientId, accessToken, ownerToken, resolveAndLoadMedia, clearSubtitles, onAuthInvalid]);

  // 权威时钟 NTP 追帧同步逻辑
  useEffect(() => {
    if (!snapshot || !playerRef.current || isResolving) return;
    const clockOffset = socketRef.current?.getClockOffset() || 0;
    synchronizePlayback(playerRef.current, snapshot, Date.now() + clockOffset);
  }, [snapshot, isResolving, playerReady]);

  // 权限与房主判定
  const isOwner = snapshot?.ownerClientId === clientId;
  const canControl = Boolean(snapshot);
  const canOwnerControl = Boolean(snapshot && isOwner);

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
    (
      command: (socket: WatchPartySocket, revision: number) => Promise<CommandAck>,
    ): Promise<CommandAck> => {
      // Read the authoritative revision when this user action reaches the front of the queue.
      const pending = commandQueueRef.current.then(async (): Promise<CommandAck> => {
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
      });
      commandQueueRef.current = pending.then(() => {}, () => {});
      return pending;
    },
    [waitForNewerRevision],
  );

  const selectSubtitleTrack = useCallback(
    async (track: SubtitleTrack) => {
      if (!accessToken) return;
      const sequence = ++subtitleSequenceRef.current;
      const sourceKey = sourceKeyRef.current;
      try {
        const content = await (track.source === "upload"
          ? api.getSubtitleTrackContent(roomId, track.id, accessToken)
          : api.getSubtitleContent(roomId, track.mediaId, accessToken));
        if (sequence !== subtitleSequenceRef.current || sourceKey !== sourceKeyRef.current) return;
        setActiveSubtitleId(track.id);
        setSubtitleOffset(readSubtitleOffset(getPreferenceMediaKey(snapshotRef.current?.source ?? null), undefined, track.offsetSeconds ?? 0));
        setRawSubtitleContent(content);
        // 手选只作用于当前媒体（覆盖自动选择、同媒体重试保留）；不重排全局语言列表（handoff §八）。
        persistPreferences({ subtitlesOff: false });
        setGlobalError(null);
      } catch (error: unknown) {
        if (sequence !== subtitleSequenceRef.current || sourceKey !== sourceKeyRef.current) return;
        setGlobalError(error instanceof Error ? error.message : "字幕加载失败");
      }
    },
    [accessToken, roomId, persistPreferences],
  );

  const handleSubtitleUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file || !accessToken) return;
      const format = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? "").toLowerCase();
      if (format !== "srt" && format !== "vtt" && format !== "ass" && format !== "ssa") {
        setSubtitleUploadError("只支持 SRT / VTT / ASS / SSA 字幕");
        return;
      }
      if (file.size > 512 * 1024) {
        setSubtitleUploadError("字幕文件超过 512KB");
        return;
      }
      const source = snapshotRef.current?.source ?? null;
      if (!source || source.kind !== "openlist") {
        setSubtitleUploadError("当前片源不支持上传字幕");
        return;
      }
      setSubtitleUploadBusy(true);
      setSubtitleUploadError(null);
      try {
        const content = await file.text();
        const created = await api.uploadSubtitle(roomId, accessToken, {
          mediaId: source.mediaId,
          name: file.name,
          format,
          content,
        });
        setSubtitleTracks((prev) => [...prev.filter((track) => track.id !== created.id), created]);
        await selectSubtitleTrack(created);
      } catch (error: unknown) {
        const status = (error as { status?: number }).status;
        setSubtitleUploadError(
          status === 404 || status === 405 ? "字幕上传尚未启用" : mediaErrorText(error, "字幕上传失败"),
        );
      } finally {
        setSubtitleUploadBusy(false);
      }
    },
    [accessToken, roomId, selectSubtitleTrack],
  );

  const handleSubtitleDelete = useCallback(
    async (track: SubtitleTrack) => {
      if (!accessToken || track.source !== "upload") return;
      try {
        await api.deleteSubtitle(roomId, accessToken, track.id);
        setSubtitleTracks((prev) => prev.filter((item) => item.id !== track.id));
        if (activeSubtitleId === track.id) {
          setActiveSubtitleId(null);
          setRawSubtitleContent(null);
        }
      } catch (error: unknown) {
        setSubtitleUploadError(mediaErrorText(error, "删除字幕失败"));
      }
    },
    [accessToken, roomId, activeSubtitleId],
  );

  // 内嵌轨道选择：只作用于本机引擎，不发房间命令。
  const selectEmbeddedAudio = useCallback(async (track: EmbeddedTrack) => {
    if (!track.supported) return;
    const sourceKey = sourceKeyRef.current;
    try {
      const select = playerRef.current?.selectAudioTrack;
      if (!select) return;
      await select(track.id);
      if (sourceKey !== sourceKeyRef.current) return;
      persistPreferences(trackPreferencePatch("audio", track));
      setGlobalError(null);
    } catch (error: unknown) {
      setGlobalError(error instanceof Error ? error.message : "切换音轨失败");
    }
  }, [persistPreferences]);

  const selectEmbeddedSubtitle = useCallback((track: EmbeddedTrack) => {
    if (!track.supported) return;
    try {
      const select = playerRef.current?.selectSubtitleTrack;
      if (!select) return;
      select(track.id);
      subtitleSequenceRef.current += 1;
      setActiveSubtitleId(null);
      setRawSubtitleContent(null);
      persistPreferences(trackPreferencePatch("subtitle", track));
      setGlobalError(null);
    } catch (error: unknown) {
      setGlobalError(error instanceof Error ? error.message : "切换字幕轨失败");
    }
  }, [persistPreferences]);

  const disableSubtitles = useCallback(() => {
    subtitleSequenceRef.current += 1;
    setActiveSubtitleId(null);
    setRawSubtitleContent(null);
    try {
      playerRef.current?.selectSubtitleTrack?.(null);
      persistPreferences(trackPreferencePatch("subtitle", null));
      setGlobalError(null);
    } catch (error: unknown) {
      setGlobalError(error instanceof Error ? error.message : "关闭字幕失败");
    }
  }, [persistPreferences]);

  const adjustSubtitleOffset = (delta: number) => {
    const next = clampSubtitleOffset(+(subtitleOffset + delta).toFixed(1));
    setSubtitleOffset(next);
    saveSubtitleOffset(getPreferenceMediaKey(snapshotRef.current?.source ?? null), next);
  };

  // ===== 本机设置（最终 handoff）：外观即时生效；语言与来源偏好下次载入生效；手选不写全局列表。 =====
  const updateSubtitleAppearance = (patch: Partial<SubtitleAppearance>) => {
    persistPreferences({ subtitleAppearance: { ...preferencesRef.current.subtitleAppearance, ...patch } });
  };
  const handleLanguageListChange = (kind: "audio" | "subtitle", next: string[]) => {
    persistPreferences(kind === "audio" ? { audioLanguages: next } : { subtitleLanguages: next });
  };
  const handleSubtitlesOffChange = (off: boolean) => {
    if (off) {
      disableSubtitles();
      return;
    }
    persistPreferences({ subtitlesOff: false });
    const saved = preferencesRef.current;
    const externalMatch = preferredExternalSubtitle(subtitleTracks, saved.subtitleLanguages);
    if (saved.subtitleSourcePreference === "external" && externalMatch) {
      void selectSubtitleTrack(externalMatch);
      return;
    }
    try {
      playerRef.current?.selectSubtitleTrack?.(embeddedTracks?.subtitleId ?? null);
    } catch {
      // 引擎未就绪：载入时按偏好恢复。
    }
  };
  const handleResetPlayerPreferences = () => {
    const next = savePlayerPreferences({ ...DEFAULT_PLAYER_PREFERENCES, subtitleAppearance: { ...DEFAULT_SUBTITLE_APPEARANCE } });
    preferencesRef.current = next;
    setPreferences(next);
    setVolume(next.volume);
    setIsMuted(next.muted);
    playerRef.current?.setVolume(next.volume / 100);
    playerRef.current?.setMuted(next.muted);
  };
  const handleZeroSubtitleOffset = () => {
    setSubtitleOffset(0);
    saveSubtitleOffset(getPreferenceMediaKey(snapshotRef.current?.source ?? null), 0);
  };
  const handleClearAllOffsets = () => {
    clearAllSubtitleOffsets();
    setSubtitleOffset(0);
  };
  // 能力语境：YouTube 走自身字幕；ASS/SSA（外挂或内嵌）走原样式——外观设置对它们不生效，如实说明。
  const settingsSourceIsYoutube = snapshot?.source?.kind === "youtube";
  const activeSubtitleIsAss = Boolean(
    (activeSubtitleTrack && (activeSubtitleTrack.format === "ass" || activeSubtitleTrack.format === "ssa")) ||
    (!activeSubtitleId && embeddedTracks?.subtitleId != null &&
      embeddedTracks.items.some((track) => track.id === embeddedTracks.subtitleId && track.kind === "subtitle" && /ass|ssa/i.test(track.codec))),
  );
  const appearanceNotice = settingsSourceIsYoutube
    ? "YouTube 使用其自身字幕能力"
    : activeSubtitleIsAss ? "当前是 ASS 字幕：使用原样式，外观不生效" : null;
  const appearanceDisabled = settingsSourceIsYoutube;

  // 内嵌优先但媒体没有内嵌字幕轨时，回退外挂（handoff：「来源不存在则使用另一来源」），每媒体一次。
  const externalFallbackRef = useRef<string | null>(null);
  useEffect(() => {
    if (!snapshot?.source || !accessToken) return;
    const saved = preferencesRef.current;
    if (saved.subtitlesOff || saved.subtitleSourcePreference !== "embedded") return;
    if (!embeddedTracks || subtitleTracks.length === 0 || activeSubtitleId) return;
    if (embeddedTracks.items.some((track) => track.kind === "subtitle" && track.supported)) return;
    const mediaKey = getPreferenceMediaKey(snapshot.source);
    if (!mediaKey || externalFallbackRef.current === mediaKey) return;
    const fallback = preferredExternalSubtitle(subtitleTracks, saved.subtitleLanguages);
    if (!fallback) return;
    externalFallbackRef.current = mediaKey;
    void selectSubtitleTrack(fallback);
  }, [snapshot?.source, accessToken, embeddedTracks, subtitleTracks, activeSubtitleId, selectSubtitleTrack]);

  const addQueueMedia = useCallback((media: MediaSource): Promise<CommandAck> => runCommand(async (socket, revision) => {
    if (uncertainQueueAddRef.current) return { ok: false, error: { code: "QUEUE_ADD_UNCERTAIN", message: "上次添加结果待核对，暂不能再次添加" } };
    const before = snapshotRef.current;
    if (!before) return { ok: false, error: { code: "NOT_CONNECTED", message: "房间连接尚未就绪" } };
    const attempt = { before, media, clientId };
    let acknowledgement: CommandAck;
    try { acknowledgement = await socket.playlistAdd(media, revision); }
    catch { acknowledgement = { ok: false, error: { code: "COMMAND_EXCEPTION", message: "添加结果未知，请核对房间清单" } }; }
    if (operationResult(acknowledgement).status === "uncertain") uncertainQueueAddRef.current = attempt;
    return acknowledgement;
  }), [runCommand, clientId]);

  const reconcileQueueResult = async (result: BatchOperationResult<MediaSource>) => {
    const attempt = uncertainQueueAddRef.current;
    if (!attempt || !socketRef.current) return result;
    const fresh = await socketRef.current.refreshSnapshot();
    const acknowledgement = reconcilePlaylistAdd(attempt, fresh);
    if (!acknowledgement) return result;
    uncertainQueueAddRef.current = null;
    const confirmed = confirmStoppedBatchItem(result, acknowledgement);
    setQueueResult(confirmed);
    setGlobalError(null);
    return confirmed;
  };

  const handleRetryPlayback = () => {
    if (isRetrying || !playerRef.current?.retry) return;
    setIsRetrying(true);
    playerRef.current.retry();
  };

  // 播放器流过期 / 403 异常拦截：单次自动重新解析
  const handlePlayerError = (err: { code: string; message: string; isStreamExpired?: boolean }) => {
    if (err.code === "MKV_ERROR") failedPlayerKeyRef.current = sourceKeyRef.current;
    if (err.code === "MKV_UNSUPPORTED" && snapshot?.source) {
      setDesktopFallbackKey(mediaSourceKey(snapshot.source));
      setDesktopFallbackNote(null);
      setPlayerError(null);
      setGlobalError(null);
      return;
    }
    if (
      err.isStreamExpired &&
      snapshot?.source?.kind === "openlist" &&
      accessToken &&
      !hasRetriedResolveRef.current
    ) {
      hasRetriedResolveRef.current = true;
      resolveAndLoadMedia(snapshot.source, accessToken, true);
      return;
    }
    setIsRetrying(false);
    setPlayerError(err.message.replace(/https?:\/\/\S+/g, "链接已隐藏"));
    setGlobalError(null);
  };

  const refreshStreamUrl = useCallback(async () => {
    const source = snapshotRef.current?.source;
    if (source?.kind !== "openlist" || !accessToken) throw new Error("无法续期媒体签名");
    const key = mediaSourceKey(source);
    const resolved = await api.resolveMedia(roomId, source.mediaId, accessToken);
    const currentSource = snapshotRef.current?.source;
    if (!currentSource || mediaSourceKey(currentSource) !== key) throw new Error("媒体已经切换");
    if (resolved.requiresCustomHeaders) throw new Error("媒体要求原生请求头");
    return resolved.url;
  }, [roomId, accessToken]);

  // 交互控制 (全部发送至服务端等待 Ack 回执)
  const handleTogglePlay = async (info?: { pointerType?: string }) => {
    // 触屏：控制层隐藏时首次点按只呼出控制层，不改共享播放状态。
    if (info?.pointerType === "touch" && touchPressedWhileHiddenRef.current) {
      touchPressedWhileHiddenRef.current = false;
      revealControls();
      return;
    }
    touchPressedWhileHiddenRef.current = false;
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
    if (!canOwnerControl) {
      triggerLockWarning("调整播放进度");
      return;
    }
    const targetSecs = values[0] ?? 0;
    await runCommand((socket, revision) => socket.seek(targetSecs, revision));
  };

  const toggleMute = () => {
    void playerRef.current?.unlockAudio?.().catch(() => {});
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    playerRef.current?.setMuted(nextMuted);
    persistPreferences({ muted: nextMuted });
  };

  const handlePrevTrack = async () => {
    if (!snapshot || !socketRef.current) return;
    if (!canOwnerControl) {
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
    if (!canOwnerControl) {
      triggerLockWarning("切换播放条目");
      return;
    }
    await runCommand((socket, revision) => socket.playlistNext(revision));
  };

  const handleRateChange = async () => {
    if (!snapshot || !socketRef.current) return;
    if (!canOwnerControl) {
      triggerLockWarning("调整倍速");
      return;
    }
    const nextRate =
      snapshot.playbackRate === 1 ? 1.25 : snapshot.playbackRate === 1.25 ? 1.5 : snapshot.playbackRate === 1.5 ? 2.0 : 1.0;
    await runCommand((socket, revision) => socket.rate(nextRate, revision));
  };

  const handleToggleLoop = async () => {
    if (!snapshot || !socketRef.current) return;
    if (!canOwnerControl) {
      triggerLockWarning("切换循环");
      return;
    }
    await runCommand((socket, revision) => socket.loop(!snapshot.loop, revision));
  };

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    // 整文档全屏：Radix 弹层挂在 body 上，只全屏房间容器会让菜单与弹窗不可见。
    await document.documentElement.requestFullscreen();
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

  const isDesktopFallback = Boolean(
    snapshot?.source && desktopFallbackKey === mediaSourceKey(snapshot.source),
  );
  const embeddedAudioTracks = playerCapabilities?.embeddedTracks ? (embeddedTracks?.items ?? []).filter((track) => track.kind === "audio") : [];
  const embeddedSubtitleTracks = playerCapabilities?.embeddedTracks ? (embeddedTracks?.items ?? []).filter((track) => track.kind === "subtitle") : [];

  const stageStatus = React.useMemo<{ title: string; detail: string | null; hint: string | null } | null>(() => {
    if (!snapshot?.source || playerError || isDesktopFallback) return null;
    if (snapshot.source.kind === "openlist" && isResolving && !streamUrl) {
      return { title: "解析直链中", detail: null, hint: null };
    }
    if (!localState) return null;
    if (localState.phase === "loading") return { title: playerCapabilities?.engine === "mkv" ? "初始化解码器" : "加载中", detail: null, hint: null };
    if (localState.phase === "buffering") {
      return {
        title: "缓冲中",
        detail: playerCapabilities?.bufferedAhead && localState.bufferedAheadSeconds > 0.05 ? `可播 ${localState.bufferedAheadSeconds.toFixed(1)}s` : null,
        hint: "本机缓冲，房间进度不受影响",
      };
    }
    if (localState.phase === "ended") {
      const playlist = snapshot.playlist;
      const index = playlist.findIndex((item) => item.id === snapshot.currentPlaylistItemId);
      const hint = snapshot.loop
        ? "循环播放已开启"
        : index >= 0 && index < playlist.length - 1
          ? "下一项将暂停待播"
          : null;
      return { title: "播放结束", detail: null, hint };
    }
    return null;
  }, [snapshot, isResolving, streamUrl, localState, playerCapabilities, playerError, isDesktopFallback]);

  return (
    <TooltipProvider>
    <div
      ref={containerRef}
      onPointerMove={revealControls}
      onPointerDown={revealControls}
      onPointerDownCapture={(event) => {
        // 触屏点按舞台前先记录控制层是否隐藏（捕获阶段早于容器冒泡的 revealControls）。
        if (event.pointerType === "touch") {
          touchPressedWhileHiddenRef.current = !areControlsVisible && !shouldPinControls;
        }
      }}
      onKeyDown={revealControls}
      className="relative flex h-dvh w-screen flex-col overflow-hidden bg-black font-sans text-white select-none"
    >
      {/* ================= 1. 顶部呼出层：房间状态、成员、媒体库和标题来源 ================= */}
      <div
        data-controls-state={shouldPinControls || areControlsVisible ? "visible" : "hidden"}
        className={cn(
          "absolute inset-x-0 top-0 z-30 bg-gradient-to-b from-black/85 via-black/60 to-transparent px-4 pt-3 pb-10 transition-opacity duration-150 ease-out motion-reduce:transition-none",
          shouldPinControls || areControlsVisible ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        {...overlayPointerHandlers}
      >
        <div className="flex items-center gap-3">
          <span className="font-mono text-[11px] text-muted-foreground">/{roomId}</span>
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
            icon="group"
            label={`在线成员 (${members.length})`}
            onClick={() => setIsMembersModalOpen(true)}
            badge={members.length}
          />
          <IconControl icon="video_library" label="点播媒体库" onClick={() => setIsOpenListModalOpen(true)} />
          <IconControl icon="tv" label="桌面端 / 交接码" onClick={() => setIsMpvModalOpen(true)} />
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

        {/* 房主专属操作提示 */}
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

        {/* 本机播放状态，独立于自动隐藏浮层 */}
        {stageStatus && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 px-6 text-center">
            <p className="text-sm font-semibold text-white [text-shadow:_0_1px_3px_rgb(0_0_0_/_90%)]">{stageStatus.title}</p>
            {stageStatus.detail && (
              <p className="font-mono text-xs text-white/85 [text-shadow:_0_1px_3px_rgb(0_0_0_/_90%)]">{stageStatus.detail}</p>
            )}
            {stageStatus.hint && (
              <p className="text-[11px] text-white/70 [text-shadow:_0_1px_3px_rgb(0_0_0_/_90%)]">{stageStatus.hint}</p>
            )}
          </div>
        )}

        {/* 音频被浏览器挂起：可信点击只解锁本机音频 */}
        {playerCapabilities?.audioUnlock && localState?.audio === "blocked" && snapshot?.source && !playerError && !isDesktopFallback && (
          <button
            type="button"
            onClick={() => { void playerRef.current?.unlockAudio?.().catch(() => {}); }}
            className="absolute bottom-[10rem] left-3 z-20 flex items-center gap-1.5 rounded border border-amber-500/40 bg-black/85 px-2.5 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-950/60 sm:bottom-28"
          >
            <MsIcon name="volume_off" className="text-[16px]" />
            声音未开启 · 点按启用
          </button>
        )}

        {/* 本机引擎失败：同媒体重试或走桌面出口（不展示带签名 URL 的文本） */}
        {playerError && !isDesktopFallback && (
          <div className="absolute left-1/2 top-1/2 z-30 w-[min(26rem,90%)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-rose-900/70 bg-black/95 p-4 shadow-2xl">
            <div className="flex items-center gap-2 text-sm font-semibold text-rose-200">
              <MsIcon name="error" className="text-[18px]" />
              本机播放失败
            </div>
            <p className="mt-2 text-xs leading-relaxed break-words text-rose-100/85">{playerError}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" disabled={isRetrying || !playerCapabilities?.retry} onClick={handleRetryPlayback}>
                <MsIcon name="refresh" className="text-[15px]" />
                {isRetrying ? "重试中…" : "重试本机播放"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setIsMpvModalOpen(true)}>
                <MsIcon name="tv" className="text-[15px]" />
                桌面端播放
              </Button>
            </div>
            <p className="mt-2.5 text-[11px] text-muted-foreground">错误来自本机引擎；房间进度与其它成员不受影响。</p>
          </div>
        )}

        {/* 真实多内核 PlayerAdapter 渲染 */}
        {isDesktopFallback ? (
          <div className="flex size-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex size-14 items-center justify-center rounded-full border border-sky-900 bg-sky-950/40">
              <MsIcon name="tv" className="text-[28px] text-sky-400" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold text-white">此媒体需要 Banguru 桌面端</p>
              <p className="text-xs text-muted-foreground">
                {desktopFallbackNote ?? "房间已经同步选片；桌面端加入后会接管播放并继续接收房间控制。"}
              </p>
            </div>
            <Button size="sm" onClick={() => setIsMpvModalOpen(true)}>
              <MsIcon name="key" className="text-[16px]" />
              获取一次性交接码
            </Button>
          </div>
        ) : snapshot?.source ? (
          <PlayerAdapter
            ref={playerRef}
            source={snapshot.source}
            streamUrl={streamUrl}
            refreshStreamUrl={refreshStreamUrl}
            subtitleVttUrl={subtitleVttUrl}
            assSubtitle={assSubtitle}
            subtitleOffsetSeconds={subtitleOffset}
            subtitleStyle={preferences.subtitleAppearance}
            initialTrackPreferences={preferences}
            onCapabilities={setPlayerCapabilities}
            onLocalState={(state) => setLocalState(state)}
            onEmbeddedTracks={(tracks) => setEmbeddedTracks(tracks)}
            onTimeUpdate={(c, d, b) => {
              setCurrentTime(c);
              setTotalDuration(d);
              setBufferedPercent(b);
            }}
            onLoadedMetadata={(d) => {
              failedPlayerKeyRef.current = null;
              setPlayerError(null);
              setIsRetrying(false);
              setTotalDuration(d);
              playerRef.current?.setVolume(volume);
              playerRef.current?.setMuted(isMuted);
              setPlayerReady((ready) => ready + 1);
            }}
            onEnded={() => {
              // 自动切播下一首
              if (snapshot && socketRef.current && canOwnerControl) {
                void runCommand((socket, revision) => socket.playlistAutoNext(snapshot.currentPlaylistItemId, revision));
              }
            }}
            onPlayClick={handleTogglePlay}
            onError={handlePlayerError}
          />
        ) : (
          <div
            onClick={() => setIsOpenListModalOpen(true)}
            className="flex size-full cursor-pointer flex-col items-center justify-center bg-radial from-secondary to-background text-muted-foreground hover:text-muted-foreground"
          >
            <div className="mb-3 flex size-16 items-center justify-center rounded-full border border-border bg-card/80">
              <MsIcon name="play_arrow" filled className="text-[32px] text-muted-foreground" />
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
          <span className="w-12 text-right font-mono text-xs text-foreground/85 tabular-nums">
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
              disabled={!canOwnerControl || totalDuration === 0}
              onValueChange={(values) => setSeekPreview(values[0] ?? null)}
              onValueCommit={handleSeekCommit}
              aria-label="播放进度"
              className="cursor-pointer"
            />
          </div>
          <span className="w-12 font-mono text-xs text-foreground/85 tabular-nums">{formatTime(totalDuration)}</span>
        </div>

        {/* 控制行：左（音量/字幕）· 中（传输）· 右（倍速/清单/循环/全屏） */}
        <div className="relative mt-1 flex flex-wrap items-center gap-y-1 sm:flex-nowrap">
          {/* 运输组：宽屏绝对居中（现状）；窄屏独占一行居中，不与两侧工具重叠 */}
          <div className="order-1 flex w-full basis-full items-center justify-center gap-1 sm:absolute sm:left-1/2 sm:order-none sm:w-auto sm:basis-auto sm:-translate-x-1/2">
            <IconControl icon="skip_previous" label="上一项" onClick={handlePrevTrack} />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void handleTogglePlay()}
              aria-label={snapshot?.paused ? "播放" : "暂停"}
              className="text-white hover:bg-white/15"
            >
              <MsIcon name={snapshot?.paused ? "play_arrow" : "pause"} filled className="text-[26px]" />
            </Button>
            <IconControl icon="skip_next" label="下一项" onClick={handleNextTrack} />
          </div>
          <div className="order-2 flex flex-1 items-center gap-1 sm:order-none">
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
                void playerRef.current?.unlockAudio?.().catch(() => {});
                const v = values[0] ?? 0;
                setVolume(v);
                playerRef.current?.setVolume(v);
                playerRef.current?.setMuted(false);
                setIsMuted(false);
                persistPreferences({ volume: v, muted: false });
              }}
              aria-label="音量"
              className="w-20 max-sm:hidden"
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
                  <div className="text-[11px] font-semibold text-foreground/85">本机字幕控制</div>
                  {subtitleTracks.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[10px] text-muted-foreground">外挂字幕（优先）</div>
                      {subtitleTracks.map((tr) => (
                        <div key={tr.id} className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            onClick={() => void selectSubtitleTrack(tr)}
                            className={cn(
                              "h-8 min-w-0 flex-1 justify-between px-2 text-xs",
                              activeSubtitleId === tr.id
                                ? "bg-sky-500/20 text-sky-400 hover:bg-sky-500/20 hover:text-sky-400"
                                : "font-normal text-muted-foreground hover:bg-secondary hover:text-white",
                            )}
                          >
                            <span className="truncate">
                              {tr.source === "upload" ? "上传 · " : ""}{tr.label}
                            </span>
                            <span className="font-mono text-[9px] uppercase">{tr.format}</span>
                          </Button>
                          {tr.source === "upload" && isOwner && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`删除字幕 ${tr.label}`}
                              className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                              onClick={() => void handleSubtitleDelete(tr)}
                            >
                              <MsIcon name="close" className="text-[14px]" />
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="space-y-1">
                    <Button
                      variant="ghost"
                      disabled={subtitleUploadBusy}
                      onClick={() => subtitleFileRef.current?.click()}
                      className="h-8 w-full justify-between px-2 text-xs font-normal text-muted-foreground hover:bg-secondary hover:text-white"
                    >
                      <span className="flex items-center gap-1.5">
                        <MsIcon name="upload" className="text-[15px]" />
                        {subtitleUploadBusy ? "上传中…" : "上传字幕…"}
                      </span>
                      <span className="font-mono text-[9px]">SRT·VTT·ASS</span>
                    </Button>
                    {subtitleUploadError && (
                      <p className="px-2 text-[10px] text-destructive">{subtitleUploadError}</p>
                    )}
                    <input
                      ref={subtitleFileRef}
                      type="file"
                      accept=".srt,.vtt,.ass,.ssa"
                      className="hidden"
                      aria-label="上传字幕文件"
                      onChange={(event) => void handleSubtitleUpload(event)}
                    />
                  </div>
                  {embeddedSubtitleTracks.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[10px] text-muted-foreground">内嵌字幕轨</div>
                      {embeddedSubtitleTracks.map((track) => (
                        <Button
                          key={track.id}
                          variant="ghost"
                          disabled={!track.supported}
                          onClick={() => selectEmbeddedSubtitle(track)}
                          className={cn(
                            "h-8 w-full justify-between px-2 text-xs",
                            !activeSubtitleId && embeddedTracks?.subtitleId === track.id
                              ? "bg-sky-500/20 text-sky-400 hover:bg-sky-500/20 hover:text-sky-400"
                              : "font-normal text-muted-foreground hover:bg-secondary hover:text-white",
                            !track.supported && "opacity-60",
                          )}
                        >
                          <span className="truncate">
                            {track.language ? `${track.language} · ` : ""}{track.label}
                          </span>
                          <span className="font-mono text-[9px] uppercase">{track.supported ? track.codec : "不支持"}</span>
                        </Button>
                      ))}
                    </div>
                  )}
                  {(subtitleTracks.length > 0 || embeddedSubtitleTracks.length > 0) && (
                    <Button
                      variant="ghost"
                      onClick={disableSubtitles}
                      className={cn(
                        "h-8 w-full justify-between px-2 text-xs",
                        !activeSubtitleId && embeddedTracks?.subtitleId == null
                          ? "bg-sky-500/20 text-sky-400 hover:bg-sky-500/20 hover:text-sky-400"
                          : "font-normal text-muted-foreground hover:bg-secondary hover:text-white",
                      )}
                    >
                      <span>字幕关闭</span>
                      <span className="font-mono text-[9px]">
                        {!activeSubtitleId && embeddedTracks?.subtitleId == null ? "当前" : ""}
                      </span>
                    </Button>
                  )}
                  <div className="space-y-1">
                    <div className="text-[10px] text-muted-foreground">时间轴对齐 (仅本机生效)</div>
                    <div className="flex items-center justify-between font-mono text-xs">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => adjustSubtitleOffset(-0.1)}
                      >
                        -0.1s
                      </Button>
                      <span className="font-semibold text-sky-400">{subtitleOffset.toFixed(1)}s</span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => adjustSubtitleOffset(0.1)}
                      >
                        +0.1s
                      </Button>
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            {embeddedAudioTracks.length > 0 && (
              <Popover open={showAudioMenu} onOpenChange={setShowAudioMenu}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="音轨"
                    className="text-white/85 hover:bg-white/15 hover:text-white"
                  >
                    <MsIcon name="graphic_eq" className="text-[20px]" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent side="top" align="start" className="w-64 p-3">
                  <div className="space-y-3">
                    <div className="text-[11px] font-semibold text-foreground/85">本机音轨</div>
                    <div className="space-y-1">
                      {embeddedAudioTracks.map((track) => (
                        <Button
                          key={track.id}
                          variant="ghost"
                          disabled={!track.supported}
                          onClick={() => void selectEmbeddedAudio(track)}
                          className={cn(
                            "h-8 w-full justify-between px-2 text-xs",
                            embeddedTracks?.audioId === track.id
                              ? "bg-sky-500/20 text-sky-400 hover:bg-sky-500/20 hover:text-sky-400"
                              : "font-normal text-muted-foreground hover:bg-secondary hover:text-white",
                            !track.supported && "opacity-60",
                          )}
                        >
                          <span className="truncate">
                            {track.language ? `${track.language} · ` : ""}{track.label}
                          </span>
                          <span className="font-mono text-[9px] uppercase">{track.supported ? track.codec : "不支持"}</span>
                        </Button>
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground">仅本机切换，不改房间进度。</p>
                  </div>
                </PopoverContent>
              </Popover>
            )}
            {(activeSubtitleTrack || subtitleOffset !== 0) && (
              <span className="font-mono text-[11px] text-sky-400">
                {subtitleOffset >= 0 ? `+${subtitleOffset.toFixed(1)}s` : `${subtitleOffset.toFixed(1)}s`}
              </span>
            )}
          </div>

          <div className="order-3 flex flex-1 items-center justify-end gap-1 sm:order-none">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleRateChange}
              aria-label="倍速"
              className="font-mono text-xs text-white/85 hover:bg-white/15 hover:text-white"
            >
              {(snapshot?.playbackRate || 1).toFixed(2)}x
            </Button>
            <div className="hidden items-center gap-1 sm:flex">
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
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="设置"
              className="text-white/85 hover:bg-white/15 hover:text-white"
              onClick={() => setShowSettingsMenu(true)}
            >
              <MsIcon name="settings" className="text-[20px]" />
            </Button>
            
            <IconControl
              icon={isFullscreen ? "close_fullscreen" : "open_in_full"}
              label={isFullscreen ? "退出全屏" : "进入全屏"}
              onClick={() => void toggleFullscreen()}
            />
            <Popover open={showMoreMenu} onOpenChange={setShowMoreMenu}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="更多工具"
                  className="text-white/85 hover:bg-white/15 hover:text-white sm:hidden"
                >
                  <MsIcon name="more_vert" className="text-[20px]" />
                </Button>
              </PopoverTrigger>
              <PopoverContent side="top" align="end" className="w-48 p-2">
                <div className="space-y-1">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setShowMoreMenu(false);
                      setIsPlaylistModalOpen(true);
                    }}
                    className="h-8 w-full justify-start gap-2 px-2 text-xs font-normal text-muted-foreground hover:bg-secondary hover:text-white"
                  >
                    <MsIcon name="playlist_play" className="text-[16px]" />
                    播放清单 ({snapshot?.playlist.length || 0})
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setShowMoreMenu(false);
                      void handleToggleLoop();
                    }}
                    className="h-8 w-full justify-start gap-2 px-2 text-xs font-normal text-muted-foreground hover:bg-secondary hover:text-white"
                  >
                    <MsIcon name="repeat" className="text-[16px]" />
                    {snapshot?.loop ? "关闭循环播放" : "循环播放"}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>

      {/* ================= 4. 挂载三大 Pop-up 弹窗 ================= */}
      <OpenListModal
        isOpen={isOpenListModalOpen}
        onClose={() => setIsOpenListModalOpen(false)}
        fullPage={isLibraryFullPage}
        onToggleFullPage={() => setIsLibraryFullPage((value) => !value)}
        onPlayNow={async (media) => {
          if (!snapshot || !socketRef.current) return false;
          if (!canOwnerControl) {
            triggerLockWarning("切换播放媒体");
            return false;
          }
          return (await runCommand((socket, revision) => socket.mediaSet(media, revision))).ok;
        }}
        onPlayOnDesktop={async (media) => {
          if (!snapshot || !socketRef.current) return false;
          if (!canOwnerControl) {
            triggerLockWarning("切换播放媒体");
            return false;
          }
          const acknowledgement = await runCommand((socket, revision) =>
            socket.mediaSet(media, revision),
          );
          if (!acknowledgement.ok) return false;
          setIsMpvModalOpen(true);
          return true;
        }}
        queueResult={queueResult}
        onReconcileQueue={reconcileQueueResult}
        onAddToQueue={async (media) => {
          const result = await runBatchOperation([media], addQueueMedia);
          setQueueResult(result);
          return result.stopped?.result ?? { status: "succeeded", acknowledgement: result.succeeded[0].acknowledgement };
        }}
        onBatchAdd={async (medias) => {
          const result = await runBatchOperation(medias, addQueueMedia);
          setQueueResult(result);
          return result;
        }}
      />

      <PlaylistModal
        isOpen={isPlaylistModalOpen}
        onClose={() => setIsPlaylistModalOpen(false)}
        playlist={snapshot?.playlist || []}
        currentPlaylistItemId={snapshot?.currentPlaylistItemId}
        onPlayItem={async (itemId) => {
          if (!snapshot || !socketRef.current) return;
          if (!canOwnerControl) {
            triggerLockWarning("切换播放条目");
            return;
          }
          await runCommand((socket, revision) => socket.playlistPlay(itemId, revision));
        }}
        onRemoveItem={async (itemId) => {
          if (!snapshot || !socketRef.current) return;
          await runCommand((socket, revision) => socket.playlistRemove(itemId, revision));
        }}
        onMoveItem={async (itemId, targetIndex) => {
          if (!snapshot || !socketRef.current) return;
          await runCommand((socket, revision) =>
            socket.playlistMove(itemId, targetIndex, revision),
          );
        }}
        onOpenMediaSelector={() => setIsOpenListModalOpen(true)}
        canPlayItem={canOwnerControl}
        canEditQueue={canControl}
      />

      <MembersModal
        isOpen={isMembersModalOpen}
        onClose={() => setIsMembersModalOpen(false)}
        members={members}
        isOwner={isOwner}
        onTransferOwnership={async (targetClientId) => {
          if (!snapshot || !socketRef.current || !isOwner) return { ok: false, error: { code: "FORBIDDEN", message: "当前不能移交房主" } };
          return runCommand((socket, revision) =>
            socket.transferOwner(targetClientId, revision),
          );
        }}
        onTransferResult={(result) => setGlobalError(result.status === "succeeded" ? null : result.status === "uncertain" ? "移交结果未知，请核对房主状态，暂勿重复操作" : result.error.message)}
      />

      <MpvLaunchModal
        isOpen={isMpvModalOpen}
        onClose={() => setIsMpvModalOpen(false)}
        roomId={roomId}
        accessToken={accessToken}
      />

      <PlayerSettingsDialog
        open={showSettingsMenu}
        onOpenChange={setShowSettingsMenu}
        preferences={preferences}
        volume={volume}
        muted={isMuted}
        onVolumeChange={(v) => {
          setVolume(v);
          playerRef.current?.setVolume(v);
          playerRef.current?.setMuted(false);
          setIsMuted(false);
          persistPreferences({ volume: v, muted: false });
        }}
        onToggleMute={toggleMute}
        onSubtitlesOffChange={handleSubtitlesOffChange}
        onSourcePreferenceChange={(preference) => persistPreferences({ subtitleSourcePreference: preference })}
        onLanguageListChange={handleLanguageListChange}
        updateAppearance={updateSubtitleAppearance}
        subtitleOffset={subtitleOffset}
        onOffsetDelta={adjustSubtitleOffset}
        onOffsetZero={handleZeroSubtitleOffset}
        appearanceNotice={appearanceNotice}
        appearanceDisabled={appearanceDisabled}
        onResetPreferences={handleResetPlayerPreferences}
        onClearAllOffsets={handleClearAllOffsets}
      />
    </div>
    </TooltipProvider>
  );
}
