import { useEffect, useRef, useState, useCallback, type ReactNode } from "react"

import { MaterialSymbol, type MaterialSymbolName } from "@/components/material-symbol"
import { RoomView } from "@/components/room-view"
import { SessionGate } from "@/components/session-gate"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useDesktopSession } from "@/hooks/use-desktop-session"
import type { CommandAck, ConnectionState, DesktopCommand, DesktopUiState, MediaDirectoryItem, MediaDirectoryPage, MediaSource, NativeCapabilityReport } from "@/lib/contracts"
import { cn } from "@/lib/utils"
import { createDefaultLocalSettings, migrateLocalSettings } from "../shared/local-schema"
import { MusicPartyAdapter, type MusicSearchResult } from "../shared/musicparty-adapter"
import { NativeAudioPlayer } from "../shared/native-audio-player"
import { AudioFocusOwner } from "../shared/player"
import { invoke } from "@tauri-apps/api/core"
import { clearSiteCredentials, errorMessage, getDesktopSettings, listenForSettings, mediaList, mediaRoots, mediaSearch, promptSiteCredentials, updateDesktopSettings, verifyBackend, verifyPrivateRoom, logoutMusicParty, listOriginTrust, importOriginTrust, deleteOriginTrust, type DesktopSettingsStatus, type PlayerPreferences, type OriginTrustRecord } from "@/lib/ipc"

type View = "home" | "room" | "media" | "settings"
type Drawer = "queue" | "members" | null
type Theme = "dark" | "light"
type SettingsSection = "general" | "playback" | "credentials" | "network" | "security"

