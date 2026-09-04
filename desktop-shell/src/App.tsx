import { useEffect, useRef, useState, type ReactNode } from "react"

import { MaterialSymbol, type MaterialSymbolName } from "@/components/material-symbol"
import { RoomView } from "@/components/room-view"
import { SessionGate } from "@/components/session-gate"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useDesktopSession } from "@/hooks/use-desktop-session"
import type { ConnectionState, DesktopUiState, MediaSource, NativeCapabilityReport } from "@/lib/contracts"
import { cn } from "@/lib/utils"

type View = "home" | "room" | "media" | "settings"
type Drawer = "queue" | "members" | null
type Theme = "dark" | "light"
type SettingsSection = "general" | "playback" | "credentials" | "network"

const THEME_KEY = "watchparty-theme"
const BACKEND_LABEL = "127.0.0.1:8080"

function initialTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"
}

function connectionLabel(connection?: ConnectionState): string {
  switch (connection) {
    case "connecting": return "正在连接"
    case "ready": return "已连接"
    case "backoff": return "网络重试中"
    case "expired": return "会话已过期"
    case "failed": return "连接失败"
    default: return "等待加入"
  }
}

function capabilityLabel(capability?: NativeCapabilityReport): string {
  if (!capability?.libmpvReady) return "libmpv 等待初始化"
  return [capability.vo, capability.hwdec, capability.videoCodec, capability.audioCodec]
    .filter(Boolean)
    .join(" · ") || "libmpv 已就绪"
}

function connectionTone(connection?: ConnectionState): string {
  if (connection === "ready") return "bg-positive"
  if (connection === "backoff") return "bg-warning"
  if (connection === "expired" || connection === "failed") return "bg-destructive"
  return "bg-muted-foreground"
}

function mediaTitle(source: MediaSource | null | undefined): string {
  if (!source) return "等待房间媒体"
  if (source.kind === "openlist") return source.title
  return source.title || (source.kind === "youtube" ? source.videoId : "在线媒体")
}

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

export default function App() {
  const session = useDesktopSession()
  const [view, setView] = useState<View>("home")
  const [drawer, setDrawer] = useState<Drawer>(null)
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [fullscreen, setFullscreen] = useState(false)
  const suspendedForNavigation = useRef(false)
  const previouslyConnected = useRef(false)
  const state = session.state
  // The joined room comes from the native session itself; the deep-link hint is
  // only a fallback before any session exists.
  const activeRoomId = state?.roomId ?? session.launchRoomId
  const isPlaybackView = Boolean(state) && view === "room"

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")
    document.documentElement.classList.toggle("playback-mode", isPlaybackView)
    document.documentElement.style.colorScheme = theme
    localStorage.setItem(THEME_KEY, theme)
    return () => document.documentElement.classList.remove("playback-mode")
  }, [isPlaybackView, theme])

  useEffect(() => {
    if (state && !previouslyConnected.current) setView("room")
    previouslyConnected.current = Boolean(state)
  }, [state])

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && fullscreen) {
        void session.command({ type: "fullscreen", enabled: false }).then((ok) => {
          if (ok) setFullscreen(false)
        })
      }
    }
    window.addEventListener("keydown", handleEscape)
    return () => window.removeEventListener("keydown", handleEscape)
  }, [fullscreen, session.command])

  async function navigate(nextView: View) {
    if (nextView !== "room" && state?.playerWindowVisible) {
      suspendedForNavigation.current = await session.command({ type: "playerVisibility", visible: false })
    } else if (nextView === "room" && suspendedForNavigation.current) {
      if (await session.command({ type: "playerVisibility", visible: true })) suspendedForNavigation.current = false
    }
    setView(nextView)
    setDrawer(null)
  }

  async function openRoomDrawer(nextDrawer: Exclude<Drawer, null>) {
    await navigate("room")
    setDrawer(nextDrawer)
  }

  async function leaveRoom() {
    if (await session.stop()) {
      setFullscreen(false)
      setDrawer(null)
      setView("home")
    }
  }

  return (
    <TooltipProvider>
      {isPlaybackView && state ? (
        <RoomView
          state={state}
          roomId={activeRoomId}
          drawer={drawer}
          command={session.command}
          fullscreen={fullscreen}
          statusText={session.status.text}
          onFullscreenChange={setFullscreen}
          onDrawerChange={(nextDrawer) => setDrawer((current) => current === nextDrawer ? null : nextDrawer)}
          onOpenMedia={() => void navigate("media")}
          onLeave={() => void leaveRoom()}
        />
      ) : (
        <div className="desktop-shell-surface grid h-screen min-w-[760px] grid-cols-[232px_minmax(0,1fr)] text-foreground">
          <Sidebar
            view={view}
            state={state}
            roomId={activeRoomId}
            status={session.status}
            onView={(nextView) => void navigate(nextView)}
            onDrawer={(nextDrawer) => void openRoomDrawer(nextDrawer)}
          />
          <main className="min-h-0 min-w-0 overflow-auto">
            {view === "home" || view === "room" ? (
              <HomeView
                state={state}
                roomId={activeRoomId}
                starting={session.starting}
                onStart={session.start}
                onReturn={() => void navigate("room")}
              />
            ) : view === "media" ? (
              <MediaLibraryView />
            ) : (
              <SettingsView
                state={state}
                theme={theme}
                onThemeChange={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              />
            )}
          </main>
        </div>
      )}

      {state && (state.connection === "expired" || state.connection === "failed") ? (
        <TerminalOverlay state={state} onLeave={() => void leaveRoom()} />
      ) : null}
    </TooltipProvider>
  )
}

