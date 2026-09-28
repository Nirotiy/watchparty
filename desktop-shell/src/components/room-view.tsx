import { useCallback, useEffect, useRef, useState } from "react"
import type { ReactElement } from "react"
import { GaugeRegular } from "@fluentui/react-icons"

import { MaterialSymbol, type MaterialSymbolName } from "@/components/material-symbol"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { DesktopCommand, DesktopUiState, MediaSource, Track } from "@/lib/contracts"
import { listenForWindowState, windowControl } from "@/lib/ipc"
import { cn } from "@/lib/utils"

type Drawer = "queue" | "members" | null

interface RoomViewProps {
  state: DesktopUiState
  roomId: string | null
  drawer: Drawer
  command: (command: DesktopCommand) => Promise<boolean>
  mediaQueueAvailable: boolean
  fullscreen: boolean
  statusText: string
  onFullscreenChange: (fullscreen: boolean) => void
  onDrawerChange: (drawer: Exclude<Drawer, null>) => void
  onOpenMedia: () => void
  onLeave: () => void
}

const CONTROLS_HIDE_DELAY_MS = 2400

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00"
  const whole = Math.floor(seconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const remainder = whole % 60
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
}

function mediaTitle(source: MediaSource | null): string {
  if (!source) return "等待房间媒体"
  if (source.kind === "openlist") return source.title
  return source.title || (source.kind === "youtube" ? source.videoId : "在线媒体")
}

function trackLabel(track: Track): string {
  return [track.language, track.label, track.codec].filter(Boolean).join(" · ") || `轨道 ${track.id}`
}