const BACKEND_LABEL = "127.0.0.1:8080"

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
  const [product, setProduct] = useState<"watchparty" | "musicparty">("watchparty")
  const [drawer, setDrawer] = useState<Drawer>(null)
  const [theme, setTheme] = useState<Theme>("dark")
  const [backendOrigin, setBackendOrigin] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    const apply = (settings: DesktopSettingsStatus) => {
      if (!disposed) { setTheme(settings.theme); setBackendOrigin(settings.backendOrigin) }
    }
    void listenForSettings(apply).then(async (stop) => {
      if (disposed) { stop(); return }
      unlisten = stop
      apply(await getDesktopSettings())
    }).catch(() => session.setStatus({ text: "无法读取桌面设置", tone: "error" }))
    return () => { disposed = true; unlisten?.() }
  }, [session.setStatus])
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
    return () => document.documentElement.classList.remove("playback-mode")
  }, [isPlaybackView, theme])

  useEffect(() => {
    if (state && !previouslyConnected.current) setView("room")
    if (!state && previouslyConnected.current) {
      setDrawer(null)
      setFullscreen(false)
      suspendedForNavigation.current = false
      setView((current) => current === "room" ? "home" : current)
    }
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
            backendOrigin={backendOrigin}
            product={product}
            onProduct={setProduct}
            view={view}
            state={state}
            roomId={activeRoomId}
            status={session.status}
            onView={(nextView) => void navigate(nextView)}
            onDrawer={(nextDrawer) => void openRoomDrawer(nextDrawer)}
          />
          <main className="min-h-0 min-w-0 overflow-auto">
            {product === "musicparty" && view !== "settings" ? <MusicPartyEntry /> : view === "home" || view === "room" ? (
              <HomeView
                state={state}
                roomId={activeRoomId}
                starting={session.starting}
                onStart={session.start}
                onCreate={session.createRoom}
                onAccess={session.accessRoom}
                onReturn={() => void navigate("room")}
                onProduct={setProduct}
              />
            ) : view === "media" ? (
              <MediaLibraryView state={state} command={session.command} navigate={(nextView) => void navigate(nextView)} />
            ) : (
              <SettingsView
                state={state}
                theme={theme}
                onThemeChange={() => { void persistTheme(theme, setTheme).catch((error: unknown) => session.setStatus({ text: errorMessage(error, "主题保存失败"), tone: "error" })) }}
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

function Sidebar({ view, state, roomId, status, onView, onDrawer, backendOrigin, product, onProduct }: {
  backendOrigin: string | null
  product: "watchparty" | "musicparty"
  onProduct: (product: "watchparty" | "musicparty") => void
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
        <strong className="text-[15px] tracking-tight">Banguru</strong>
        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{roomId ? `/${roomId}` : "Watch Party · 原生桌面播放器"}</p>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-1 border-b border-border/80 pb-2"><Button size="sm" variant="ghost" className={cn("rounded-md text-xs", product === "watchparty" && "bg-accent text-foreground") } onClick={() => onProduct("watchparty")}>Banguru</Button><Button size="sm" variant="ghost" className={cn("rounded-md text-xs", product === "musicparty" && "bg-accent text-foreground") } onClick={() => onProduct("musicparty")}>Linkle</Button></div>

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
          <p className="flex items-center gap-2"><i className={cn("size-1.5 rounded-full", connectionTone(state?.connection))} /><span className="truncate">{backendOrigin ?? "站点未配置"} · {connectionLabel(state?.connection)}</span></p>
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

function HomeView({ state, roomId, starting, onStart, onCreate, onAccess, onReturn, onProduct }: { state: ReturnType<typeof useDesktopSession>["state"]; roomId: string | null; starting: boolean; onStart: (ticket: string) => Promise<boolean>; onCreate: (nickname: string, pin?: string) => Promise<boolean>; onAccess: (roomId: string, nickname: string, pin?: string) => Promise<boolean>; onReturn: () => void; onProduct: (product: "watchparty" | "musicparty") => void }) {
  const room = state?.room
  const [nickname, setNickname] = useState("")
  const [pin, setPin] = useState("")
  const [joinRoomId, setJoinRoomId] = useState("")
  return (
    <div className="mx-auto min-h-full w-full max-w-[1040px] px-8 py-8">
      <div className="mb-6 border-b border-border/80 pb-4"><div className="flex items-center justify-between"><div><p className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary">Banguru · Watch Party</p><SectionTitle detail={state ? "房间仍存活" : "等待网页交接"}>房间工作台</SectionTitle></div><span className="text-[11px] text-muted-foreground">桌面端 · Fluent</span></div><div className="mt-4 inline-grid grid-cols-2 border border-border/80 bg-card/40 p-0.5" role="tablist" aria-label="Banguru 模式切换"><button type="button" role="tab" aria-selected="true" className="border-b-2 border-primary px-4 py-2 text-xs font-medium text-foreground">Banguru <span className="ml-1 text-[10px] text-muted-foreground">Watch Party</span></button><button type="button" role="tab" aria-selected="false" className="px-4 py-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => onProduct("musicparty")}>Linkle <span className="ml-1 text-[10px]">Music Party</span></button></div></div>
      {state ? (
        <section className="mt-3 flex items-center gap-3 rounded-lg border border-border bg-card/72 px-4 py-3">
          <i className="size-2 rounded-full bg-positive" />
          <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground"><span className="font-mono text-foreground">{roomId ?? "room"}</span><span className="mx-2">·</span><span className="text-foreground">{mediaTitle(room?.source)}</span><span className="mx-2">·</span><span className="font-mono">{formatTime(state.player.time)} / {formatTime(state.player.duration)}</span></div>
          <Button size="sm" onClick={onReturn}>返回房间</Button>
        </section>
      ) : <p className="mt-3 text-xs text-muted-foreground">尚未连接房间。请从网页端生成一次性交接码。</p>}
      {!state ? <>
        <SessionGate roomId={roomId} starting={starting} onStart={onStart} />
        <section className="mt-5 max-w-[680px] border-y border-border/80 py-4">
          <p className="text-xs font-semibold">独立桌面会话</p>
          <p className="mt-1 text-[11px] text-muted-foreground">桌面端直接建房或输入房号加入，令牌只保存在本机凭据库。</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="昵称" aria-label="桌面昵称" className="h-9 text-xs" />
            <Input value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="PIN（可选，4 位）" inputMode="numeric" aria-label="房间 PIN" className="h-9 text-xs" />
            <Input value={joinRoomId} onChange={(event) => setJoinRoomId(event.target.value.trim())} placeholder="房号，例如 room-abc123" aria-label="要加入的房号" className="h-9 text-xs sm:col-span-2" />
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" disabled={starting || !nickname.trim() || Boolean(pin && pin.length !== 4)} onClick={() => void onCreate(nickname.trim(), pin || undefined)}>创建房间</Button>
            <Button size="sm" variant="outline" disabled={starting || !joinRoomId || !nickname.trim() || Boolean(pin && pin.length !== 4)} onClick={() => void onAccess(joinRoomId, nickname.trim(), pin || undefined)}>加入房间</Button>
          </div>
        </section>
      </> : (
        <div className="mt-5 flex max-w-[680px] gap-2"><Input disabled value={`watchparty://${roomId ?? "room"}`} aria-label="当前房间地址" className="h-9 font-mono text-xs disabled:opacity-75" /><Button variant="outline" disabled>加入或开播</Button></div>
      )}
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <section className="border-y border-border/80 py-4"><SectionTitle detail="当前连接状态">服务与房间</SectionTitle><div className="mt-3 space-y-2 text-xs text-muted-foreground"><p className="flex justify-between"><span>房间</span><span className="font-mono text-foreground">{roomId ?? "未加入"}</span></p><p className="flex justify-between"><span>播放会话</span><span className="text-foreground">{state ? "可恢复" : "等待连接"}</span></p><p className="flex justify-between"><span>队列</span><span className="text-foreground">{state ? "房间队列已同步" : "等待加入房间"}</span></p></div></section>
        <section className="border-y border-border/80 py-4"><SectionTitle detail="需要进入房间后可用">协作摘要</SectionTitle><div className="mt-3 space-y-2 text-xs text-muted-foreground"><p className="flex justify-between"><span>成员</span><span className="text-foreground">{state ? "在线成员已同步" : "尚未连接"}</span></p><p className="flex justify-between"><span>播放队列</span><span className="text-foreground">{state ? "打开房间查看" : "等待加入房间"}</span></p><Button size="sm" variant="outline" className="mt-2" disabled={!state} onClick={onReturn}>打开播放房间</Button></div></section>
      </div>
    </div>
  )
}

function MusicPartyEntry() {
  const [origin, setOrigin] = useState(() => {
    try { return migrateLocalSettings(JSON.parse(localStorage.getItem("watchparty.local-settings") ?? "null")).services.find((service) => service.product === "musicparty")?.origin ?? "http://localhost:18081" } catch { return "http://localhost:18081" }
  })
  const [invite, setInvite] = useState("")
  const [message, setMessage] = useState("")
  const [backendOrigin, setBackendOrigin] = useState<string | null>(null)
  useEffect(() => { void getDesktopSettings().then((s) => setBackendOrigin(s.backendOrigin)).catch(() => setMessage("请先配置后端站点")) }, [])
  const [connection, setConnection] = useState("未连接")
  const [roomStatus, setRoomStatus] = useState("未进入房间")
  const [queueCount, setQueueCount] = useState(0)
  const [queueTitles, setQueueTitles] = useState<string[]>([])
  const [playing, setPlaying] = useState(false)
  const adapterRef = useRef<MusicPartyAdapter | null>(null)
  const playerRef = useRef<NativeAudioPlayer | null>(null)
  const focusOwner = useRef(new AudioFocusOwner())
  useEffect(() => () => { void focusOwner.current.release("musicparty"); void playerRef.current?.dispose() }, [])
  useEffect(() => () => { void adapterRef.current?.disconnect() }, [])
  const connect = async () => {
    const adapter = new MusicPartyAdapter({ origin: origin.trim(), nativeInvoke: invoke })
    adapterRef.current = adapter
    const unsubscribe = adapter.subscribe((event) => {
      if (event.type === "connection") setConnection(event.status === "ready" ? "已连接" : event.status === "reconnecting" ? "重连中" : event.status === "failed" ? "连接失败" : "连接中")
      if (event.type === "error") setMessage(event.message)
      if (event.type === "room") { setQueueCount(event.room?.queue?.length ?? 0); setQueueTitles((event.room?.queue ?? []).slice(0, 3).map((item) => item.title)); setRoomStatus(event.room?.name ? `房间：${event.room.name}` : "已连接房间") }
      if (event.type === "playback") { setPlaying(event.snapshot.playing); setRoomStatus(event.snapshot.item?.title ? `播放中：${event.snapshot.item.title}` : "房间已连接") }
    })
    try { await adapter.connect(); setMessage("已建立 Linkle 服务连接") } catch { unsubscribe(); setMessage("无法连接 Linkle 服务") }
  }
  return <section className="mt-10 border-t border-border pt-5">
    <div className="flex items-baseline justify-between"><SectionTitle detail="远程服务 · 邀请兑换">Linkle</SectionTitle><span className="text-[11px] text-muted-foreground">{connection}</span></div>
    <div className="mt-2 flex items-center gap-2"><div><p className="text-[11px] text-muted-foreground" role="status">{roomStatus} · 队列 {queueCount}</p>{queueTitles.length ? <p className="text-[10px] text-muted-foreground">{queueTitles.join(" · ")}</p> : null}</div>{playerRef.current ? <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => { const p = playerRef.current; if (!p) return; void (playing ? p.pause() : p.resume()).then(() => setPlaying(!playing)) }}>{playing ? "暂停" : "继续"}</Button> : null}</div>
    <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]" ><Input value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="https://music.example.com" aria-label="Linkle 服务地址" className="h-9 font-mono text-xs" /><div className="flex gap-2"><Button variant="outline" size="sm" className="h-9" disabled={!origin.trim()} onClick={() => { const settings = migrateLocalSettings(JSON.parse(localStorage.getItem("watchparty.local-settings") ?? "null")); const services = [...settings.services.filter((service) => service.product !== "musicparty"), { id: "musicparty-default", product: "musicparty" as const, origin: origin.trim(), label: "Linkle" }]; localStorage.setItem("watchparty.local-settings", JSON.stringify({ ...settings, services })); setMessage("服务地址已保存") }}>保存服务</Button><Button variant="ghost" size="sm" className="h-9" disabled={!origin.trim()} onClick={() => void connect()}>连接</Button></div></div>
    <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]"><Input value={invite} onChange={(event) => setInvite(event.target.value)} placeholder="输入 Linkle 邀请码" aria-label="Linkle 邀请码" className="h-9 text-xs" /><Button size="sm" className="h-9" disabled={!origin.trim() || !invite.trim()} onClick={() => { const adapter = adapterRef.current ?? new MusicPartyAdapter({ origin: origin.trim(), nativeInvoke: invoke }); adapterRef.current = adapter; void adapter.redeemInvite(invite.trim()).then((result) => setMessage(`已进入 ${result.roomName ?? result.roomId}`)).catch(() => setMessage("邀请兑换失败，请检查服务地址和邀请码")) }}>兑换并进入</Button></div>
    <div className="mt-2 flex gap-3 text-[11px] text-muted-foreground"><button type="button" className="hover:text-foreground" onClick={() => setMessage("Cookie 将由系统安全存储管理")}>导入 Cookie</button><button type="button" className="hover:text-foreground" onClick={() => setMessage("迁移包导入将在阶段 2 后续接入")}>导入 Web 迁移包</button></div>
    {message ? <p className="mt-2 text-[11px] text-muted-foreground" role="status">{message}</p> : null}
    <MusicPartySearch origin={origin} adapterRef={adapterRef} playerRef={playerRef} focusOwner={focusOwner} />
  </section>
}

function MusicPartySearch({ origin, adapterRef, playerRef, focusOwner }: { origin: string; adapterRef: React.MutableRefObject<MusicPartyAdapter | null>; playerRef: React.MutableRefObject<NativeAudioPlayer | null>; focusOwner: React.MutableRefObject<AudioFocusOwner> }) {
  const [platform, setPlatform] = useState("netease")
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<MusicSearchResult[]>([])
  const [message, setMessage] = useState("")
  const [backendOrigin, setBackendOrigin] = useState<string | null>(null)
  useEffect(() => { void getDesktopSettings().then((s) => setBackendOrigin(s.backendOrigin)).catch(() => setMessage("请先配置后端站点")) }, [])
  async function search(event: React.FormEvent) {
    event.preventDefault()
    if (!origin.trim() || !query.trim()) return
    try {
      const adapter = adapterRef.current ?? new MusicPartyAdapter({ origin: origin.trim(), nativeInvoke: invoke })
      adapterRef.current = adapter
      setResults(await adapter.search(platform, query.trim()))
      setMessage("")
    } catch { setMessage("搜索失败，请检查服务连接") }
  }
  return <div className="mt-5 border-t border-border/70 pt-4">
    <div className="text-xs font-semibold">搜索音乐</div>
    <form className="mt-2 flex gap-2" onSubmit={(event) => void search(event)}>
      <select value={platform} onChange={(event) => setPlatform(event.target.value)} className="h-9 rounded-md border border-border bg-background px-2 text-xs" aria-label="音乐平台"><option value="netease">网易云</option><option value="youtube">YouTube</option><option value="bilibili">Bilibili</option></select>
      <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索歌曲、艺术家或专辑" aria-label="搜索音乐" className="h-9 flex-1 text-xs" />
      <Button size="sm" className="h-9" disabled={!origin.trim() || !query.trim()}>搜索</Button>
    </form>
    {message ? <p className="mt-2 text-[11px] text-destructive">{message}</p> : null}
    {results.length ? <ul className="mt-3 divide-y divide-border border-y border-border">{results.map((item) => <li key={item.id} className="flex items-center gap-3 py-2 text-xs"><span className="min-w-0 flex-1 truncate">{item.title}<span className="ml-2 text-muted-foreground">{item.artist ?? "未知艺术家"}</span></span><Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setMessage(adapterRef.current?.enqueue(item.platform, item.sourceId) ? "已加入房间队列" : "请先连接 MusicParty 房间")}>加入队列</Button><Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => { const adapter = adapterRef.current; if (!adapter) { setMessage("请先连接 MusicParty 房间"); return }; const player = playerRef.current ?? new NativeAudioPlayer(); playerRef.current = player; void adapter.loadForPlayer(player, item).then(() => { focusOwner.current.register("musicparty", player); adapter.bindPlayer(player); return focusOwner.current.request("musicparty") }).then(() => player.resume()).then(() => setMessage(`正在播放：${item.title}`)).catch(() => setMessage("媒体解析或播放失败")) }}>播放</Button></li>)}</ul> : null}
  </div>
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

function MediaLibraryView({ state, command, navigate }: {
  state: ReturnType<typeof useDesktopSession>["state"]
  command: (command: DesktopCommand) => Promise<boolean>
  navigate: (view: View) => void
}) {
  const [roots, setRoots] = useState<string[]>([])
  const [activeRoot, setActiveRoot] = useState<string | null>(null)
  const [path, setPath] = useState("/")
  const [page, setPage] = useState<MediaDirectoryPage | null>(null)
  const [items, setItems] = useState<MediaDirectoryItem[]>([])
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const [message, setMessage] = useState("")
  const [backendOrigin, setBackendOrigin] = useState<string | null>(null)
  useEffect(() => { void getDesktopSettings().then((s) => setBackendOrigin(s.backendOrigin)).catch(() => setMessage("请先配置后端站点")) }, [])
  const canControl = Boolean(state?.canControlSharedPlayback)

  const load = useCallback(async (root: string, targetPath: string, cursor?: string) => {
    try {
      const result = await mediaList(root, targetPath, cursor)
      setPage(result)
      setItems((current) => cursor ? [...current, ...result.items] : result.items)
      setPath(result.currentPath)
      setMessage("")
    } catch (error) {
      setMessage(errorMessage(error, "无法载入媒体目录"))
    }
  }, [])

  const runSearch = useCallback(async (text: string, cursor?: string) => {
    try {
      const result = await mediaSearch(text, cursor)
      setPage(result)
      setItems((current) => cursor ? [...current, ...result.items] : result.items)
      setMessage("")
    } catch (error) {
      setMessage(errorMessage(error, "搜索失败"))
    }
  }, [])

  useEffect(() => {
    void mediaRoots().then((names) => {
      setRoots(names)
      if (names.length > 0) {
        setActiveRoot(names[0])
        void load(names[0], "/")
      }
    }).catch(() => setMessage("媒体浏览需要先配置站点"))
  }, [load])

  async function openItem(item: MediaDirectoryItem) {
    if (item.type === "dir" && activeRoot) {
      setSearching(false)
      setQuery("")
      await load(activeRoot, item.id)
      return
    }
    if (!canControl) {
      setMessage("当前无控制权限（房间已锁定或非房主）")
      return
    }
    const media: MediaSource = {
      kind: "openlist",
      mediaId: item.id,
      title: item.name,
      container: item.extension || "mp4",
      displayPath: item.displayPath ?? undefined,
    }
    if (await command({ type: "mediaSet", media })) {
      setMessage(`正在播放 ${item.name}`)
      navigate("room")
    }
  }

  async function enqueue(item: MediaDirectoryItem) {
    if (!canControl) {
      setMessage("当前无控制权限（房间已锁定或非房主）")
      return
    }
    const media: MediaSource = {
      kind: "openlist",
      mediaId: item.id,
      title: item.name,
      container: item.extension || "mp4",
      displayPath: item.displayPath ?? undefined,
    }
    if (await command({ type: "playlistAdd", media })) setMessage(`已加入队列：${item.name}`)
  }

  function breadcrumbTarget(index: number): string {
    if (!page) return "/"
    if (index === 0) return "/"
    return `/${page.breadcrumbs.slice(1, index + 1).join("/")}`
  }

  const [pasteUrl, setPasteUrl] = useState("")
  const [pasteTitle, setPasteTitle] = useState("")

  function pastedMedia(): MediaSource {
    const url = pasteUrl.trim()
    const title = pasteTitle.trim() || url.split("/").pop() || url
    return url.toLowerCase().split("?")[0]!.endsWith(".m3u8")
      ? { kind: "hls", url, title }
      : { kind: "http", url, title }
  }

  async function submitPaste(play: boolean) {
    if (!pasteUrl.trim()) return
    if (!canControl) {
      setMessage("当前无控制权限（房间已锁定或非房主）")
      return
    }
    const media = pastedMedia()
    const type = play ? "mediaSet" : "playlistAdd"
    if (await command({ type, media } as DesktopCommand)) {
      setMessage(play ? "开始播放粘贴的媒体" : "已加入队列")
      setPasteUrl("")
      setPasteTitle("")
    }
  }

  return (
    <div className="mx-auto min-h-full w-full max-w-[1120px] px-8 py-8">
      <header className="flex flex-wrap items-center gap-3">
        <SectionTitle detail="OpenList · 浏览与搜索经 Rust 原生 IPC">媒体库</SectionTitle>
        <div className="flex-1" />
        {roots.map((root) => (
          <Button key={root} size="sm" variant={root === activeRoot && !searching ? "default" : "ghost"}
            className="h-7 rounded-full px-3 text-[11px]"
            onClick={() => { setActiveRoot(root); setSearching(false); setQuery(""); void load(root, "/") }}>
            {root}
          </Button>
        ))}
        <form className="relative w-56" onSubmit={(event) => {
          event.preventDefault()
          if (!query.trim()) return
          setSearching(true)
          void runSearch(query.trim())
        }}>
          <MaterialSymbol name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题…" aria-label="搜索媒体" className="h-8 pl-9 text-xs" />
        </form>
      </header>

      <form className="mt-4 flex flex-wrap items-center gap-2 border-y border-border py-3" onSubmit={(event) => event.preventDefault()}>
        <span className="text-[11px] font-semibold text-muted-foreground">粘贴 HTTPS / HLS</span>
        <Input value={pasteUrl} onChange={(event) => setPasteUrl(event.target.value)} placeholder="https://example.com/video.mp4 或 .m3u8" aria-label="粘贴媒体地址" className="h-8 min-w-64 flex-1 font-mono text-xs" />
        <Input value={pasteTitle} onChange={(event) => setPasteTitle(event.target.value)} placeholder="标题（可选）" aria-label="粘贴媒体标题" className="h-8 w-40 text-xs" />
        <Button size="sm" className="h-7 px-2.5 text-[11px]" disabled={!canControl || !pasteUrl.trim()} onClick={() => void submitPaste(true)}>
          <MaterialSymbol name="play-arrow" />播放
        </Button>
        <Button variant="outline" size="sm" className="h-7 px-2.5 text-[11px]" disabled={!canControl || !pasteUrl.trim()} onClick={() => void submitPaste(false)}>
          <MaterialSymbol name="add" />入队
        </Button>
      </form>

      {page && !searching ? (
        <nav aria-label="目录路径" className="mt-4 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          {page.breadcrumbs.map((crumb, index) => (
            <span key={`${crumb}-${index}`} className="flex items-center gap-1">
              {index > 0 ? <span>/</span> : null}
              <button type="button" className="hover:text-foreground" onClick={() => activeRoot && void load(activeRoot, breadcrumbTarget(index))}>
                {index === 0 ? activeRoot ?? crumb : crumb}
              </button>
            </span>
          ))}
        </nav>
      ) : null}

      {items.length ? (
        <ul className="mt-4 divide-y divide-border border-y border-border">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 py-2.5 text-xs">
              <MaterialSymbol name={item.type === "dir" ? "folder" : "movie"} className="size-5 text-muted-foreground" />
              <button type="button" className="min-w-0 flex-1 truncate text-left hover:text-primary" onClick={() => void openItem(item)} title={item.displayPath ?? item.name}>
                {item.name}
                {item.extension && item.type === "file" ? <span className="ml-2 font-mono text-[10px] text-muted-foreground">{item.extension}</span> : null}
              </button>
              {item.type === "file" ? (
                <>
                  <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" disabled={!canControl} title="立即播放" onClick={() => void openItem(item)}>
                    <MaterialSymbol name="play-arrow" />播放
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 px-2.5 text-[11px]" disabled={!canControl} title="加入播放队列" onClick={() => void enqueue(item)}>
                    <MaterialSymbol name="add" />入队
                  </Button>
                </>
              ) : null}
            </li>
          ))
          }
        </ul>
      ) : <EmptyPosterGrid label={searching ? "没有匹配的媒体" : "此目录为空"} />}

      {page?.hasMore && page.nextCursor ? (
        <Button variant="outline" size="sm" className="mt-3 h-7 px-3 text-[11px]"
          onClick={() => searching
            ? void runSearch(query, page.nextCursor ?? undefined)
            : activeRoot && void load(activeRoot, path, page.nextCursor ?? undefined)}>
          载入更多
        </Button>
      ) : null}
      {message ? <p className="mt-3 text-xs text-muted-foreground">{message}</p> : null}
    </div>
  )
}