function Sidebar({ view, state, roomId, status, onView, onDrawer }: {
  view: View
  state: ReturnType<typeof useDesktopSession>["state"]
  roomId: string | null
  status: ReturnType<typeof useDesktopSession>["status"]
  onView: (view: View) => void
  onDrawer: (drawer: Exclude<Drawer, null>) => void
}) {
  return (
    <aside className="flex min-h-0 flex-col border-r border-border/80 bg-card/76 px-3 py-4">
      <div className="px-2 pb-4">
        <strong className="text-[15px] tracking-tight">Watch<span className="text-primary">Party</span></strong>
        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{roomId ? `/${roomId}` : "原生桌面播放器"}</p>
      </div>

      <div className="relative mb-3">
        <MaterialSymbol name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label="搜索或输入房号，尚未开放" title="智能入口将在后续原生 IPC 完成后开放" disabled placeholder="搜索或输入房号…" className="h-8 border-border/80 bg-background/55 pl-9 text-xs disabled:opacity-75" />
      </div>

      <nav className="space-y-0.5" aria-label="桌面端导航">
        <NavButton icon="home" label="首页" active={view === "home"} onClick={() => onView("home")} />
        <NavButton icon="monitor" label="房间" active={view === "room"} disabled={!state} onClick={() => onView("room")} />
        <NavButton icon="queue" label="队列" disabled={!state} onClick={() => onDrawer("queue")} />
        <NavButton icon="group" label="成员" disabled={!state} onClick={() => onDrawer("members")} />
      </nav>

      <div className="mt-auto space-y-0.5">
        <NavButton icon="library" label="媒体库" active={view === "media"} onClick={() => onView("media")} />
        <NavButton icon="settings" label="设置" active={view === "settings"} onClick={() => onView("settings")} />
        <div className="mt-3 border-t border-border/80 px-2 pt-3 text-[10px] leading-4 text-muted-foreground">
          <p className="flex items-center gap-2"><i className={cn("size-1.5 rounded-full", connectionTone(state?.connection))} />后端 {BACKEND_LABEL} · {connectionLabel(state?.connection)}</p>
          <p className={cn("mt-1 truncate", status.tone === "warning" && "text-warning", status.tone === "error" && "text-destructive")}>{status.text}</p>
          <p className="truncate font-mono">{capabilityLabel(state?.capability)}</p>
        </div>
      </div>
    </aside>
  )
}

function NavButton({ icon, label, active, disabled, onClick }: { icon: MaterialSymbolName; label: string; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <Button className={cn("relative h-9 w-full justify-start rounded-md px-3 text-xs", active && "bg-accent text-foreground before:absolute before:left-0 before:h-4 before:w-[3px] before:rounded-full before:bg-primary hover:bg-accent")} variant="ghost" disabled={disabled} onClick={onClick}>
      <MaterialSymbol name={icon} />{label}
    </Button>
  )
}

function SectionTitle({ children, detail }: { children: string; detail: string }) {
  return <h1 className="text-sm font-semibold text-foreground">{children}<span className="ml-2 text-xs font-normal text-muted-foreground">{detail}</span></h1>
}