function IconControl({ icon, label, active, disabled, onClick, className }: {
  icon: MaterialSymbolName
  label: string
  active?: boolean
  disabled?: boolean
  onClick?: () => void
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          className={cn("media-icon", className)}
        >
          <MaterialSymbol name={icon} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function SelectIconControl({ icon, label }: { icon: MaterialSymbolName; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <SelectTrigger
          aria-label={label}
          className="media-icon [&>svg:last-child]:hidden"
        >
          <MaterialSymbol name={icon} />
        </SelectTrigger>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function SharedControl({ reason, children }: { reason: string | null; children: ReactElement }) {
  if (!reason) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className="inline-flex">{children}</span></TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}

/** 播放页不画系统顶栏，窗口按钮跟着悬浮控件一起收放（同 Segoe Fluent Icons 字形）。 */
const WINDOW_GLYPH = { minimize: "\uE921", maximize: "\uE922", restore: "\uE923", close: "\uE8BB" }

function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    let dispose: (() => void) | null = null
    let dropped = false
    void listenForWindowState((state) => { if (!dropped) setMaximized(state.maximized) })
      .then((unlisten) => { if (dropped) unlisten(); else dispose = unlisten })
      .catch(() => {})
    return () => { dropped = true; dispose?.() }
  }, [])
  return (
    <div className="flex items-stretch">
      <button type="button" tabIndex={-1} className="room-window-btn" aria-label="最小化" onClick={() => void windowControl("minimize")}>{WINDOW_GLYPH.minimize}</button>
      <button type="button" tabIndex={-1} className="room-window-btn" aria-label={maximized ? "向下还原" : "最大化"} onClick={() => void windowControl("maximize")}>{maximized ? WINDOW_GLYPH.restore : WINDOW_GLYPH.maximize}</button>
      <button type="button" tabIndex={-1} className="room-window-btn room-window-close" aria-label="关闭" onClick={() => void windowControl("close")}>{WINDOW_GLYPH.close}</button>
    </div>
  )
}

export function RoomView({
  state,
  roomId,
  drawer,
  command,
  mediaQueueAvailable,
  fullscreen,
  statusText,
  onFullscreenChange,
  onDrawerChange,
  onOpenMedia,
  onLeave,
}: RoomViewProps) {
  const room = state.room
  const player = state.player
  const duration = Number.isFinite(player.duration) ? Math.max(0, player.duration) : 0
  const [position, setPosition] = useState(0)
  const [volume, setVolume] = useState(100)
  const [seeking, setSeeking] = useState(false)
  const [adjustingVolume, setAdjustingVolume] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const controlsTimer = useRef<number | null>(null)
  const controlsPinned = drawer !== null

  const clearControlsTimer = useCallback(() => {
    if (controlsTimer.current !== null) {
      window.clearTimeout(controlsTimer.current)
      controlsTimer.current = null
    }
  }, [])

  const scheduleControlsHide = useCallback(() => {
    clearControlsTimer()
    if (controlsPinned) return
    controlsTimer.current = window.setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_DELAY_MS)
  }, [clearControlsTimer, controlsPinned])

  const revealControls = useCallback(() => {
    setControlsVisible(true)
    scheduleControlsHide()
  }, [scheduleControlsHide])

  useEffect(() => {
    if (controlsPinned) {
      clearControlsTimer()
      setControlsVisible(true)
    } else {
      scheduleControlsHide()
    }
    return clearControlsTimer
  }, [clearControlsTimer, controlsPinned, scheduleControlsHide])

  useEffect(() => {
    window.addEventListener("keydown", revealControls)
    return () => window.removeEventListener("keydown", revealControls)
  }, [revealControls])

  useEffect(() => {
    if (!seeking) setPosition(Math.min(Math.max(0, player.time || 0), duration || Infinity))
  }, [duration, player.time, seeking])

  useEffect(() => {
    if (!adjustingVolume) setVolume(Math.min(100, Math.max(0, player.volume || 0)))
  }, [adjustingVolume, player.volume])

  const hasMedia = Boolean(room?.source)
  const ready = state.connection === "ready"
  const sharedEnabled = ready && hasMedia && state.canControlSharedPlayback
  const lockReason = ready && hasMedia && !state.canControlSharedPlayback && room?.locked
    ? "房主已锁定，请从网页端控制"
    : null
  const localEnabled = player.loaded
  const subtitleTrack = player.subtitleTracks.find((track) => track.selected)
  const audioTrack = player.audioTracks.find((track) => track.selected)
  const showControls = controlsPinned || controlsVisible
  const expectedCurrentPlaylistItemId = room?.currentPlaylistItemId ?? null
  const canAdvance = mediaQueueAvailable && sharedEnabled && Boolean(room?.playlist.length)
  const overlayRight = drawer ? "min(340px, 42vw)" : "0px"

  const overlayClass = cn(
    "absolute inset-x-0 z-30 transition-opacity duration-200 ease-[var(--f2-ease-out)] motion-reduce:transition-none",
    showControls ? "opacity-100" : "pointer-events-none opacity-0",
  )
  const holdControls = {
    onPointerEnter: clearControlsTimer,
    onPointerLeave: scheduleControlsHide,
    onFocusCapture: clearControlsTimer,
    onBlurCapture: scheduleControlsHide,
  }

  return (
    <section
      className="media-scrim relative w-full min-w-0 overflow-hidden bg-transparent"
      onPointerMove={revealControls}
      onPointerDown={revealControls}
    >
      <div
        className={cn(
          "absolute inset-0 grid place-items-center overflow-hidden",
          player.loaded && state.playerWindowVisible ? "bg-transparent" : "bg-black",
        )}
      >
        {!player.loaded || !state.playerWindowVisible ? (
          <div className="pointer-events-none max-w-xl px-8 text-center">
            <MaterialSymbol name={state.playerWindowVisible ? "monitor" : "visibility-off"} className="mx-auto mb-4 size-8 text-[var(--text-disabled)]" />
            <h1 className="truncate text-2xl font-semibold">{mediaTitle(room?.source ?? null)}</h1>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">
              {!state.playerWindowVisible ? "播放画面已隐藏，会话仍保持。" : hasMedia ? "正在解析或载入媒体。" : "房间设置媒体后会在此处播放。"}
            </p>
          </div>
        ) : null}
      </div>

      <header style={{ right: overlayRight }} className={cn(overlayClass, "media-top-scrim top-0 px-4 pt-2.5 pb-14 transition-[opacity,right] duration-200 ease-[var(--f2-ease-out)] motion-reduce:transition-none")} {...holdControls}>
        <div className="pointer-events-none min-w-0 max-w-[calc(100%_-_6rem)]">
          <p className="truncate text-xs font-medium">{mediaTitle(room?.source ?? null)}</p>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 media-time">
            <span className="shrink-0">/{roomId ?? "room"}</span>
            <span className="media-dot shrink-0" data-state={ready ? "ready" : state.connection === "backoff" || state.connection === "connecting" ? "pending" : "error"} aria-hidden="true" />
            {ready ? <span className="sr-only">桌面会话连接正常</span> : <span className="truncate text-[var(--text-primary)]">{statusText}</span>}
          </div>
        </div>
      </header>

      {/* 窗口三键留在右上角（与其它页面的顶栏同一位置/同尺码），跟随悬浮控件一起收放。 */}
      <div
        className={cn("absolute right-0 top-0 z-40 transition-opacity duration-200 ease-[var(--f2-ease-out)] motion-reduce:transition-none", showControls ? "opacity-100" : "pointer-events-none opacity-0")}
        {...holdControls}
      >
        <WindowControls />
      </div>

      <footer style={{ right: overlayRight }} className={cn(overlayClass, "media-bottom-scrim bottom-0 space-y-2 px-4 pt-14 pb-4 transition-[opacity,right] duration-200 ease-[var(--f2-ease-out)] motion-reduce:transition-none")} {...holdControls}>
        <div className="flex items-center gap-2">
          <SharedControl reason={lockReason}>
            <span>
              <IconControl
                icon={room?.paused === false ? "pause" : "play-arrow"}
                label={room?.paused === false ? "暂停" : "播放"}
                disabled={!sharedEnabled}
                onClick={() => void command({ type: room?.paused === false ? "pause" : "play" })}
                className="big primary"
              />
            </span>
          </SharedControl>
          <SharedControl reason={lockReason}>
            <span>
              <IconControl
                icon="skip-next"
                label="下一项"
                disabled={!canAdvance}
                onClick={() => void command({ type: "playlistNext", expectedCurrentPlaylistItemId })}
              />
            </span>
          </SharedControl>
          <output className="media-time w-11 shrink-0">{formatTime(position)}</output>
          <Slider
            className="min-w-0 flex-1"
            aria-label="播放进度"
            min={0}
            max={Math.max(duration, 1)}
            step={0.1}
            value={[position]}
            title={formatTime(position)}
            disabled={!sharedEnabled || !localEnabled || duration <= 0}
            onValueChange={([value]) => {
              setSeeking(true)
              setPosition(value ?? 0)
            }}
            onValueCommit={([value]) => {
              setSeeking(false)
              if (value !== undefined) void command({ type: "seek", positionSeconds: value })
            }}
          />
          <output className="media-time w-11 shrink-0 text-right">{formatTime(duration)}</output>
        </div>

        <div className="media-control-row">
          <div className="media-control-group">
            <IconControl
              icon="volume-up"
              label={volume > 0 ? "静音" : "恢复音量"}
              disabled={!localEnabled}
              onClick={() => void command({ type: "volume", volume: volume > 0 ? 0 : 100 })}
            />
            <Slider
              aria-label="音量"
              size="compact"
              className="mr-2 w-[76px]"
              min={0}
              max={100}
              step={1}
              value={[volume]}
              disabled={!localEnabled}
              onValueChange={([value]) => {
                setAdjustingVolume(true)
                setVolume(value ?? 0)
              }}
              onValueCommit={([value]) => {
                setAdjustingVolume(false)
                if (value !== undefined) void command({ type: "volume", volume: value })
              }}
            />

          <span className="media-divider" aria-hidden="true" />

          <Select
            value={subtitleTrack ? String(subtitleTrack.id) : "off"}
            disabled={!localEnabled}
            onValueChange={(value) => void command({ type: "selectSubtitleTrack", trackId: value === "off" ? null : Number(value) })}
          >
            <SelectIconControl icon="subtitles" label="字幕" />
            <SelectContent>
              <SelectItem value="off">关闭字幕</SelectItem>
              {player.subtitleTracks.map((track) => <SelectItem key={track.id} value={String(track.id)}>{trackLabel(track)}</SelectItem>)}
            </SelectContent>
          </Select>

          <Select
            value={audioTrack ? String(audioTrack.id) : undefined}
            disabled={!localEnabled || player.audioTracks.length === 0}
            onValueChange={(value) => void command({ type: "selectAudioTrack", trackId: Number(value) })}
          >
            <SelectIconControl icon="music-note" label="音轨" />
            <SelectContent>
              {player.audioTracks.map((track) => <SelectItem key={track.id} value={String(track.id)}>{trackLabel(track)}</SelectItem>)}
            </SelectContent>
          </Select>

          <IconControl
            icon="sync"
            label="重新同步到房间进度"
            disabled={!localEnabled || !state.playerWindowVisible || !room}
            onClick={() => void command({ type: "resync" })}
          />

          <Select
            value={String(room?.playbackRate ?? 1)}
            disabled={!sharedEnabled}
            onValueChange={(value) => void command({ type: "rate", rate: Number(value) })}
          >
            <SelectTrigger className="media-icon label [&>svg:last-child]:hidden" title="倍速" aria-label="倍速">
              <GaugeRegular aria-hidden="true" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => <SelectItem key={rate} value={String(rate)}>{rate.toFixed(2)}x</SelectItem>)}
            </SelectContent>
          </Select>
          </div>
          <div className="media-control-group media-control-group-end">
            <IconControl icon="queue" label={`播放队列，${room?.playlist.length ?? 0} 项`} active={drawer === "queue"} disabled={!mediaQueueAvailable} onClick={() => onDrawerChange("queue")} />
            <IconControl icon="group" label={`在线成员，${state.members.length} 人`} active={drawer === "members"} onClick={() => onDrawerChange("members")} />
            <IconControl
              icon={fullscreen ? "fullscreen-exit" : "fullscreen"}
              label={fullscreen ? "退出全屏" : "全屏"}
              disabled={!localEnabled}
              onClick={() => {
                const next = !fullscreen
                void command({ type: "fullscreen", enabled: next }).then((ok) => {
                  if (ok) onFullscreenChange(next)
                })
              }}
            />
            <IconControl icon="add" label="添加媒体" onClick={onOpenMedia} />
            <IconControl icon="logout" label="离开房间" onClick={onLeave} />
          </div>
        </div>
      </footer>

      <RoomDrawer kind={drawer} state={state} command={command} onAdd={onOpenMedia} onClose={() => drawer && onDrawerChange(drawer)} />
    </section>
  )
}