function SettingsView({ state, theme, onThemeChange }: { state: DesktopUiState | null; theme: Theme; onThemeChange: () => void }) {
  const [section, setSection] = useState<SettingsSection>("credentials")
  const labels: Array<[SettingsSection, string]> = [["general", "通用"], ["playback", "播放"], ["credentials", "站点凭据"], ["network", "后端与网络"], ["security", "安全与会话"]]
  return (
    <div className="grid min-h-full grid-cols-[172px_minmax(0,1fr)]">
      <nav className="border-r border-border/80 bg-card/36 px-3 py-8" aria-label="设置分类">{labels.map(([value, label]) => <Button key={value} variant="ghost" onClick={() => setSection(value)} className={cn("relative h-9 w-full justify-start px-3 text-xs", section === value && "bg-accent text-foreground before:absolute before:left-0 before:h-4 before:w-[3px] before:rounded-full before:bg-primary")}>{label}</Button>)}</nav>
      <section className="w-full max-w-[680px] px-8 py-8">
        {section === "credentials" ? <CredentialsPanel /> : null}
        {section === "general" ? <GeneralPanel theme={theme} onThemeChange={onThemeChange} /> : null}
        {section === "playback" ? <PlaybackPanel state={state} /> : null}
        {section === "network" ? <NetworkPanel state={state} /> : null}
        {section === "security" ? <SecurityPanel /> : null}
      </section>
    </div>
  )
}

