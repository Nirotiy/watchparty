import { useCallback, useEffect, useRef, useState } from "react"
import type { ReactElement } from "react"

import { MaterialSymbol, type MaterialSymbolName } from "@/components/material-symbol"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { DesktopCommand, DesktopUiState, MediaSource, Track } from "@/lib/contracts"
import { cn } from "@/lib/utils"

type Drawer = "queue" | "members" | null

interface RoomViewProps {
  state: DesktopUiState
  roomId: string | null
  drawer: Drawer
  command: (command: DesktopCommand) => Promise<boolean>
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
          size="icon-sm"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "text-white/75 hover:bg-white/12 hover:text-white [&_svg]:size-5",
            active && "bg-white/12 text-primary",
            className,
          )}
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
          className="size-8 shrink-0 justify-center border-0 bg-transparent px-0 text-white/75 hover:bg-white/12 hover:text-white data-[state=open]:bg-white/12 data-[state=open]:text-white [&>svg:last-child]:hidden [&_svg]:size-5"
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

export function RoomView({
  state,
  roomId,
  drawer,
  command,
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
  const canAdvance = sharedEnabled && Boolean(room?.playlist.length)
  const overlayRight = drawer ? "min(340px, 42vw)" : "0px"

  const overlayClass = cn(
    "absolute inset-x-0 z-30 text-white transition-opacity duration-150 ease-out motion-reduce:transition-none",
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
      className="relative h-screen min-w-[640px] overflow-hidden bg-transparent text-white"
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
            <MaterialSymbol name={state.playerWindowVisible ? "monitor" : "visibility-off"} className="mx-auto mb-4 size-8 text-white/45" />
            <h1 className="truncate text-2xl font-semibold tracking-tight">{mediaTitle(room?.source ?? null)}</h1>
            <p className="mt-2 text-sm text-white/55">
              {!state.playerWindowVisible ? "播放画面已隐藏，会话仍保持。" : hasMedia ? "正在解析或载入媒体。" : "房间设置媒体后会在此处播放。"}
            </p>
          </div>
        ) : null}
      </div>

      <header style={{ right: overlayRight }} className={cn(overlayClass, "top-0 bg-gradient-to-b from-black/78 via-black/38 to-transparent px-4 pt-2.5 pb-14 transition-[opacity,right] duration-150 ease-out motion-reduce:transition-none")} {...holdControls}>
        <div className="pointer-events-none min-w-0 max-w-[calc(100%_-_6rem)] [text-shadow:_0_1px_3px_rgb(0_0_0_/_80%)]">
          <p className="truncate text-xs font-medium text-white/90">{mediaTitle(room?.source ?? null)}</p>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-white/60">
            <span className="shrink-0">/{roomId ?? "room"}</span>
            <span className={cn("size-1.5 shrink-0 rounded-full", ready ? "bg-emerald-400" : state.connection === "backoff" || state.connection === "connecting" ? "bg-amber-400" : "bg-rose-500")} aria-hidden="true" />
            {ready ? <span className="sr-only">桌面会话连接正常</span> : <span className="truncate text-white/80">{statusText}</span>}
          </div>
        </div>
        <div className="absolute right-4 top-2.5 flex items-center gap-1">
          <IconControl icon="queue" label={`播放队列，${room?.playlist.length ?? 0} 项`} active={drawer === "queue"} onClick={() => onDrawerChange("queue")} />
          <IconControl icon="group" label={`在线成员，${state.members.length} 人`} active={drawer === "members"} onClick={() => onDrawerChange("members")} />
        </div>
      </header>

      <footer style={{ right: overlayRight }} className={cn(overlayClass, "bottom-0 space-y-2 bg-gradient-to-t from-black/90 via-black/65 to-transparent px-4 pt-14 pb-4 transition-[opacity,right] duration-150 ease-out motion-reduce:transition-none")} {...holdControls}>
        <div className="flex items-center gap-2">
          <SharedControl reason={lockReason}>
            <span>
              <IconControl
                icon={room?.paused === false ? "pause" : "play-arrow"}
                label={room?.paused === false ? "暂停" : "播放"}
                disabled={!sharedEnabled}
                onClick={() => void command({ type: room?.paused === false ? "pause" : "play" })}
                className="text-white [&_svg]:size-7"
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
          <output className="w-11 shrink-0 font-mono text-[11px] text-white/75">{formatTime(position)}</output>
          <Slider
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
          <output className="w-11 shrink-0 text-right font-mono text-[11px] text-white/75">{formatTime(duration)}</output>
        </div>

        <div className="flex items-center gap-1.5">
          <IconControl
            icon="volume-up"
            label={volume > 0 ? "静音" : "恢复音量"}
            disabled={!localEnabled}
            onClick={() => void command({ type: "volume", volume: volume > 0 ? 0 : 100 })}
          />
          <Slider
            aria-label="音量"
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

          <span className="mx-1 h-5 w-px bg-white/15" aria-hidden="true" />

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
            <SelectTrigger className="h-8 w-auto gap-1 border-0 bg-transparent px-2 font-mono text-[11px] text-white/80 hover:bg-white/12 hover:text-white [&>svg:last-child]:hidden" title="倍速" aria-label="倍速">
              <MaterialSymbol name="speed" className="size-5" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => <SelectItem key={rate} value={String(rate)}>{rate.toFixed(2)}x</SelectItem>)}
            </SelectContent>
          </Select>

          <span className="flex-1" />
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
        "absolute inset-y-0 right-0 z-40 w-[min(340px,42vw)] overflow-auto border-l border-white/12 bg-[rgba(13,14,16,.97)] p-4 text-card-foreground shadow-[-8px_0_8px_rgb(0_0_0_/_35%)] transition-transform duration-150 ease-out motion-reduce:transition-none",
        kind ? "translate-x-0" : "pointer-events-none translate-x-full",
      )}
    >
      <div className="mb-2 flex items-center gap-2 border-b border-border pb-3">
        <h2 className="text-sm font-semibold">{kind === "members" ? `在线成员 ${state.members.length}` : `播放队列 ${state.room?.playlist.length ?? 0} 项`}</h2>
        <span className="flex-1" />
        {kind === "queue" ? <Button variant="outline" size="sm" className="h-7 px-2.5 text-[11px]" onClick={onAdd}><MaterialSymbol name="add" />添加媒体</Button> : null}
        <Button variant="ghost" size="icon-sm" title="收起" aria-label="收起" onClick={onClose}>×</Button>
      </div>
      {kind === "queue" ? (
        state.room?.playlist.length ? state.room.playlist.map((item, index) => (
          <button
            type="button"
            key={item.id}
            className={cn("grid w-full grid-cols-[30px_minmax(0,1fr)] gap-2 border-b border-border px-1 py-3 text-left text-xs hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent", item.id === state.room?.currentPlaylistItemId && "bg-primary/8 text-primary")}
            disabled={!state.canControlSharedPlayback || item.id === state.room?.currentPlaylistItemId}
            onClick={() => void command({ type: "playlistPlay", itemId: item.id })}
          >
            <span className="font-mono text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
            <span className="min-w-0"><span className="block truncate">{mediaTitle(item.media)}</span><span className="mt-1 block truncate text-[10px] text-muted-foreground">{item.id === state.room?.currentPlaylistItemId ? `正在播放 · ${formatTime(state.player.time)}` : `${state.members.find((member) => member.clientId === item.addedByClientId)?.name ?? "成员"} 添加`}</span></span>
          </button>
        )) : <p className="py-5 text-xs text-muted-foreground">播放队列为空。</p>
      ) : kind === "members" && state.members.length ? state.members.map((member) => (
        <div key={member.clientId} className="flex items-center gap-3 border-b border-border py-3 text-xs">
          <span className="grid size-8 place-items-center rounded-full border border-border font-semibold text-muted-foreground">{member.name.slice(0, 2).toUpperCase()}</span>
          <span className="min-w-0 flex-1 truncate">{member.name}</span>
          <span className="text-muted-foreground">{member.isOwner ? "房主" : member.clientType === "desktop" ? "桌面端" : "在线"}</span>
        </div>
      )) : kind === "members" ? <p className="py-5 text-xs text-muted-foreground">暂无在线成员。</p> : null}
    </aside>
  )
}