function RoomDrawer({ kind, state, command, onAdd, onClose }: { kind: Drawer; state: DesktopUiState; command: (command: DesktopCommand) => Promise<boolean>; onAdd: () => void; onClose: () => void }) {
  return (
    <aside
      aria-hidden={!kind}
      inert={!kind}
      className={cn(
        "media-drawer absolute inset-y-0 right-0 z-40 w-[min(340px,42vw)] overflow-auto p-4 text-card-foreground transition-transform duration-200 ease-[var(--f2-ease-out)] motion-reduce:transition-none",
        kind ? "translate-x-0" : "pointer-events-none translate-x-full",
      )}
    >
      <div className="mb-2 flex min-h-11 items-center gap-2 border-b border-border pb-3">
        <h2 className="text-sm font-semibold">{kind === "members" ? `在线成员 ${state.members.length}` : `播放队列 ${state.room?.playlist.length ?? 0} 项`}</h2>
        <span className="flex-1" />
        {kind === "members" && state.isOwner ? (
          <Button variant="outline" size="sm" title={state.room?.locked ? "解锁房间" : "锁定房间（仅房主可控制）"} onClick={() => void command({ type: "lock", locked: !state.room?.locked })}>
            <MaterialSymbol name="lock" />{state.room?.locked ? "解锁" : "锁定"}
          </Button>
        ) : null}
        {kind === "queue" ? <Button variant="outline" size="sm" onClick={onAdd}><MaterialSymbol name="add" />添加媒体</Button> : null}
        <Button variant="ghost" size="icon" title="收起" aria-label="收起" onClick={onClose}><MaterialSymbol name="close" /></Button>
      </div>
      {kind === "queue" ? (
        state.room?.playlist.length ? state.room.playlist.map((item, index) => (
          <div key={item.id} className={cn("grid w-full grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2 rounded-sm border-b border-border px-1 py-3 text-xs", item.id === state.room?.currentPlaylistItemId && "bg-[var(--fill-selected)]")}>
            <button
              type="button"
              className="winui-focus grid w-full grid-cols-[30px_minmax(0,1fr)] gap-2 rounded-sm text-left disabled:cursor-default"
              disabled={!state.canControlSharedPlayback || item.id === state.room?.currentPlaylistItemId}
              onClick={() => void command({ type: "playlistPlay", itemId: item.id })}
            >
              <span className="font-mono text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
              <span className="min-w-0"><span className="block truncate">{mediaTitle(item.media)}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{item.id === state.room?.currentPlaylistItemId ? `正在播放 · ${formatTime(state.player.time)}` : `${state.members.find((member) => member.clientId === item.addedByClientId)?.name ?? "成员"} 添加`}</span></span>
            </button>
            {state.canControlSharedPlayback ? (
              <span className="flex items-center gap-0.5">
                <Button variant="ghost" size="icon" title="上移" aria-label={`上移 ${mediaTitle(item.media)}`} disabled={index === 0} onClick={() => void command({ type: "playlistMove", itemId: item.id, targetIndex: index - 1 })}><MaterialSymbol name="expand-less" /></Button>
                <Button variant="ghost" size="icon" title="下移" aria-label={`下移 ${mediaTitle(item.media)}`} disabled={index >= (state.room?.playlist.length ?? 0) - 1} onClick={() => void command({ type: "playlistMove", itemId: item.id, targetIndex: index + 1 })}><MaterialSymbol name="expand-more" /></Button>
                <Button variant="ghost" size="icon" title="移出队列" aria-label={`移出 ${mediaTitle(item.media)}`} onClick={() => void command({ type: "playlistRemove", itemId: item.id })}><MaterialSymbol name="close" /></Button>
              </span>
            ) : null}
          </div>
        )) : <p className="py-5 text-xs text-muted-foreground">播放队列为空。</p>
      ) : kind === "members" && state.members.length ? state.members.map((member) => (
        <div key={member.clientId} className="flex items-center gap-3 border-b border-border py-3 text-xs">
          <span className="grid size-8 place-items-center rounded-full border border-border font-semibold text-muted-foreground">{member.name.slice(0, 2).toUpperCase()}</span>
          <span className="min-w-0 flex-1 truncate">{member.name}{member.clientId === state.clientId ? <span className="ml-1 text-xs text-muted-foreground">（我）</span> : null}</span>
          {state.isOwner && !member.isOwner && member.clientType !== "mpv" ? (
            <Button variant="outline" size="sm" title={`将房主转让给 ${member.name}`} onClick={() => void command({ type: "transferOwner", targetClientId: member.clientId })}>转让房主</Button>
          ) : null}
          <span className="text-muted-foreground">{member.isOwner ? "房主" : member.clientType === "desktop" ? "桌面端" : "在线"}</span>
        </div>
      )) : kind === "members" ? <p className="py-5 text-xs text-muted-foreground">暂无在线成员。</p> : null}
    </aside>
  )
}