function SecurityPanel() {
  const [roomId, setRoomId] = useState("")
  const [password, setPassword] = useState("")
  const [origin, setOrigin] = useState("")
  const [pem, setPem] = useState("")
  const [records, setRecords] = useState<OriginTrustRecord[]>([])
  const [message, setMessage] = useState("")
  const [backendOrigin, setBackendOrigin] = useState<string | null>(null)
  useEffect(() => { void getDesktopSettings().then((s) => setBackendOrigin(s.backendOrigin)).catch(() => setMessage("请先配置后端站点")) }, [])
  useEffect(() => { void listOriginTrust().then(setRecords).catch(() => setMessage("TLS 信任管理暂不可用")) }, [])
  async function run(action: () => Promise<unknown>, ok: string) { try { await action(); setMessage(ok) } catch (error) { setMessage(errorMessage(error, "该原生能力暂不可用，请更新桌面端后重试")) } }
  return <><SettingsHeading title="安全与会话" detail="私有房间授权、服务端注销与按服务来源隔离的 TLS 信任。" /><div className="space-y-6"><div className="border-y border-border py-4"><p className="text-xs font-medium">私有房间</p><div className="mt-3 grid gap-2 sm:grid-cols-2"><Input value={roomId} onChange={(e) => setRoomId(e.target.value)} placeholder="房间 ID" aria-label="房间 ID" /><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="房间密码" aria-label="房间密码" /></div><Button className="mt-3" size="sm" disabled={!roomId || !password} onClick={() => void run(() => verifyPrivateRoom(roomId, password, backendOrigin), "房间授权已更新")}>验证并保存授权</Button></div><div className="border-y border-border py-4"><p className="text-xs font-medium">服务端会话</p><Button className="mt-3" variant="outline" size="sm" onClick={() => void run(() => logoutMusicParty(backendOrigin), "已从服务端注销")}>注销 Linkle</Button></div><div className="border-y border-border py-4"><p className="text-xs font-medium">Origin TLS 信任</p><Input className="mt-3" value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="https://music.example.com" aria-label="服务来源" /><textarea className="mt-2 min-h-20 w-full rounded-md border border-border bg-background p-2 text-xs font-mono" value={pem} onChange={(e) => setPem(e.target.value)} placeholder="粘贴 PEM 证书" aria-label="PEM 证书" /><Button className="mt-3" size="sm" disabled={!origin || !pem} onClick={() => void run(() => importOriginTrust({ origin, pem }).then((r) => setRecords((v) => [...v.filter((x) => x.origin !== r.origin), r])), "已保存该来源的 TLS 信任")}>导入或替换</Button><ul className="mt-3 divide-y divide-border border-y border-border">{records.map((record) => <li key={record.origin} className="flex items-center justify-between py-2 text-xs"><span className="truncate">{record.origin}<span className="ml-2 text-muted-foreground">{record.fingerprint}</span></span><Button variant="ghost" size="sm" onClick={() => void run(() => deleteOriginTrust(record.origin).then(() => setRecords((v) => v.filter((x) => x.origin !== record.origin)),), "已删除信任记录")}>删除</Button></li>)}</ul></div></div><p role="status" className="mt-3 text-xs text-muted-foreground">{message}</p></>
}