function HomeView({ state, roomId, starting, onStart, onReturn }: { state: ReturnType<typeof useDesktopSession>["state"]; roomId: string | null; starting: boolean; onStart: (ticket: string) => Promise<boolean>; onReturn: () => void }) {
  const room = state?.room
  return (
    <div className="mx-auto min-h-full w-full max-w-[1040px] px-8 py-8">
      <SectionTitle detail={state ? "房间仍存活" : "等待网页交接"}>继续观看</SectionTitle>
      {state ? (
        <section className="mt-3 flex items-center gap-3 rounded-lg border border-border bg-card/72 px-4 py-3">
          <i className="size-2 rounded-full bg-positive" />
          <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground"><span className="font-mono text-foreground">{roomId ?? "room"}</span><span className="mx-2">·</span><span className="text-foreground">{mediaTitle(room?.source)}</span><span className="mx-2">·</span><span className="font-mono">{formatTime(state.player.time)} / {formatTime(state.player.duration)}</span></div>
          <Button size="sm" onClick={onReturn}>返回房间</Button>
        </section>
      ) : <p className="mt-3 text-xs text-muted-foreground">尚未连接房间。请从网页端生成一次性交接码。</p>}
      {!state ? <SessionGate roomId={roomId} starting={starting} onStart={onStart} /> : (
        <div className="mt-5 flex max-w-[680px] gap-2"><Input disabled value={`watchparty://${roomId ?? "room"}`} aria-label="当前房间地址" className="h-9 font-mono text-xs disabled:opacity-75" /><Button variant="outline" disabled>加入或开播</Button></div>
      )}
      <div className="mt-8"><SectionTitle detail="本地历史尚未接入">最近播放</SectionTitle><EmptyPosterGrid label="暂无播放记录" /></div>
    </div>
  )
}

function EmptyPosterGrid({ label }: { label: string }) {
  return (
    <div className="mt-3 grid grid-cols-5 gap-3" aria-label={label}>
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="min-w-0"><div className="grid aspect-[16/10] place-items-center rounded-lg border border-border/80 bg-card/48 text-center text-[11px] text-muted-foreground">{index === 0 ? label : null}</div><div className="mt-2 h-2.5 w-3/4 rounded-sm bg-muted/60" aria-hidden="true" /><div className="mt-1.5 h-2 w-1/2 rounded-sm bg-muted/35" aria-hidden="true" /></div>
      ))}
    </div>
  )
}

function MediaLibraryView() {
  return (
    <div className="mx-auto min-h-full w-full max-w-[1120px] px-8 py-8">
      <header className="flex items-center gap-3"><SectionTitle detail="OpenList · 原生浏览 IPC 尚未接入">媒体库</SectionTitle><div className="flex-1" />
        {["全部", "Anime", "Film", "TV Shows"].map((root, index) => <Button key={root} size="sm" variant={index === 0 ? "default" : "ghost"} disabled className="h-7 rounded-full px-3 text-[11px] disabled:opacity-70">{root}</Button>)}
        <div className="relative w-56"><MaterialSymbol name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" /><Input disabled placeholder="搜索标题…" aria-label="搜索媒体，尚未开放" className="h-8 pl-9 text-xs disabled:opacity-75" /></div>
      </header>
      <EmptyPosterGrid label="媒体目录尚未载入" />
      <p className="mt-4 font-mono text-[10px] text-muted-foreground">0 项 · 排序：最近添加 · 等待受限 Rust 媒体浏览接口</p>
    </div>
  )
}

function SettingsView({ state, theme, onThemeChange }: { state: DesktopUiState | null; theme: Theme; onThemeChange: () => void }) {
  const [section, setSection] = useState<SettingsSection>("credentials")
  const labels: Array<[SettingsSection, string]> = [["general", "通用"], ["playback", "播放"], ["credentials", "站点凭据"], ["network", "后端与网络"]]
  return (
    <div className="grid min-h-full grid-cols-[172px_minmax(0,1fr)]">
      <nav className="border-r border-border/80 bg-card/36 px-3 py-8" aria-label="设置分类">{labels.map(([value, label]) => <Button key={value} variant="ghost" onClick={() => setSection(value)} className={cn("relative h-9 w-full justify-start px-3 text-xs", section === value && "bg-accent text-foreground before:absolute before:left-0 before:h-4 before:w-[3px] before:rounded-full before:bg-primary")}>{label}</Button>)}</nav>
      <section className="w-full max-w-[680px] px-8 py-8">
        {section === "credentials" ? <CredentialsPanel /> : null}
        {section === "general" ? <GeneralPanel theme={theme} onThemeChange={onThemeChange} /> : null}
        {section === "playback" ? <PlaybackPanel state={state} /> : null}
        {section === "network" ? <NetworkPanel state={state} /> : null}
      </section>
    </div>
  )
}