async function persistTheme(theme: Theme, setTheme: (theme: Theme) => void) {
  const nextTheme = theme === "dark" ? "light" : "dark"
    const current = await getDesktopSettings()
    await updateDesktopSettings({
      backendOrigin: current.backendOrigin,
      nickname: current.nickname,
      theme: nextTheme,
      playerPreferences: current.playerPreferences,
    })
  setTheme(nextTheme)
}

function SettingsHeading({ title, detail }: { title: string; detail: string }) {
  return <div className="mb-5"><h1 className="text-sm font-semibold">{title}</h1><p className="mt-1 text-xs text-muted-foreground">{detail}</p></div>
}

function CredentialsPanel() {
  const [status, setStatus] = useState<DesktopSettingsStatus | null>(null)
  const [message, setMessage] = useState("正在读取原生凭据状态…")
  const [busy, setBusy] = useState(false)
  useEffect(() => { void getDesktopSettings().then((value) => { setStatus(value); setMessage(value.backendOrigin ? "" : "请先在后端与网络中保存站点") }).catch((error: unknown) => setMessage(errorMessage(error, "无法读取凭据状态"))) }, [])
  async function prompt() {
    setBusy(true)
    setMessage("等待系统凭据对话框…")
    try {
      const result = await promptSiteCredentials()
      if (result) { setStatus(result); setMessage("凭据已保存，请重新加入房间") }
      else setMessage("已取消，凭据未更改")
    } catch (error) { setMessage(errorMessage(error, "凭据录入失败")) }
    finally { setBusy(false) }
  }
  async function clear() {
    setBusy(true)
    try { setStatus(await clearSiteCredentials()); setMessage("凭据已清除，原会话已停止") } catch (error) { setMessage(errorMessage(error, "清除凭据失败")) }
    finally { setBusy(false) }
  }
  async function verify() {
    setBusy(true)
    setMessage("正在验证后端…")
    try { await verifyBackend(); setMessage("后端连接正常") } catch (error) { setMessage(errorMessage(error, "后端验证失败")) }
    finally { setBusy(false) }
  }
  return <><SettingsHeading title="站点凭据" detail="站点密码保存在 Windows 凭据库中。更改凭据会结束当前房间会话。" /><div className="border-y border-border"><SettingRow icon="shield" title="Basic Auth" detail={status?.credentialsConfigured ? "已配置，密码不会从界面读回" : "未配置"}><span className="text-xs text-muted-foreground">{status?.credentialsConfigured ? "已配置" : "未配置"}</span></SettingRow></div><div className="mt-5 flex gap-2"><Button disabled={busy || !status?.backendOrigin} onClick={() => void prompt()}>打开系统凭据对话框</Button><Button variant="outline" onClick={() => void clear()} disabled={busy || !status?.credentialsConfigured}>清除</Button><Button variant="ghost" disabled={busy || !status?.backendOrigin} onClick={() => void verify()}>验证后端</Button></div><p role="status" className="mt-3 text-xs text-muted-foreground">{message}</p></>
}

function GeneralPanel({ theme, onThemeChange }: { theme: Theme; onThemeChange: () => void }) {
  return <><SettingsHeading title="通用" detail="调整桌面端的外观行为。" /><div className="border-y border-border"><SettingRow icon={theme === "dark" ? "dark-mode" : "light-mode"} title="主题" detail="纯黑深色 / 浅色"><Button variant="outline" size="sm" onClick={onThemeChange}>{theme === "dark" ? "切换浅色" : "切换深色"}</Button></SettingRow></div></>
}

function PlaybackPanel({ state }: { state: DesktopUiState | null }) {
  const [preferences, setPreferences] = useState<PlayerPreferences | null>(null)
  const [failures, setFailures] = useState<string[]>([])
  const [message, setMessage] = useState("")
  const [backendOrigin, setBackendOrigin] = useState<string | null>(null)
  useEffect(() => { void getDesktopSettings().then((s) => setBackendOrigin(s.backendOrigin)).catch(() => setMessage("请先配置后端站点")) }, [])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void getDesktopSettings()
      .then((settings) => {
        setPreferences(settings.playerPreferences)
        setFailures(settings.playerPreferenceFailures ?? [])
      })
      .catch((error: unknown) => setMessage(errorMessage(error, "无法读取播放设置")))
  }, [])

  function patch(patch: Partial<PlayerPreferences>) {
    setPreferences((current) => (current ? { ...current, ...patch } : current))
  }

  async function save() {
    if (!preferences) return
    setBusy(true)
    try {
      const current = await getDesktopSettings()
      const updated = await updateDesktopSettings({
        backendOrigin: current.backendOrigin,
        nickname: current.nickname,
        theme: current.theme,
        playerPreferences: preferences,
      })
      setPreferences(updated.playerPreferences)
      setFailures(updated.playerPreferenceFailures ?? [])
      setMessage((updated.playerPreferenceFailures ?? []).length > 0
        ? "已保存；部分即时项未能应用到当前播放器"
        : "已保存")
    } catch (error) {
      setMessage(errorMessage(error, "播放设置保存失败"))
    } finally {
      setBusy(false)
    }
  }

  if (!preferences) {
    return <><SettingsHeading title="播放" detail="白名单播放器设置。" /><p className="text-xs text-muted-foreground">{message || "正在读取…"}</p></>
  }

  return (
    <>
      <SettingsHeading title="播放" detail="每项标注生效时机；非法值会在保存时拒绝并保留原值。" />
      <div className="divide-y divide-border border-y border-border">
        <SettingRow icon="speed" title="硬件解码" detail="重建播放器后生效">
          <Select value={preferences.hardwareDecoding} onValueChange={(value) => patch({ hardwareDecoding: value as PlayerPreferences["hardwareDecoding"] })}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto-safe">安全自动</SelectItem>
              <SelectItem value="auto">自动</SelectItem>
              <SelectItem value="no">关闭</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow icon="monitor" title="去隔行" detail="立即生效">
          <Select value={preferences.deinterlace} onValueChange={(value) => patch({ deinterlace: value as PlayerPreferences["deinterlace"] })}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">自动</SelectItem>
              <SelectItem value="on">开</SelectItem>
              <SelectItem value="off">关</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow icon="monitor" title="HDR 输出" detail="立即生效：跟随默认 / 转 SDR / 原样">
          <Select value={preferences.hdr} onValueChange={(value) => patch({ hdr: value as PlayerPreferences["hdr"] })}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">跟随默认</SelectItem>
              <SelectItem value="sdr">转 SDR</SelectItem>
              <SelectItem value="passthrough">原样</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow icon="volume-up" title="音频输出设备" detail="立即生效；设备消失回退系统默认">
          <Input value={preferences.audioDevice ?? ""} onChange={(event) => patch({ audioDevice: event.target.value.trim() || null })} placeholder="系统默认" aria-label="音频输出设备" className="h-8 w-56 font-mono text-xs" />
        </SettingRow>
        <SettingRow icon="music-note" title="声道" detail="立即生效；不做 bitstream 直通">
          <Select value={preferences.channelLayout} onValueChange={(value) => patch({ channelLayout: value as PlayerPreferences["channelLayout"] })}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">自动</SelectItem>
              <SelectItem value="stereo">立体声</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow icon="volume-up" title="默认音量" detail={`${preferences.defaultVolume}% · 新建播放器时生效`}>
          <Slider value={[preferences.defaultVolume]} min={0} max={100} step={1} className="w-44" onValueChange={(values) => patch({ defaultVolume: values[0] ?? 100 })} />
        </SettingRow>
        <SettingRow icon="music-note" title="首选音轨语言" detail="下次载入生效（如 chi,eng）">
          <Input value={preferences.audioLanguage} onChange={(event) => patch({ audioLanguage: event.target.value })} placeholder="默认" aria-label="首选音轨语言" className="h-8 w-36 text-xs" />
        </SettingRow>
        <SettingRow icon="subtitles" title="字幕语言顺序" detail="下次载入生效（如 chi,eng）">
          <Input value={preferences.subtitleLanguage} onChange={(event) => patch({ subtitleLanguage: event.target.value })} placeholder="默认" aria-label="字幕语言顺序" className="h-8 w-36 text-xs" />
        </SettingRow>
        <SettingRow icon="subtitles" title="字幕字体" detail="立即生效（非 ASS 文本字幕）">
          <Input value={preferences.subtitleFont} onChange={(event) => patch({ subtitleFont: event.target.value })} placeholder="系统默认" aria-label="字幕字体" className="h-8 w-44 text-xs" />
        </SettingRow>
        <SettingRow icon="subtitles" title="字幕相对字号" detail={`×${preferences.subtitleScale.toFixed(1)} · 立即生效`}>
          <Slider value={[preferences.subtitleScale]} min={0.5} max={3} step={0.1} className="w-44" onValueChange={(values) => patch({ subtitleScale: values[0] ?? 1 })} />
        </SettingRow>
        <SettingRow icon="subtitles" title="ASS 样式覆盖" detail="立即生效：开 = 用上面的字体/字号覆盖内嵌样式">
          <Button variant="outline" size="sm" onClick={() => patch({ subtitleAssOverride: !preferences.subtitleAssOverride })}>
            {preferences.subtitleAssOverride ? "覆盖开" : "尊重原样式"}
          </Button>
        </SettingRow>
        <SettingRow icon="subtitles" title="字幕延迟" detail={`${preferences.subtitleDelay.toFixed(1)}s · 立即生效，换片重置`}>
          <Slider value={[preferences.subtitleDelay]} min={-30} max={30} step={0.5} className="w-44" onValueChange={(values) => patch({ subtitleDelay: values[0] ?? 0 })} />
        </SettingRow>
        <SettingRow icon="sync" title="缓存预设" detail="重建播放器后生效">
          <Select value={preferences.cacheProfile} onValueChange={(value) => patch({ cacheProfile: value as PlayerPreferences["cacheProfile"] })}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">自动</SelectItem>
              <SelectItem value="low-latency">低延迟</SelectItem>
              <SelectItem value="stable">稳定</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow icon="sync" title="网络超时" detail={`${preferences.networkTimeout}s · 下次载入生效（5-120）`}>
          <Input type="number" min={5} max={120} value={preferences.networkTimeout} onChange={(event) => patch({ networkTimeout: Math.min(120, Math.max(5, Number(event.target.value) || 30)) })} aria-label="网络超时秒数" className="h-8 w-24 text-xs" />
        </SettingRow>
      </div>
      <div className="mt-5 flex items-center gap-3">
        <Button onClick={() => void save()} disabled={busy}>保存播放设置</Button>
        <span className="text-xs text-muted-foreground">{message}</span>
      </div>
      {failures.length > 0 ? (
        <p className="mt-2 text-xs text-warning">未生效项：{failures.join("、")}（保留的值将在下次重建播放器时重试）</p>
      ) : null}
      {state?.capability ? (
        <p className="mt-3 font-mono text-[10px] text-muted-foreground">
          当前生效：hwdec={state.capability.hwdec ?? state.capability.hwdecConfigured ?? "-"} · vo={state.capability.vo ?? "-"}
        </p>
      ) : null}
    </>
  )
}