function SettingsHeading({ title, detail }: { title: string; detail: string }) {
  return <div className="mb-5"><h1 className="text-sm font-semibold">{title}</h1><p className="mt-1 text-xs text-muted-foreground">{detail}</p></div>
}

function CredentialsPanel() {
  return <><SettingsHeading title="站点凭据" detail="凭据必须由 Rust 写入系统凭据库，WebView 永不持有。" /><div className="divide-y divide-border border-y border-border"><SettingRow icon="shield" title="站点用户名" detail="Caddy Basic Auth，随请求由 Rust 侧注入"><Input disabled placeholder="尚未配置" className="w-44 text-xs disabled:opacity-75" /></SettingRow><SettingRow icon="lock" title="站点密码" detail="保存后不可从界面读回"><Input disabled type="password" placeholder="••••••••••••" className="w-44 text-xs disabled:opacity-75" /></SettingRow></div><div className="mt-5 flex gap-2"><Button disabled>保存到系统凭据库</Button><Button variant="outline" disabled>清除</Button></div><p className="mt-3 text-xs text-muted-foreground">原生凭据录入 IPC 尚未实现，控件保持禁用。</p></>
}

function GeneralPanel({ theme, onThemeChange }: { theme: Theme; onThemeChange: () => void }) {
  return <><SettingsHeading title="通用" detail="调整桌面端的外观行为。" /><div className="border-y border-border"><SettingRow icon={theme === "dark" ? "dark-mode" : "light-mode"} title="主题" detail="纯黑深色 / 浅色"><Button variant="outline" size="sm" onClick={onThemeChange}>{theme === "dark" ? "切换浅色" : "切换深色"}</Button></SettingRow></div></>
}

function PlaybackPanel({ state }: { state: DesktopUiState | null }) {
  return <><SettingsHeading title="播放" detail="当前原生解码器状态，只读。" /><div className="divide-y divide-border border-y border-border"><SettingRow icon="monitor" title="视频输出" detail="libmpv Render API"><span className="font-mono text-xs text-muted-foreground">{state?.capability.vo ?? "等待初始化"}</span></SettingRow><SettingRow icon="speed" title="硬件解码" detail="安全自动选择"><span className="font-mono text-xs text-muted-foreground">{state?.capability.hwdec ?? state?.capability.hwdecConfigured ?? "auto-safe"}</span></SettingRow></div></>
}

function NetworkPanel({ state }: { state: DesktopUiState | null }) {
  return <><SettingsHeading title="后端与网络" detail="后端地址属于原生配置，不允许 WebView 任意覆盖。" /><div className="border-y border-border"><SettingRow icon="sync" title="本地开发后端" detail={connectionLabel(state?.connection)}><span className="font-mono text-xs text-muted-foreground">http://{BACKEND_LABEL}</span></SettingRow></div></>
}

function SettingRow({ icon, title, detail, children }: { icon: MaterialSymbolName; title: string; detail: string; children: ReactNode }) {
  return <div className="flex min-h-16 items-center gap-3 py-3"><MaterialSymbol name={icon} className="size-5 text-muted-foreground" /><div className="min-w-0 flex-1"><h2 className="text-xs font-medium">{title}</h2><p className="mt-1 text-[11px] text-muted-foreground">{detail}</p></div>{children}</div>
}

function TerminalOverlay({ state, onLeave }: { state: DesktopUiState; onLeave: () => void }) {
  return <section className="fixed inset-0 z-50 grid place-items-center bg-black/86 px-6" aria-live="assertive"><div className="w-full max-w-lg border border-border bg-card p-7"><p className="mb-2 font-mono text-xs text-primary">{state.error?.code ?? "DESKTOP_SESSION_FAILED"}</p><h1 className="text-2xl font-semibold">{state.connection === "expired" ? "桌面会话已过期" : "桌面会话不可用"}</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">{state.error?.message ?? "请返回网页房间重新生成一次性交接码。"}</p><Button className="mt-6" onClick={onLeave}>重新加入</Button></div></section>
}