function NetworkPanel({ state }: { state: DesktopUiState | null }) {
  const [origin, setOrigin] = useState("")
  const [settings, setSettings] = useState<DesktopSettingsStatus | null>(null)
  const [message, setMessage] = useState("")
  const [backendOrigin, setBackendOrigin] = useState<string | null>(null)
  useEffect(() => { void getDesktopSettings().then((s) => setBackendOrigin(s.backendOrigin)).catch(() => setMessage("请先配置后端站点")) }, [])
  const [busy, setBusy] = useState(false)
  useEffect(() => { void getDesktopSettings().then((value) => { setSettings(value); setOrigin(value.backendOrigin ?? "") }).catch((error: unknown) => setMessage(errorMessage(error, "无法读取设置"))) }, [])
  async function save() {
    setBusy(true)
    try {
      const current = await getDesktopSettings()
      const updated = await updateDesktopSettings({ backendOrigin: origin.trim() || null, nickname: current.nickname, theme: current.theme, playerPreferences: current.playerPreferences })
      setSettings(updated)
      setOrigin(updated.backendOrigin ?? "")
      setMessage(updated.backendOrigin !== current.backendOrigin ? "站点已更新，请验证连接后重新加入房间" : "已保存")
    } catch (error) { setMessage(errorMessage(error, "设置保存失败")) }
    finally { setBusy(false) }
  }
  return <><SettingsHeading title="后端与网络" detail="使用 HTTPS 地址，本机可用 HTTP。更换站点会结束当前房间会话；留空可清除站点。" /><div className="border-y border-border"><SettingRow icon="sync" title="WatchParty 站点" detail={settings?.backendOrigin ? connectionLabel(state?.connection) : "未配置"}><Input aria-label="站点地址" disabled={busy} value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder={`http://${BACKEND_LABEL}`} className="w-64 font-mono text-xs" /></SettingRow></div><div className="mt-5 flex items-center gap-3"><Button disabled={busy || !settings} onClick={() => void save()}>保存站点</Button><span role="status" className="text-xs text-muted-foreground">{message}</span></div></>
}

function SettingRow({ icon, title, detail, children }: { icon: MaterialSymbolName; title: string; detail: string; children: ReactNode }) {
  return <div className="flex min-h-16 items-center gap-3 py-3"><MaterialSymbol name={icon} className="size-5 text-muted-foreground" /><div className="min-w-0 flex-1"><h2 className="text-xs font-medium">{title}</h2><p className="mt-1 text-[11px] text-muted-foreground">{detail}</p></div>{children}</div>
}

function TerminalOverlay({ state, onLeave }: { state: DesktopUiState; onLeave: () => void }) {
  return <section className="fixed inset-0 z-50 grid place-items-center bg-black/86 px-6" aria-live="assertive"><div className="w-full max-w-lg border border-border bg-card p-7"><p className="mb-2 font-mono text-xs text-primary">{state.error?.code ?? "DESKTOP_SESSION_FAILED"}</p><h1 className="text-2xl font-semibold">{state.connection === "expired" ? "桌面会话已过期" : "桌面会话不可用"}</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">{state.error?.message ?? "请返回网页房间重新生成一次性交接码。"}</p><Button className="mt-6" onClick={onLeave}>重新加入</Button></div></section>
}




