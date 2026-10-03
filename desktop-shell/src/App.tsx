import { useEffect, useRef, useState, useCallback, type CSSProperties } from "react"
import { createPortal } from "react-dom"
import { FluentProvider, webDarkTheme, webLightTheme } from "@fluentui/react-components"
import { AddRegular, ArrowSyncRegular, DesktopRegular, KeyRegular, MusicNote2Regular, PanelLeftContractRegular, PanelLeftExpandRegular, PlayRegular, PlugConnectedRegular, PulseRegular, SaveRegular, SearchRegular, SettingsRegular } from "@fluentui/react-icons"
import { ShellStatusToast, ShellToastProvider } from "@/components/shell-toast"

import { LobbyView } from "@/components/lobby-view"
import { BanguruLobby, type BanguruProbeState } from "@/components/banguru-lobby"
import { SetupGuide, type SetupGuideServices } from "@/components/setup-guide"
import { linkleReadinessLine } from "@/components/setup-guide-steps"
import { FluentSettingsView } from "@/components/fluent-settings"
import { useLobbyFacade } from "@/hooks/use-lobby-facade"
import type { RoomIdentity, SwitchTarget } from "../shared/lobby-contract"
import { RoomView } from "@/components/room-view"
import { SessionGate } from "@/components/session-gate"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Input } from "@/components/ui/input"
import { ProgressRing } from "@/components/ui/progress-ring"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { TabBar, TabBarItem } from "@/components/ui/tabs"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useDesktopSession } from "@/hooks/use-desktop-session"
import { connectionLabel, type DesktopCommand, type DesktopUiState, type MediaSource, type NativeCapabilityReport } from "@/lib/contracts"
import { cn } from "@/lib/utils"
import { childDirectoryPath } from "@/lib/media-library-navigation"
import { healthLabel, legacyView, libraryKindLabel, mediaErrorText, toView, type MediaCard, type MediaView } from "@/lib/media-library-view"
import { MediaCardGrid, MediaFolderBanner } from "@/components/media-card-grid"
import { CatalogRail, CatalogWall, UnmatchedLine } from "@/components/catalog-wall"
import { catalogErrorText, toDetail, toWall, scrapeSummary, type Wall, type WallCard, type WallDetail } from "@/lib/catalog-view"
import { hiddenCardCount, visibleCards } from "@/lib/media-library-view"

import { winuiFluentTheme } from "@/lib/winui-theme"
import { createDefaultLocalSettings, linkleDisplayName, linkleMemberOf, migrateLocalSettings, musicPartyOriginError, saveMusicPartyService, serviceForProduct } from "../shared/local-schema"
import { MusicPartyAccountError, MusicPartyAdapter, accountDisplayName, probeMusicParty, type MusicPartyProbe } from "../shared/musicparty-adapter"
import { MusicPartyConnection } from "../shared/musicparty-connection"
import { NativeAudioPlayer } from "../shared/native-audio-player"
import { AudioFocusOwner } from "../shared/player"
import { invoke, listen } from "../shared/desktop-runtime"
import { getDesktopWallpaperBackdrop } from "@/lib/ipc"
import type { DomainEvent } from "../shared/domain"
import { LinkleRoom } from "@/components/linkle-room"
import { backendAddressError, bangumiSearch, createDesktopRoom, createMediaSource, catalogRebind, catalogUnconfirm, errorMessage, getDesktopSettings, listenForSettings, mediaCapabilities, mediaLibraries, mediaLibraryPage, mediaLibrarySearch, mediaList, mediaRoots, mediaSearch, probeDesktopBackend, probeDesktopReadiness, promptSiteCredentials, updateDesktopSettings, verifyBackend, catalogPage, catalogDetail, catalogConfirm, catalogReject, libraryScrapeStatus, startLibraryScrape, type BangumiHit, type DesktopProbeReport, type DesktopSettingsStatus, artworkUrl, type MediaCapabilities, type MediaLibrary, type ScrapeJob } from "@/lib/ipc"

type View = "home" | "room" | "media" | "settings"
type Drawer = "queue" | "members" | null
type Theme = "dark" | "light"
/** M3 决策（§9-B）：主题可跟随系统；accent / 封面取色不受影响。 */
type ThemePreference = Theme | "system"
type WindowMaterial = "auto" | "none"

const BACKEND_LABEL = "127.0.0.1:8080"

function capabilityLabel(capability?: NativeCapabilityReport): string {
  if (!capability?.libmpvReady) return "libmpv 等待初始化"
  return [capability.vo, capability.hwdec, capability.videoCodec, capability.audioCodec]
    .filter(Boolean)
    .join(" · ") || "libmpv 已就绪"
}

/** 文件浏览器与标题墙共用的取图入口：库封面走 media，目录海报走 poster。 */
function libraryArtwork(posterId: string): string | null {
  return posterId ? artworkUrl("media", posterId) : null
}

function catalogPoster(itemId: string): string | null {
  return itemId ? artworkUrl("poster", itemId) : null
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
  const locallyHandledStatus = useRef(false)
  const [completedLocalNotice, setCompletedLocalNotice] = useState(0)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(storedSidebarCollapsed)
  useEffect(() => { locallyHandledStatus.current = false }, [completedLocalNotice])
  const [view, setView] = useState<View>("home")
  const [product, setProduct] = useState<"watchparty" | "musicparty">("watchparty")
  const inviteSwitch = useRef<((identity: RoomIdentity) => Promise<void>) | null>(null)
  const [setupLinkleOrigin, setSetupLinkleOrigin] = useState<string | null>(null)
  const musicParty = useMusicPartyEntry(identity => {
    if (!inviteSwitch.current) throw new Error("room_switch_unavailable")
    return inviteSwitch.current(identity)
  }, setupLinkleOrigin)
  const [currentLobbyRoom, setCurrentLobbyRoom] = useState<RoomIdentity | null>(null)
  const switchingLobby = useRef(false)
  // A room this machine just created must not auto-navigate: the result block offers 复制 and
  // an explicit 进入房间 (用户 2026-10-02 拍板：创建≠进房)。Consumed when the session arrives.
  const pendingCreateRoom = useRef(false)
  const switchLobby = async (target: SwitchTarget, nickname = "桌面用户") => {
    locallyHandledStatus.current = true
    switchingLobby.current = true
    pendingCreateRoom.current = false
    try {
      await session.switchTo(target, {
        music: musicParty.getConnection(),
        current: () => currentLobbyRoom ?? (session.state?.roomId && backendOrigin ? { service: "watchparty", origin: backendOrigin, roomId: session.state.roomId } : musicParty.currentRoom()),
        nickname: () => nickname,
        focus: musicParty.setFocus,
        committed: identity => { setCurrentLobbyRoom(identity); if (identity) setProduct(identity.service) },
      })
      setView(target.identity.service === "watchparty" ? "room" : "home")
    } finally { switchingLobby.current = false; setCompletedLocalNotice(value => value + 1) }
  }
  inviteSwitch.current = identity => switchLobby({ identity })
  const startSession = (ticket: string) => { pendingCreateRoom.current = false; return session.start(ticket) }
  const lobby = useLobbyFacade({ origin: musicParty.serviceOrigin, connection: musicParty.getConnection(), createAdapter: () => new MusicPartyAdapter({ origin: musicParty.serviceOrigin, nativeInvoke: invoke }), switchTo: switchLobby })
  const [drawer, setDrawer] = useState<Drawer>(null)
  const [themePreference, setThemePreference] = useState<ThemePreference>("dark")
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches)
  const theme: Theme = themePreference === "system" ? (systemDark ? "dark" : "light") : themePreference
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [])
  const [windowMaterial, setWindowMaterial] = useState<WindowMaterial>("auto")
  const [backendOrigin, setBackendOrigin] = useState<string | null>(null)
  const [banguruProbe, setBanguruProbe] = useState<BanguruProbeState>({ status: "unconfigured" })
  const [restorationSettledOrigin, setRestorationSettledOrigin] = useState<string | null>(null)
  const restoreAttemptedOrigin = useRef<string | null>(null)
  const restoringSession = useRef(false)
  const previousBackendOrigin = useRef<string | null>(null)
  // 首启向导：null = 还没读到磁盘设置，此时不闪向导。
  const [setupCompleted, setSetupCompleted] = useState<boolean | null>(null)
  const localLinkleOrigin = useCallback((): string => {
    try { return serviceForProduct(migrateLocalSettings(JSON.parse(localStorage.getItem("watchparty.local-settings") ?? "null")), "musicparty")?.origin ?? "" } catch { return "" }
  }, [])

  // Setup Guide 注入面：只用既有 IPC 白名单命令（getDesktopSettings / updateDesktopSettings /
  // verifyBackend / probeDesktopBackend / promptSiteCredentials / Linkle adapter）。
  const setupServices: SetupGuideServices = {
    async loadInitial() {
      const settings = await getDesktopSettings()
      return {
        backendOrigin: settings.backendOrigin,
        nickname: settings.nickname,
        linkleOrigin: localLinkleOrigin(),
        credentialsConfigured: settings.credentialsConfigured,
      }
    },
    async saveBanguruOrigin(origin) {
      const trimmed = origin.trim()
      if (!trimmed) return { ok: false, message: "请填写 Banguru 服务器地址。" }
      const invalid = backendAddressError(trimmed)
      if (invalid) return { ok: false, message: invalid }
      try {
        const current = await getDesktopSettings()
        const updated = await updateDesktopSettings({ backendOrigin: trimmed, allowRemoteHttp: current.allowRemoteHttp, nickname: current.nickname, theme: current.theme, windowMaterial: current.windowMaterial, playerPreferences: current.playerPreferences })
        setBackendOrigin(updated.backendOrigin)
        return { ok: true }
      } catch (error) { return { ok: false, message: errorMessage(error, "地址保存失败，请检查格式后重试。") } }
    },
    async verifyBanguru() {
      const current = await getDesktopSettings()
      const origin = current.backendOrigin
      if (!origin) return { ok: false, message: "还没有可验证的服务器地址。", hint: "回到上一步填写 Banguru 服务器地址后再验证。" }
      try {
        await verifyBackend()
        const report = await probeDesktopBackend()
        const enabled = [
          report.capabilities.createRoom ? "创建" : null,
          report.capabilities.joinRoom ? "加入" : null,
          report.capabilities.restoreSession ? "恢复" : null,
          report.capabilities.mediaSearch ? "搜索" : null,
          report.capabilities.mediaQueue ? "队列" : null,
          report.capabilities.handoffCode ? "网页交接" : null,
        ].filter((label): label is string => label !== null)
        return {
          ok: true,
          statusLine: "在线 · 服务正常",
          protocolLine: "v" + report.protocolVersion,
          capabilityLine: enabled.length ? enabled.join(" · ") + " 均可用" : "服务器未开放任何能力位",
          accountLine: current.credentialsConfigured ? "已设置" : "未设置（服务器未要求 Basic Auth）",
        }
      } catch {
        return {
          ok: false,
          message: "无法连接 " + origin + "。",
          hint: "请确认 Banguru 后端已启动（默认监听 8080）、主机与端口正确、防火墙放行；远程网络请改用 HTTPS。服务器要求账号时到「安全与高级」设置。",
        }
      }
    },
    // 与 ipc.ts 的 promptSiteCredentials 同名：方法名不构成词法绑定，这里调用的是导入的 IPC 包装。
    async promptSiteCredentials() {
      try { return (await promptSiteCredentials()) !== null } catch { return false }
    },
    async saveNickname(nickname) {
      const trimmed = nickname.trim()
      if (!trimmed) return { ok: false, message: "请填写昵称。" }
      try {
        const current = await getDesktopSettings()
        await updateDesktopSettings({ backendOrigin: current.backendOrigin, allowRemoteHttp: current.allowRemoteHttp, nickname: trimmed, theme: current.theme, windowMaterial: current.windowMaterial, playerPreferences: current.playerPreferences })
        return { ok: true }
      } catch (error) { return { ok: false, message: errorMessage(error, "昵称保存失败。") } }
    },
    async verifyLinkle(origin) {
      const trimmed = origin.trim()
      const invalid = musicPartyOriginError(trimmed)
      if (invalid) return { ok: false, message: invalid }
      try {
        const probe = await probeMusicParty({ origin: trimmed, nativeInvoke: invoke }, { readiness: true })
        if (probe.status !== "ok") return { ok: false, message: probe.message }
        return { ok: true, line: linkleReadinessLine(probe.readiness) }
      } catch (error) { return { ok: false, message: errorMessage(error, "无法验证 Linkle 服务地址。") } }
    },
    async saveLinkleOrigin(origin) {
      const trimmed = origin.trim()
      const invalid = musicPartyOriginError(trimmed)
      if (invalid) return { ok: false, message: invalid }
      try {
        const settings = migrateLocalSettings(JSON.parse(localStorage.getItem("watchparty.local-settings") ?? "null"))
        const next = saveMusicPartyService(settings, trimmed)
        localStorage.setItem("watchparty.local-settings", JSON.stringify(next))
        setSetupLinkleOrigin(serviceForProduct(next, "musicparty")?.origin ?? "")
        return { ok: true }
      } catch { return { ok: false, message: "服务地址无效或无法保存。" } }
    },
    async redeemLinkleInvite(code) {
      const target = localLinkleOrigin()
      const invalid = musicPartyOriginError(target)
      if (invalid) return { ok: false, message: invalid }
      try {
        const member = linkleMemberOf(migrateLocalSettings(JSON.parse(localStorage.getItem("watchparty.local-settings") ?? "null")))
        const nickname = await getDesktopSettings().then(settings => settings.nickname).catch(() => null)
        const result = await musicParty.getConnection().run(target, adapter => adapter.redeemInvite(code.trim(), { join: false, displayName: linkleDisplayName(member, nickname) }))
        const probe = await probeMusicParty({ origin: target, nativeInvoke: invoke }).catch(() => null)
        const account = probe?.account ?? null
        return { ok: true, accountName: account ? (account.displayName || account.publicId) : (result.roomName ?? "已兑换邀请码") }
      } catch (error) { return { ok: false, message: inviteErrorMessage(error, "邀请码兑换失败，请检查服务地址与邀请码。") } }
    },
    async finish(setup) {
      try {
        const current = await getDesktopSettings()
        const nextOrigin = setup.backendOrigin && setup.backendOrigin.trim() ? setup.backendOrigin.trim() : current.backendOrigin
        const nextNickname = setup.nickname.trim() ? setup.nickname.trim() : current.nickname
        const updated = await updateDesktopSettings({ backendOrigin: nextOrigin, allowRemoteHttp: current.allowRemoteHttp, nickname: nextNickname, theme: current.theme, windowMaterial: current.windowMaterial, playerPreferences: current.playerPreferences, setupCompleted: true })
        setBackendOrigin(updated.backendOrigin)
        setSetupCompleted(true)
        return { ok: true }
      } catch (error) { return { ok: false, message: errorMessage(error, "无法完成配置，请稍后重试。") } }
    },
  }

  // 重新配置＝只重置完成位，绝不改动任何已存配置。
  const reconfigure = useCallback(async () => {
    try {
      const current = await getDesktopSettings()
      await updateDesktopSettings({ backendOrigin: current.backendOrigin, allowRemoteHttp: current.allowRemoteHttp, nickname: current.nickname, theme: current.theme, windowMaterial: current.windowMaterial, playerPreferences: current.playerPreferences, setupCompleted: false })
      setSetupCompleted(false)
    } catch (error) { session.setStatus({ text: errorMessage(error, "无法重新打开设置向导"), tone: "error" }) }
  }, [session.setStatus])
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    const apply = (settings: DesktopSettingsStatus) => {
      if (!disposed) { setThemePreference(settings.theme); setWindowMaterial(settings.windowMaterial); setBackendOrigin(settings.backendOrigin); setSetupCompleted(settings.setupCompleted) }
    }
    void listenForSettings(apply).then(async (stop) => {
      if (disposed) { stop(); return }
      unlisten = stop
      apply(await getDesktopSettings())
    }).catch(() => session.setStatus({ text: "无法读取桌面设置", tone: "error" }))
    return () => { disposed = true; unlisten?.() }
  }, [session.setStatus])
  useEffect(() => {
    if (previousBackendOrigin.current !== backendOrigin) {
      previousBackendOrigin.current = backendOrigin
      restoreAttemptedOrigin.current = null
      setRestorationSettledOrigin(null)
    }
    if (view !== "home" || product !== "watchparty") return
    if (!backendOrigin) {
      setBanguruProbe({ status: "unconfigured" })
      return
    }
    let disposed = false
    setBanguruProbe({ status: "checking", origin: backendOrigin })
    void probeDesktopBackend()
      .then((report: DesktopProbeReport) => {
        if (disposed) return
        setBanguruProbe({ status: "online", origin: backendOrigin, protocolVersion: report.protocolVersion, serviceVersion: report.serviceVersion, capabilities: report.capabilities })
        // Optional follow-up: a backend without the readiness capability, or a
        // failing probe, leaves `readiness` as null and the banner simply
        // omits its second line (never reported as degraded).
        void probeDesktopReadiness().then(readiness => {
          if (disposed) return
          setBanguruProbe(current => current.origin === backendOrigin && current.status === "online" ? { ...current, readiness } : current)
        })
      })
      .catch((error: unknown) => {
        if (disposed) return
        const message = errorMessage(error, typeof error === "string" ? error : "无法连接桌面服务")
        const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null
        setBanguruProbe({ status: "error", origin: backendOrigin, error: code ? `${code}：${message}` : message })
      })
    return () => { disposed = true }
  }, [backendOrigin, product, view])
  useEffect(() => {
    if (view !== "home" || product !== "watchparty" || !backendOrigin || banguruProbe.origin !== backendOrigin || banguruProbe.status !== "online" || !session.readyForRestore || restoreAttemptedOrigin.current === backendOrigin) return
    restoreAttemptedOrigin.current = backendOrigin
    if (!banguruProbe.capabilities?.restoreSession) {
      setRestorationSettledOrigin(backendOrigin)
      return
    }
    restoringSession.current = true
    void session.restore().finally(() => {
      restoringSession.current = false
      setRestorationSettledOrigin(backendOrigin)
    })
  }, [backendOrigin, banguruProbe, product, session.readyForRestore, session.restore, view])
  const activeProbe = banguruProbe.origin === backendOrigin ? banguruProbe : { status: "checking" as const }
  const capabilities = activeProbe.status === "online" ? activeProbe.capabilities : undefined
  const entryBusy = session.starting || (activeProbe.status === "online" && restorationSettledOrigin !== backendOrigin)
  const [fullscreen, setFullscreen] = useState(false)
  const [mica, setMica] = useState<{ image: string | null; average: string | null } | null>(null)
  useEffect(() => {
    if (windowMaterial !== "auto") return
    let disposed = false
    void getDesktopWallpaperBackdrop()
      .then((backdrop) => { if (!disposed) setMica(backdrop) })
      .catch(() => { if (!disposed) setMica(null) })
    return () => { disposed = true }
  }, [windowMaterial])
  const suspendedForNavigation = useRef(false)
  const previouslyConnected = useRef(false)
  const state = session.state
  // The joined room comes from the native session itself; the deep-link hint is
  // only a fallback before any session exists.
  const activeRoomId = state?.roomId ?? session.launchRoomId
  const isPlaybackView = product === "watchparty" && Boolean(state) && view === "room"

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")
    document.documentElement.classList.toggle("playback-mode", isPlaybackView)
    document.documentElement.dataset.windowMaterial = windowMaterial
    document.documentElement.style.colorScheme = theme
    return () => document.documentElement.classList.remove("playback-mode")
  }, [isPlaybackView, theme, windowMaterial])

  useEffect(() => {
    const title = product === "watchparty" ? "Banguru" : "Linkle"
    document.title = title
    const label = document.getElementById("watchparty-titlebar")?.querySelector(".wpc-title")
    if (label) label.textContent = title
    if (window.watchpartyDesktop) void invoke("updateDesktopWindowChrome", { title, theme, windowMaterial })
  }, [product, theme, windowMaterial])

  useEffect(() => {
    if (state && restoringSession.current) {
      // Restoring the last session keeps the connection alive without reopening playback.
      previouslyConnected.current = true
      pendingCreateRoom.current = false
      return
    }
    if (state && !previouslyConnected.current) {
      // 创建成功停在结果块（复制房号 / 进入房间）；标记在此消费一次，之后的会话（交接码等）照常进房。
      if (pendingCreateRoom.current) pendingCreateRoom.current = false
      else if (!switchingLobby.current) setView("room")
    }
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

  async function changeProduct(nextProduct: "watchparty" | "musicparty") {
    if (nextProduct === product) return
    if (nextProduct === "musicparty" && state?.playerWindowVisible) {
      suspendedForNavigation.current = await session.command({ type: "playerVisibility", visible: false })
    }
    setProduct(nextProduct)
    if (nextProduct === "watchparty" && view === "room" && suspendedForNavigation.current) {
      if (await session.command({ type: "playerVisibility", visible: true })) suspendedForNavigation.current = false
    }
    // 本地音频焦点跟着产品走（2026-10-02 验收暴露）：离开 Linkle 释放焦点、本地音乐随即暂停
    // （只动本地输出，不碰共享房间）；回到 Linkle 且连接里还有房间时重新请求，恢复播放。
    if (nextProduct === "musicparty") {
      if (musicParty.currentRoom()) await musicParty.setFocus("musicparty")
    } else {
      await musicParty.setFocus(null)
    }
  }

  async function openRoomDrawer(nextDrawer: Exclude<Drawer, null>) {
    await navigate("room")
    setDrawer(nextDrawer)
  }

  async function leaveRoom() {
    if (await session.stop()) {
      pendingCreateRoom.current = false
      setCurrentLobbyRoom(null)
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
          mediaQueueAvailable={capabilities?.mediaQueue ?? false}
          fullscreen={fullscreen}
          statusText={session.status.text}
          onFullscreenChange={setFullscreen}
          onDrawerChange={(nextDrawer) => { if (nextDrawer !== "queue" || capabilities?.mediaQueue) setDrawer((current) => current === nextDrawer ? null : nextDrawer) }}
          onOpenMedia={() => { if (capabilities?.mediaSearch || capabilities?.mediaQueue) void navigate("media") }}
          onLeave={() => void leaveRoom()}
        />
      ) : (
        <FluentProvider applyStylesToPortals={false} theme={winuiFluentTheme(theme === "dark" ? webDarkTheme : webLightTheme)} className="desktop-shell-surface desktop-shell-grid text-foreground" data-sidebar={sidebarCollapsed ? "collapsed" : "expanded"}>
          {windowMaterial === "auto" ? (
            <div className="desktop-mica-layer" style={mica?.average ? ({ "--mica-tint": mica.average } as CSSProperties) : undefined} aria-hidden="true">
              {mica?.image ? <div className="desktop-mica-image" style={{ backgroundImage: `url("${mica.image}")` }} /> : null}
            </div>
          ) : null}
          <ShellToastProvider>
          {/* M2.5：键盘用户跳过侧栏直达主内容；只在聚焦时可见。
              不真跳 #hash——ipc 守卫按完整 URL 校验，带 hash 的 frame 会被拒成 invalid_desktop_request。 */}
          <a className="desktop-skip-link" href="#desktop-main" onClick={(event) => { event.preventDefault(); document.getElementById("desktop-main")?.focus() }}>跳到主内容</a>
          <ShellStatusToast status={session.status} locallyHandledStatus={locallyHandledStatus} />
          <Sidebar
            collapsed={sidebarCollapsed}
            onCollapse={() => setSidebarCollapsed(value => { storeSidebar(!value); return !value })}
            backendOrigin={backendOrigin}
            product={product}
            onProduct={(next) => void changeProduct(next)}
            view={view}
            state={state}
            roomId={activeRoomId}
            status={session.status}
            onView={(nextView) => void navigate(nextView)}
            onDrawer={(nextDrawer) => { if (nextDrawer !== "queue" || capabilities?.mediaQueue) void openRoomDrawer(nextDrawer) }}
            servicesDisabled={setupCompleted === false}
          />
          <main id="desktop-main" tabIndex={-1} className="desktop-main">
            <div className={cn("desktop-page", view === "settings" && "desktop-page-settings")}>{view === "home" && setupCompleted === false ? (
              <SetupGuide services={setupServices} onDone={() => setSetupCompleted(true)} />
            ) : view === "home" ? (product === "musicparty" ? (currentLobbyRoom?.service === "musicparty" ? (
              <LinkleRoom
                room={currentLobbyRoom}
                connection={musicParty.getConnection()}
                subscribeRoom={musicParty.subscribeRoom}
                onLeave={() => setCurrentLobbyRoom(null)}
              />
            ) : <LobbyView facade={lobby!} origin={musicParty.serviceOrigin} busy={session.starting} activeRoom={currentLobbyRoom} onRedeemInvite={musicParty.redeemInvite} accountPanel={musicParty.content} onConnectAccount={musicParty.connectAccount} onRenameAccount={musicParty.renameAccount} onDisconnectAccount={musicParty.logout} defaultNickname={musicParty.suggestedNickname} />) : <BanguruLobby onStart={startSession} launchRoomId={session.launchRoomId} busy={entryBusy} probe={activeProbe} canCreate={currentLobbyRoom?.service !== "musicparty"} activeRoomId={state?.roomId ?? null} onCreate={async (nickname, pin) => { locallyHandledStatus.current = true; pendingCreateRoom.current = true; try { return await createDesktopRoom({ nickname, ...(pin ? { pin } : {}) }) } catch (error) { pendingCreateRoom.current = false; throw error } finally { setCompletedLocalNotice(value => value + 1) } }} onJoin={(roomId, nickname, pin) => switchLobby({ identity: { service: "watchparty", origin: backendOrigin ?? "", roomId }, password: pin }, nickname)} onEnterRoom={() => void navigate("room")} setupCompleted={setupCompleted === true} setupOrigin={backendOrigin} onReconfigure={() => void reconfigure()} />) : view === "room" ? (
              <HomeView
                state={state}
                roomId={activeRoomId}
                starting={session.starting}
                onStart={startSession}
                onCreate={session.createRoom}
                onAccess={session.accessRoom}
                onReturn={() => void navigate("room")}
                onProduct={(next) => void changeProduct(next)}
              />
            ) : view === "media" ? (
              <MediaLibraryView state={state} command={session.command} navigate={(nextView) => void navigate(nextView)} mediaSearchAvailable={capabilities?.mediaSearch ?? false} mediaQueueAvailable={capabilities?.mediaQueue ?? false} />
            ) : (
              <FluentSettingsView
                state={state}
                themePreference={themePreference}
                onThemeChange={(next) => persistTheme(next, windowMaterial, setThemePreference)}
                windowMaterial={windowMaterial}
                onWindowMaterialChange={() => persistWindowMaterial(windowMaterial, setWindowMaterial)}
                musicPartyOrigin={musicParty.serviceOrigin}
                onMusicPartyLogout={musicParty.logout}
              />
            )}</div>
            {currentLobbyRoom?.service !== "musicparty" && (currentLobbyRoom || state?.roomId) ? <SessionBar
              service="watchparty"
              roomId={currentLobbyRoom?.roomId ?? state?.roomId ?? ""}
              media={mediaTitle(state?.room?.source)}
              status={connectionLabel(state?.connection)}
              onReturn={() => {
                void changeProduct("watchparty").then(() => navigate("room"))
              }}
            /> : null}
          </main>
          </ShellToastProvider>
        </FluentProvider>
      )}

      {state && (state.connection === "expired" || state.connection === "failed") ? (
        <TerminalOverlay state={state} onLeave={() => void leaveRoom()} />
      ) : null}
    </TooltipProvider>
  )
}

/** A session affordance, kept separate from browsing navigation and only shown while connected. */
function SessionBar({ service, roomId, media, status, onReturn }: {
  service: "watchparty" | "musicparty"
  roomId: string
  media: string
  status: string
  onReturn: () => void
}) {
  const label = service === "musicparty" ? "Linkle" : "Banguru"
  const ServiceIcon = service === "musicparty" ? MusicNote2Regular : DesktopRegular
  return <section className="desktop-session-bar" aria-label={`当前 ${label} 会话`}>
    <div className="desktop-session-bar-service"><ServiceIcon /><span>{label}</span></div>
    <div className="desktop-session-bar-copy"><strong>{media}</strong><span>{roomId} · {status}</span></div>
    <span className="desktop-session-bar-permission">{service === "musicparty" ? "房主控制" : "同步播放"}</span>
    <Button variant="ghost" onClick={onReturn}>返回当前会话</Button>
  </section>
}

/** Collapsing the rail is local view state, remembered per machine. */
const SIDEBAR_KEY = "watchparty.ui.sidebar"
function storedSidebarCollapsed(): boolean {
  try { return window.localStorage.getItem(SIDEBAR_KEY) === "collapsed" } catch { return false }
}
function storeSidebar(collapsed: boolean) {
  try { window.localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded") } catch { /* storage disabled */ }
}

function Sidebar({ view, state, roomId, status, onView, onDrawer, backendOrigin, product, onProduct, collapsed, onCollapse, servicesDisabled }: {
  collapsed: boolean
  onCollapse: () => void
  backendOrigin: string | null
  product: "watchparty" | "musicparty"
  onProduct: (product: "watchparty" | "musicparty") => void
  view: View
  state: ReturnType<typeof useDesktopSession>["state"]
  roomId: string | null
  status: ReturnType<typeof useDesktopSession>["status"]
  onView: (view: View) => void
  onDrawer: (drawer: Exclude<Drawer, null>) => void
  servicesDisabled?: boolean
}) {
  return (
    <aside className={cn("desktop-sidebar", collapsed && "is-collapsed")}>
      <nav className="desktop-service-nav" aria-label="服务浏览">
        <Button variant="ghost" aria-label="Banguru 一起看" aria-current={product === "watchparty" ? "page" : undefined} disabled={servicesDisabled} onClick={() => { onProduct("watchparty"); onView("home") }}><DesktopRegular /><span><strong>Banguru</strong><small>一起看</small></span></Button>
        <Button variant="ghost" aria-label="Linkle 一起听" aria-current={product === "musicparty" ? "page" : undefined} disabled={servicesDisabled} onClick={() => { onProduct("musicparty"); onView("home") }}><MusicNote2Regular /><span><strong>Linkle</strong><small>一起听</small></span></Button>
      </nav>
      <div className={cn("desktop-session", !roomId && "desktop-session-empty")}>{roomId ? <><strong>{roomId}</strong><p>{state ? connectionLabel(state.connection) : status.text}</p><p>{backendOrigin ?? "Banguru 站点未配置"}</p></> : null}</div>
      <div className="desktop-settings-link"><Button variant="ghost" aria-label="设置" aria-current={view === "settings" ? "page" : undefined} onClick={() => onView("settings")}><SettingsRegular /><span>设置</span></Button><Button variant="ghost" aria-label={collapsed ? "展开侧栏" : "折叠侧栏"} onClick={onCollapse}>{collapsed ? <PanelLeftExpandRegular /> : <PanelLeftContractRegular />}</Button></div>
    </aside>
  )
}

/** M2.5：级别由调用点决定（页面标题 1、分节 2），不再硬编码 h1 复用到每一处。 */
function SectionTitle({ children, detail, level = 2 }: { children: string; detail?: string; level?: 1 | 2 | 3 }) {
  const Heading = `h${level}` as "h1" | "h2" | "h3"
  // 灰副标题收敛（观感批）：标题只留白字，保留的说明下沉为正文小字。
  return (
    <>
      <Heading className="text-sm font-semibold text-foreground">{children}</Heading>
      {detail ? <p className="mt-1 text-xs text-[var(--text-secondary)]">{detail}</p> : null}
    </>
  )
}

function HomeView({ state, roomId, starting, onStart, onCreate, onAccess, onReturn, onProduct }: { state: ReturnType<typeof useDesktopSession>["state"]; roomId: string | null; starting: boolean; onStart: (ticket: string) => Promise<boolean>; onCreate: (nickname: string, pin?: string) => Promise<boolean>; onAccess: (roomId: string, nickname: string, pin?: string) => Promise<boolean>; onReturn: () => void; onProduct: (product: "watchparty" | "musicparty") => void }) {
  const room = state?.room
  const [nickname, setNickname] = useState("")
  const [pin, setPin] = useState("")
  const [joinRoomId, setJoinRoomId] = useState("")
  return (
    <div className="mx-auto min-h-full w-full max-w-[var(--shell-content-wide)] px-8 py-8">
      <div className="mb-6 border-b border-[var(--stroke-card)] pb-4"><div className="flex items-center justify-between"><div><p className="text-xs text-[var(--text-secondary)]">Banguru · Watch Party</p><SectionTitle level={1}>房间工作台</SectionTitle></div><span className="text-xs text-[var(--text-secondary)]">桌面端 · Fluent</span></div><TabBar value="watchparty" onValueChange={(next) => { if (next !== "watchparty") onProduct("musicparty") }} panelId="workspace-panel" idPrefix="product-tab" label="产品切换" className="mt-4 flex items-end gap-1 border-b border-[var(--stroke-divider)]"><TabBarItem value="watchparty">Banguru <span className="ml-1 text-xs font-normal text-[var(--text-secondary)]">Watch Party</span></TabBarItem><TabBarItem value="musicparty">Linkle <span className="ml-1 text-xs">Music Party</span></TabBarItem></TabBar></div>
      <div id="workspace-panel" role="tabpanel" aria-labelledby="product-tab-watchparty">
      {state ? (
        <section className="mt-3 flex items-center gap-3 rounded-sm border border-[var(--stroke-card)] bg-[var(--fill-card)] px-4 py-3">
          <i className="size-2 rounded-full bg-positive" />
          <div className="min-w-0 flex-1 truncate text-xs text-[var(--text-secondary)]"><span className="font-mono text-foreground">{roomId ?? "room"}</span><span className="mx-2">·</span><span className="text-foreground">{mediaTitle(room?.source)}</span><span className="mx-2">·</span><span className="font-mono">{formatTime(state.player.time)} / {formatTime(state.player.duration)}</span></div>
          <Button variant="accent" size="sm" onClick={onReturn}>返回房间</Button>
        </section>
      ) : <p className="mt-3 text-xs text-[var(--text-secondary)]">尚未连接房间。请从网页端生成一次性交接码。</p>}
      {!state ? <>
        <SessionGate roomId={roomId} starting={starting} onStart={onStart} />
        <section className="mt-5 max-w-[var(--shell-content-narrow)] border-y border-[var(--stroke-card)] py-4">
          <p className="text-xs font-semibold">独立桌面会话</p>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">桌面端直接建房或输入房号加入，令牌只保存在本机凭据库。</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="昵称" aria-label="桌面昵称" />
            <Input value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="PIN（可选，4 位）" inputMode="numeric" aria-label="房间 PIN" />
            <Input value={joinRoomId} onChange={(event) => setJoinRoomId(event.target.value.trim())} placeholder="房号，例如 room-abc123" aria-label="要加入的房号" className="sm:col-span-2" />
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="accent" disabled={starting || !nickname.trim() || Boolean(pin && pin.length !== 4)} onClick={() => void onCreate(nickname.trim(), pin || undefined)}>创建房间</Button>
            <Button disabled={starting || !joinRoomId || !nickname.trim() || Boolean(pin && pin.length !== 4)} onClick={() => void onAccess(joinRoomId, nickname.trim(), pin || undefined)}>加入房间</Button>
          </div>
        </section>
      </> : (
        /* P1 死按钮收尾：会话在时这一行只是地址展示，把恒禁用按钮换成真能用的复制。 */
        <div className="mt-5 flex max-w-[var(--shell-content-narrow)] items-center gap-2"><Input disabled value={`watchparty://${roomId ?? "room"}`} aria-label="当前房间地址" className="font-mono text-xs" /><CopyButton value={`watchparty://${roomId ?? "room"}`} label="复制地址" /></div>
      )}
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <section className="border-y border-[var(--stroke-card)] py-4"><SectionTitle>服务与房间</SectionTitle><div className="mt-3 space-y-2 text-xs text-[var(--text-secondary)]"><p className="flex justify-between"><span>房间</span><span className="font-mono text-foreground">{roomId ?? "未加入"}</span></p><p className="flex justify-between"><span>播放会话</span><span className="text-foreground">{state ? "可恢复" : "等待连接"}</span></p><p className="flex justify-between"><span>队列</span><span className="text-foreground">{state ? "房间队列已同步" : "等待加入房间"}</span></p></div></section>
        <section className="border-y border-[var(--stroke-card)] py-4"><SectionTitle detail="需要进入房间后可用">协作摘要</SectionTitle><div className="mt-3 space-y-2 text-xs text-[var(--text-secondary)]"><p className="flex justify-between"><span>成员</span><span className="text-foreground">{state ? "在线成员已同步" : "尚未连接"}</span></p><p className="flex justify-between"><span>播放队列</span><span className="text-foreground">{state ? "打开房间查看" : "等待加入房间"}</span></p><Button className="mt-2" disabled={!state} onClick={onReturn}>打开播放房间</Button></div></section>
      </div>
      </div>
    </div>
  )
}

function useMusicPartyEntry(onInviteRoom: (identity: RoomIdentity) => Promise<void>, requestedOrigin?: string | null) {
  const activeRef = useRef(false)
  const roomListeners = useRef(new Set<(event: DomainEvent) => void>())
  const subscribeRoom = useCallback((listener: (event: DomainEvent) => void) => {
    roomListeners.current.add(listener)
    return () => { roomListeners.current.delete(listener) }
  }, [])
  // No built-in server: an unconfigured client says so, and the developer convenience lives in
  // LINKLE_DEV_ORIGIN, not in a constant that silently points at one machine's docker.
  const [origin, setOrigin] = useState(() => {
    try { return serviceForProduct(migrateLocalSettings(JSON.parse(localStorage.getItem("watchparty.local-settings") ?? "null")), "musicparty")?.origin ?? "" } catch { return "" }
  })
  const [serviceOrigin, setServiceOrigin] = useState(origin)
  const [invite, setInvite] = useState("")
  const [message, setMessage] = useState("")
  const [serverProbe, setServerProbe] = useState<MusicPartyProbe | null>(null)
  const [probing, setProbing] = useState(false)
  const [backendOrigin, setBackendOrigin] = useState<string | null>(null)
  useEffect(() => { void getDesktopSettings().then((s) => setBackendOrigin(s.backendOrigin)).catch(() => setMessage("请先配置后端站点")) }, [])
  useEffect(() => {
    if (!window.watchpartyDesktop) return
    let cancelled = false
    void window.watchpartyDesktop.invoke<{ origin: string | null; roomId: string | null; invite: string | null }>("getLinkleDevConfig").then(async config => {
      if (cancelled || !config.origin || !config.invite) return
      setOrigin(config.origin)
      setServiceOrigin(config.origin)
      try {
        const result = await redeemAndEnter(config.origin, config.invite)
        if (!cancelled && config.roomId && result.roomId !== config.roomId) setMessage(`调试邀请码进入了 ${result.roomId}，与 LINKLE_DEV_ROOM 不一致`)
        else if (!cancelled) setMessage(`已进入 ${result.roomName ?? result.roomId}`)
      } catch (error) { if (!cancelled) setMessage(inviteErrorMessage(error, "调试入口邀请码兑换失败，请确认服务地址和邀请码有效")) }
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])
  const [roomStatus, setRoomStatus] = useState("未进入房间")
  const [queueCount, setQueueCount] = useState(0)
  const [queueTitles, setQueueTitles] = useState<string[]>([])
  const [playing, setPlaying] = useState(false)
  const playerRef = useRef<NativeAudioPlayer | null>(null)
  const focusOwner = useRef(new AudioFocusOwner())
  useEffect(() => () => { void focusOwner.current.release("musicparty").catch(() => {}); void playerRef.current?.dispose().catch(() => {}) }, [])
  useEffect(() => {
    const subscription = listen<{ playerId: string; code: string }>("musicparty://audio-error", ({ payload }) => {
      if (payload.playerId === playerRef.current?.id) { setPlaying(false); setMessage("媒体解析或播放失败") }
    })
    return () => { void subscription.then(unlisten => unlisten()).catch(() => {}) }
  }, [])
  const connectionRef = useRef<MusicPartyConnection | null>(null)
  // 设置向导保存的 Linkle 地址要不重启就生效：向导在 App 层，碰不到这里的 state。
  useEffect(() => {
    if (!requestedOrigin || requestedOrigin === serviceOrigin || musicPartyOriginError(requestedOrigin)) return
    setOrigin(requestedOrigin)
    if (!connectionRef.current?.current?.roomId) setServiceOrigin(requestedOrigin)
  }, [requestedOrigin, serviceOrigin])
  const getConnection = () => {
    if (connectionRef.current) return connectionRef.current
    const connection = new MusicPartyConnection(
    (serviceOrigin, roomId) => {
      setServiceOrigin(serviceOrigin)
      setPlaying(false)
      setRoomStatus("未进入房间")
      setQueueCount(0)
      setQueueTitles([])
      return new MusicPartyAdapter({ origin: serviceOrigin, roomId, nativeInvoke: invoke })
    },
    event => {
      for (const listener of roomListeners.current) listener(event)
      if (event.type === "connection") {
        if (event.status === "ready") setMessage("已建立 Linkle 服务连接")
        else if (event.status === "failed" && event.message) setMessage(event.message)
      }
      if (event.type === "error") setMessage(event.message)
      if (event.type === "room") { setQueueCount(event.room?.queue?.length ?? 0); setQueueTitles((event.room?.queue ?? []).slice(0, 3).map(item => item.title)); setRoomStatus(event.room?.name ? `房间：${event.room.name}` : "已连接房间") }
      if (event.type === "playback") { setPlaying(event.snapshot.playing); setRoomStatus(event.snapshot.item?.title ? `播放中：${event.snapshot.item.title}` : "房间已连接") }
    },
    )
    const player = playerRef.current ?? new NativeAudioPlayer(invoke)
    playerRef.current = player
    focusOwner.current.register("musicparty", player)
    // Bind before hello and the initial snapshot, including entry into a playing room.
    connection.bindPlayer(player, () => activeRef.current ? focusOwner.current.request("musicparty") : Promise.resolve(false))
    connectionRef.current = connection
    return connection
  }
  // 建号时把本机 ID 报给服务端（用户 2026-09-25 定：自定义 ID 写进服务端，之后以服务端为基准）。
  // 本机 ID（设置向导将写进 linkleMember）优先，其次本机昵称，都没有才是「桌面用户」。
  const resolveDisplayName = async (): Promise<string> => {
    const member = (() => { try { return linkleMemberOf(migrateLocalSettings(JSON.parse(localStorage.getItem("watchparty.local-settings") ?? "null"))) } catch { return null } })()
    if (member?.name) return linkleDisplayName(member)
    const nickname = await getDesktopSettings().then(settings => settings.nickname).catch(() => null)
    return linkleDisplayName(member, nickname)
  }
  const redeemAndEnter = async (targetOrigin: string, code: string) => {
    const displayName = await resolveDisplayName()
    const result = await getConnection().run(targetOrigin, adapter => adapter.redeemInvite(code, { join: false, displayName }))
    await onInviteRoom({ service: "musicparty", origin: new URL(targetOrigin).origin, roomId: result.roomId })
    return result
  }
  // 连接卡的昵称预填：与建号用的是同一套本机身份（linkleMember → 桌面昵称 → 桌面用户）。
  const [suggestedNickname, setSuggestedNickname] = useState("")
  useEffect(() => {
    let disposed = false
    void resolveDisplayName().then(name => { if (!disposed) setSuggestedNickname(name) }).catch(() => undefined)
    return () => { disposed = true }
  }, [])
  /**
   * 游客连接（handoff §4）：先探测；同一 origin 已有有效会话就恢复身份，没有才用输入昵称建游客。
   * 连不上的地址不改动已保存的配置；建号成功但读回失败必须与「连接成功」区分（readback 语义）。
   */
  const connectAccount = async (target: string, displayNameInput: string): Promise<{ ok: boolean; message?: string; probe?: MusicPartyProbe | null }> => {
    const trimmed = target.trim()
    const invalid = musicPartyOriginError(trimmed)
    if (invalid) return { ok: false, message: invalid }
    const nickname = accountDisplayName(displayNameInput)
    if (!nickname) return { ok: false, message: "昵称需要 1–32 个字符" }
    let outcome: { probe: MusicPartyProbe; created: boolean }
    try {
      outcome = await getConnection().run(new URL(trimmed).origin, async adapter => {
        const existing = await probeMusicParty({ origin: trimmed, nativeInvoke: invoke }, { readiness: true })
        if (existing.status !== "ok" || existing.account) return { probe: existing, created: false }
        await adapter.createGuestSession(nickname)
        const readback = await probeMusicParty({ origin: trimmed, nativeInvoke: invoke }, { readiness: true })
        if (readback.status === "ok") await adapter.ensureProbe(true).catch(() => null)
        return { probe: readback, created: true }
      })
    } catch (error) {
      return { ok: false, message: accountErrorMessage(error, "无法连接服务器，请检查地址与网络。") }
    }
    if (outcome.probe.status !== "ok" || !outcome.probe.account) {
      return { ok: false, message: outcome.created ? "游客身份已建立，但读取账号失败，请重试连接。" : outcome.probe.message, probe: outcome.probe }
    }
    try {
      const settings = migrateLocalSettings(JSON.parse(localStorage.getItem("watchparty.local-settings") ?? "null"))
      const next = saveMusicPartyService(settings, outcome.probe.origin)
      localStorage.setItem("watchparty.local-settings", JSON.stringify(next))
      setOrigin(outcome.probe.origin)
      if (!connectionRef.current?.current?.roomId) setServiceOrigin(outcome.probe.origin)
      setServerProbe(outcome.probe)
      setMessage(`已连接 ${outcome.probe.origin}`)
    } catch { /* 存储失败不挡这次已建立的会话 */ }
    return { ok: true, probe: outcome.probe }
  }
  /** 改显示名（用户 2026-10-02 拍板）：服务端改 displayName（publicId 不动），并同步本机桌面昵称。 */
  const renameAccount = async (displayNameInput: string): Promise<{ ok: boolean; message?: string; probe?: MusicPartyProbe | null }> => {
    const nickname = accountDisplayName(displayNameInput)
    if (!nickname) return { ok: false, message: "昵称需要 1–32 个字符" }
    try {
      await getConnection().run(serviceOrigin, async adapter => {
        await adapter.updateDisplayName(nickname)
        await adapter.ensureProbe(true).catch(() => null)
      })
    } catch (error) {
      return { ok: false, message: accountErrorMessage(error, "改名失败，请检查与服务器的连接。") }
    }
    try {
      const current = await getDesktopSettings()
      await updateDesktopSettings({ backendOrigin: current.backendOrigin, allowRemoteHttp: current.allowRemoteHttp, nickname, theme: current.theme, windowMaterial: current.windowMaterial, playerPreferences: current.playerPreferences })
    } catch { /* 服务端已生效；本机昵称镜像失败不挡这次改名 */ }
    const probe = await probeMusicParty({ origin: serviceOrigin, nativeInvoke: invoke }, { readiness: true }).catch(() => null)
    if (probe?.status === "ok") setServerProbe(probe)
    return { ok: true, probe: probe?.status === "ok" ? probe : null }
  }
  useEffect(() => () => { const old = connectionRef.current; connectionRef.current = null; void old?.dispose() }, [])
  const connect = async () => {
    try { await getConnection().run(origin, adapter => adapter.connect()) } catch { setMessage("无法连接 Linkle 服务") }
  }
  // Probing is read-only: an unsaved or incompatible address must not disturb a live room.
  const probe = async () => {
    const invalid = musicPartyOriginError(origin)
    if (invalid) { setServerProbe(null); setMessage(invalid); return }
    setProbing(true)
    try { const result = await probeMusicParty({ origin, nativeInvoke: invoke }); setServerProbe(result); setMessage(result.message) }
    catch { setServerProbe(null); setMessage("服务地址无效或无法访问，请检查后重试") }
    finally { setProbing(false) }
  }
  const logout = async () => {
    const targetOrigin = serviceOrigin
    try {
      // run() builds an adapter for a session that never joined a room, so the server-side
      // revoke still happens; adapter.logout() clears the local credentials either way.
      await getConnection().run(targetOrigin, adapter => adapter.logout())
    } catch {
      await invoke<void>("clearMusicPartySession", { origin: targetOrigin }).catch(() => undefined)
    }
    await playerRef.current?.stop()
    setPlaying(false)
    setRoomStatus("未进入房间")
    setQueueCount(0)
    setQueueTitles([])
  }
  const saveService = () => {
    const invalid = musicPartyOriginError(origin)
    if (invalid) { setServerProbe(null); setMessage(invalid); return }
    try {
      const settings = migrateLocalSettings(JSON.parse(localStorage.getItem("watchparty.local-settings") ?? "null"))
      const next = saveMusicPartyService(settings, origin)
      localStorage.setItem("watchparty.local-settings", JSON.stringify(next))
      // Saving switches the active server unless a room session is live: browsing the lobby
      // creates an adapter, and that used to pin the old address behind the settings field.
      if (!connectionRef.current?.current?.roomId) setServiceOrigin(serviceForProduct(next, "musicparty")?.origin ?? "")
      setMessage("服务地址已保存")
    } catch { setMessage("服务地址无效或无法保存") }
  }
  const content = <section className="mt-10 border-t border-border pt-5">
    <div className="mt-2 flex items-center gap-2"><div><p className="text-xs text-muted-foreground" role="status">{roomStatus} · 队列 {queueCount}</p>{queueTitles.length ? <p className="text-xs text-muted-foreground">{queueTitles.join(" · ")}</p> : null}</div>{playerRef.current ? <Button size="sm" variant="outline" onClick={() => { const p = playerRef.current; if (!p) return; void (playing ? p.pause() : p.resume()).then(() => setPlaying(!playing)) }}>{playing ? "暂停" : "继续"}</Button> : null}</div>
    <div className="mt-3 grid items-center gap-2 sm:grid-cols-[1fr_auto]" ><Input value={origin} onChange={(event) => { setOrigin(event.target.value); setServerProbe(null) }} placeholder="https://music.example.com" aria-label="Linkle 服务地址" className="font-mono text-xs" /><div className="flex gap-2"><Button variant="outline" size="icon-sm" aria-label="保存服务" title="保存服务地址" disabled={!origin.trim()} onClick={saveService}><SaveRegular /></Button><Button variant="ghost" size="icon-sm" aria-label="探测" title="只读探测这台服务器：健康、能力、当前账号（不进房间）" disabled={!origin.trim() || probing} onClick={() => void probe()}><PulseRegular /></Button><Button variant="ghost" size="icon-sm" aria-label="连接" title="用已保存的凭据连接" disabled={!origin.trim()} onClick={() => void connect()}><PlugConnectedRegular /></Button></div></div>
    {serverProbe ? <p className="mt-2 text-xs text-muted-foreground" role="status">{probeSummary(serverProbe)}</p> : null}
    <div className="mt-2 grid items-center gap-2 sm:grid-cols-[1fr_auto]"><Input value={invite} onChange={(event) => setInvite(event.target.value)} placeholder="输入 Linkle 邀请码" aria-label="Linkle 邀请码" /><Button size="icon-sm" aria-label="兑换并进入" title="兑换邀请码并进入房间" disabled={!origin.trim() || !invite.trim()} onClick={() => { void redeemAndEnter(origin, invite.trim()).then((result) => setMessage(`已进入 ${result.roomName ?? result.roomId}`)).catch((error) => setMessage(inviteErrorMessage(error, "邀请兑换失败，请检查服务地址和邀请码有效"))) }}><KeyRegular /></Button></div>
    <div className="mt-2 flex gap-3 text-xs text-muted-foreground"><button type="button" className="hover:text-foreground" onClick={() => setMessage("Cookie 将由系统安全存储管理")}>导入 Cookie</button><button type="button" className="hover:text-foreground" onClick={() => setMessage("迁移包导入将在阶段 2 后续接入")}>导入 Web 迁移包</button></div>
    {message ? <p className="mt-2 text-xs text-muted-foreground" role="status">{message}</p> : null}
  </section>
  return { content, serviceOrigin, logout, getConnection, subscribeRoom,
    /** The lobby's invite card enters a friend's room without going through the collapsed panel. */
    redeemInvite: (code: string) => redeemAndEnter(serviceOrigin, code),
    /** 大厅游客连接与改显示名（2026-10-02 handoff §4）；断开放口复用 logout。 */
    connectAccount, renameAccount, suggestedNickname,
    currentRoom: (): RoomIdentity | null => { const adapter = connectionRef.current?.current; return adapter?.roomId ? { service: "musicparty", origin: adapter.origin, roomId: adapter.roomId } : null },
    setFocus: async (service: RoomIdentity["service"] | null) => {
      activeRef.current = service === "musicparty"
      if (service === "musicparty") await focusOwner.current.request("musicparty")
      else await focusOwner.current.release("musicparty")
    },
  }
}

function inviteErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message && error.message !== "http-error" ? error.message : fallback
}

/** 游客连接/改名的错误文案：服务端 400/401/403 与网络失败分开说（handoff §3/§4 错误表）。 */
function accountErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof MusicPartyAccountError) {
    return error.code === "invalid-input" ? "昵称需要 1–32 个字符"
      : error.code === "unauthorized" ? "本机还没有会话，请先连接服务器。"
      : error.code === "unreachable" ? "无法连接服务器，请检查地址与网络。"
      : error.code === "invalid-response" ? "服务器响应无法识别，账号信息不完整。"
      : "服务器拒绝了这次请求，请稍后重试。"
  }
  return inviteErrorMessage(error, fallback)
}

function probeSummary(probe: MusicPartyProbe): string {
  const features = Object.entries(probe.features).filter(([, enabled]) => enabled).map(([id]) => id)
  const parts = [`API ${probe.apiVersion ?? "未知"}`]
  if (probe.serverVersion) parts.push(`服务 ${probe.serverVersion}`)
  if (probe.status !== "ok") parts.push(`期望 ${probe.expectedApiVersion}`, `客户端 ${probe.clientVersion}`)
  parts.push(`平台 ${probe.providers.length ? probe.providers.join("、") : "无"}`, `能力 ${features.length ? features.join("、") : "无"}`)
  return parts.join(" · ")
}

function EmptyPosterGrid({ label, busy = false }: { label: string; busy?: boolean }) {
  return (
    <div className="mt-3 grid grid-cols-5 gap-3" aria-label={label} role={busy ? "status" : undefined} aria-live={busy ? "polite" : undefined}>
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="min-w-0"><div className="grid aspect-[16/10] place-items-center rounded-lg border border-[var(--stroke-card)] bg-[var(--fill-card)] text-center text-xs text-muted-foreground">{index === 0 ? (busy ? <span className="inline-flex items-center gap-2"><ProgressRing size={16} />{label}</span> : label) : null}</div><div className="mt-2 h-2.5 w-3/4 rounded-sm bg-[var(--stroke-divider)]" aria-hidden="true" /><div className="mt-1.5 h-2 w-1/2 rounded-sm bg-[var(--fill-selected)]" aria-hidden="true" /></div>
      ))}
    </div>
  )
}

function MediaLibraryView({ state, command, navigate, mediaSearchAvailable, mediaQueueAvailable }: {
  state: ReturnType<typeof useDesktopSession>["state"]
  command: (command: DesktopCommand) => Promise<boolean>
  navigate: (view: View) => void
  mediaSearchAvailable: boolean
  mediaQueueAvailable: boolean
}) {
  // 多源库（phase 1）：capabilities.libraries 为真走 /api/media/libraries + list?libraryId=；
  // 为假时退回旧的 root= 路由，老后端仍然能用（旧路由由后端在两端上线一周后删掉）。
  const [capabilities, setCapabilities] = useState<MediaCapabilities | null>(null)
  const [libraries, setLibraries] = useState<MediaLibrary[]>([])
  const [activeLibraryId, setActiveLibraryId] = useState<string | null>(null)
  const [roots, setRoots] = useState<string[]>([])
  const [activeRoot, setActiveRoot] = useState<string | null>(null)
  const [view, setView] = useState<MediaView | null>(null)
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  /** P2 收尾：搜索请求在途指示（searching 只是模式开关，不代表请求）。 */
  const [searchPending, setSearchPending] = useState(false)
  const [message, setMessage] = useState("")
  // 相位 3：标题墙。模式按库记忆（裁决 ②：整页 + 切库不重置视图），默认 Titles。
  const [modeByLibrary, setModeByLibrary] = useState<Record<string, "titles" | "files">>({})
  const [wall, setWall] = useState<Wall | null>(null)
  const [detail, setDetail] = useState<WallDetail | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const detailRequest = useRef(0)
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [catalogQuery, setCatalogQuery] = useState("")
  const [scrape, setScrape] = useState<ScrapeJob | null>(null)
  const [showAllFiles, setShowAllFiles] = useState(false)
  // 冠军稿的「只看待确认」：只在已载入的那一页里筛，不额外打请求。
  const [onlyReview, setOnlyReview] = useState(false)
  const [backendOrigin, setBackendOrigin] = useState<string | null>(null)
  useEffect(() => { void getDesktopSettings().then((s) => setBackendOrigin(s.backendOrigin)).catch(() => setMessage("请先配置后端站点")) }, [])
  const canPlay = Boolean(state?.isOwner)
  const canQueue = state?.connection === "ready" && Boolean(state.room)
  const usesLibraries = capabilities?.libraries === true
  const activeLibrary = libraries.find(entry => entry.id === activeLibraryId) ?? null
  const mode: "titles" | "files" = activeLibraryId ? modeByLibrary[activeLibraryId] ?? "titles" : "files"

  const loadLibrary = useCallback(async (libraryId: string, targetPath: string, cursor?: string) => {
    try {
      const next = toView(await mediaLibraryPage({ libraryId, path: targetPath, cursor }), libraryArtwork)
      setView(current => cursor && current ? { ...next, cards: [...current.cards, ...next.cards] } : next)
      setMessage("")
    } catch (error) {
      // 换库失败必须把上一个库的卡片清掉，否则会在坏库的面包屑下显示别的库的内容。
      if (!cursor) setView(null)
      setMessage(mediaErrorText(error, "无法载入这个库"))
    }
  }, [])

  const loadLegacy = useCallback(async (root: string, targetPath: string, cursor?: string) => {
    try {
      const next = legacyView(await mediaList(root, targetPath, cursor), targetPath)
      setView(current => cursor && current ? { ...next, cards: [...current.cards, ...next.cards] } : next)
      setMessage("")
    } catch (error) {
      setMessage(mediaErrorText(error, "无法载入媒体目录"))
    }
  }, [])

  const searchLibrary = useCallback(async (libraryId: string, text: string, cursor?: string) => {
    try {
      const next = toView(await mediaLibrarySearch({ libraryId, q: text, cursor }), libraryArtwork)
      setView(current => cursor && current ? { ...next, cards: [...current.cards, ...next.cards] } : next)
      setMessage(next.cards.length ? "" : "没有匹配的文件")
    } catch (error) {
      setMessage(mediaErrorText(error, "搜索失败"))
    }
  }, [])

  const searchLegacy = useCallback(async (text: string, cursor?: string) => {
    try {
      const next = legacyView(await mediaSearch(text, cursor), "/")
      setView(current => cursor && current ? { ...next, cards: [...current.cards, ...next.cards] } : next)
      setMessage(next.cards.length ? "" : "没有匹配的文件")
    } catch (error) {
      setMessage(mediaErrorText(error, "搜索失败"))
    }
  }, [])


  /** 面包屑与"载入更多"都从当前数据源重新取，客户端不自造路径。 */
  function openPath(targetPath: string, cursor?: string) {
    if (usesLibraries) {
      if (activeLibraryId) void loadLibrary(activeLibraryId, targetPath, cursor)
      return
    }
    if (activeRoot) void loadLegacy(activeRoot, targetPath, cursor)
  }

  function retry() {
    if (usesLibraries && activeLibraryId) {
      if (mode === "titles") { void loadWall(activeLibraryId, undefined, catalogQuery.trim() || undefined); return }
      void loadLibrary(activeLibraryId, view?.currentPath ?? "/")
      return
    }
    if (activeRoot) void loadLegacy(activeRoot, view?.currentPath ?? "/")
  }

  /** 新增源：服务端整单验证，成功后才回库列表，然后把新源的第一个库切到前面。 */
  function runSearch(text: string, cursor?: string): Promise<unknown> | undefined {
    setSearching(true)
    if (usesLibraries) {
      if (!activeLibraryId) return
      if (mode === "titles") { setCatalogQuery(text); return loadWall(activeLibraryId, cursor, text) }
      return searchLibrary(activeLibraryId, text, cursor)
    }
    return searchLegacy(text, cursor)
  }

  const loadWall = useCallback(async (libraryId: string, cursor?: string, q?: string) => {
    try {
      const next = toWall(await catalogPage({ libraryId, cursor, q }), catalogPoster)
      setWall(current => cursor && current ? { ...next, cards: [...current.cards, ...next.cards] } : next)
      setMessage("")
    } catch (error) {
      // 换库失败不能留着上一个库的墙。
      if (!cursor) setWall(null)
      setMessage(catalogErrorText(error, "无法读取标题库"))
    }
  }, [])

  const openDetail = useCallback(async (card: WallCard) => {
    const itemId = card.id
    const request = ++detailRequest.current
    setSelectedId(itemId)
    setCatalogBusy(true)
    // Mount the panel from the card immediately. The native IPC request can be
    // slower than the backend itself, so the first paint must not wait for it.
    setDetail({
      id: card.id,
      title: card.title,
      source: null,
      year: card.year,
      originalTitle: null,
      overview: null,
      status: card.status,
      statusLabel: card.statusLabel,
      posterUrl: card.posterUrl,
      subtitle: card.subtitle,
      candidates: [],
      seasons: [],
      single: false,
    })
    try {
      const base = await catalogDetail(itemId, false)
      if (request !== detailRequest.current) return
      setDetail(toDetail(base, catalogPoster))
      setCatalogBusy(false)
      if (base.status === "confirmed" && base.children.some(child => child.episode !== null)) {
        void catalogDetail(itemId).then(enriched => {
          if (request === detailRequest.current) setDetail(toDetail(enriched, catalogPoster))
        }).catch(() => {})
      }
    } catch (error) {
      if (request !== detailRequest.current) return
      setDetail(null)
      setMessage(catalogErrorText(error, "无法读取这个条目"))
    } finally {
      if (request === detailRequest.current) setCatalogBusy(false)
    }
  }, [])

  function closeDetail() {
    detailRequest.current += 1
    setDetail(null)
    setSelectedId(null)
  }

  /** 确认/拒绝是唯一两种标题库写入；两个都不碰凭据。 */
  async function reviewCandidate(action: "confirm" | "reject", candidateId: string) {
    if (!detail || catalogBusy) return
    const request = ++detailRequest.current
    setCatalogBusy(true)
    try {
      const next = action === "confirm" ? await catalogConfirm(detail.id, candidateId) : await catalogReject(detail.id, candidateId)
      if (request !== detailRequest.current) return
      setDetail(toDetail(next, catalogPoster))
      // 确认会换掉墙上的标题/年份/海报，整页重取一次最省事。
      if (activeLibraryId) void loadWall(activeLibraryId, undefined, catalogQuery.trim() || undefined)
      setMessage(action === "confirm" ? `已确认《${next.title}》` : "已拒绝这个候选，下次刮削不会再提")
    } catch (error) {
      setMessage(catalogErrorText(error, "这条写入没成功"))
    } finally {
      if (request === detailRequest.current) setCatalogBusy(false)
    }
  }

  /** 撤销确认：绑定清空、标题回到解析名，文件一张不丢（后端 2026-09-27 的编辑 API）。 */
  async function unconfirmCurrent() {
    if (!detail || catalogBusy) return
    const request = ++detailRequest.current
    setCatalogBusy(true)
    try {
      const next = await catalogUnconfirm(detail.id)
      if (request !== detailRequest.current) return
      setDetail(toDetail(next, catalogPoster))
      if (activeLibraryId) void loadWall(activeLibraryId, undefined, catalogQuery.trim() || undefined)
      setMessage(`已撤销确认：${next.title}`)
    } catch (error) {
      setMessage(catalogErrorText(error, "撤销没成功"))
    } finally {
      if (request === detailRequest.current) setCatalogBusy(false)
    }
  }

  /** 人工挑条目：刮削提不出正确条目时的出口。 */
  async function searchBangumi(query: string): Promise<BangumiHit[]> {
    const result = await bangumiSearch(query.trim())
    return (result.items ?? []).filter(hit => hit.externalDb === "bangumi")
  }

  /** 换绑：直接绑一个条目，服务端走 confirmed_by='rebind' 并顺带拉封面。 */
  async function rebindCurrent(hit: BangumiHit) {
    if (!detail || catalogBusy) return
    const request = ++detailRequest.current
    setCatalogBusy(true)
    try {
      const next = await catalogRebind(detail.id, {
        externalDb: hit.externalDb, externalId: hit.externalId, title: hit.title,
        year: hit.year ?? null, originalTitle: hit.originalTitle ?? null,
      })
      if (request !== detailRequest.current) return
      setDetail(toDetail(next, catalogPoster))
      if (activeLibraryId) void loadWall(activeLibraryId, undefined, catalogQuery.trim() || undefined)
      setMessage(`已绑定《${next.title}》`)
    } catch (error) {
      setMessage(catalogErrorText(error, "换绑没成功"))
    } finally {
      if (request === detailRequest.current) setCatalogBusy(false)
    }
  }

  /** 刮削只给管理员：本机桌面端能看到这个按钮，网页端拿不到 mediaAdmin。 */
  async function updateScrape() {
    if (!activeLibraryId || catalogBusy) return
    setCatalogBusy(true)
    try {
      // 后端有个已知竞态：首次 POST 可能先回 404 而任务其实已经跑起来了，
      // 所以这里不把 POST 的失败当结论，接着读一次状态。
      await startLibraryScrape(activeLibraryId).catch(() => null)
      const job = await libraryScrapeStatus(activeLibraryId)
      setScrape(job)
      void loadWall(activeLibraryId, undefined, catalogQuery.trim() || undefined)
      setMessage(scrapeSummary(job))
    } catch (error) {
      setMessage(catalogErrorText(error, "刮削没启动"))
    } finally {
      setCatalogBusy(false)
    }
  }

  async function refreshScrape() {
    if (!activeLibraryId) return
    await refreshScrapeFor(activeLibraryId)
  }

  const refreshScrapeFor = useCallback(async (libraryId: string) => {
    try { setScrape(await libraryScrapeStatus(libraryId)) } catch { setScrape(null) }
  }, [])

  /** 换模式只补自己缺的那半：标题墙和目录页各自缓存，来回切不重发。 */
  function selectMode(next: "titles" | "files") {
    if (!activeLibraryId) return
    setModeByLibrary(current => ({ ...current, [activeLibraryId]: next }))
    setSearching(false)
    setQuery("")
    setCatalogQuery("")
    setOnlyReview(false)
    setMessage("")
    if (next === "titles") {
      if (!wall) void loadWall(activeLibraryId)
      void refreshScrape()
      return
    }
    if (!view) void loadLibrary(activeLibraryId, "/")
  }

  /** 换库：两个视图都清掉，再按当前模式补数据。 */
  function selectLibrary(libraryId: string) {
    detailRequest.current += 1
    setActiveLibraryId(libraryId)
    setSearching(false)
    setQuery("")
    setCatalogQuery("")
    setView(null)
    setWall(null)
    setDetail(null)
    setSelectedId(null)
    setScrape(null)
    setOnlyReview(false)
    setMessage("")
    const next = modeByLibrary[libraryId] ?? "titles"
    if (next === "titles") { void loadWall(libraryId); void refreshScrapeFor(libraryId); return }
    void loadLibrary(libraryId, "/")
  }

  /** 标题墙的播放走和文件视图同一条房间路径，只是 mediaId 来自条目的子项。 */
  async function playCatalogChild(mediaId: string, title: string, container: string) {
    if (!canPlay) {
      setMessage("选片仅限房主操作")
      return
    }
    const media: MediaSource = { kind: "openlist", mediaId, title, container: container || "mp4" }
    if (await command({ type: "mediaSet", media })) {
      setMessage(`正在播放 ${title}`)
      navigate("room")
    }
  }

  async function enqueueCatalogChild(mediaId: string, title: string, container: string) {
    if (!mediaQueueAvailable) return
    if (!canQueue) {
      setMessage("请先加入房间")
      return
    }
    const media: MediaSource = { kind: "openlist", mediaId, title, container: container || "mp4" }
    if (await command({ type: "playlistAdd", media })) setMessage(`已加入队列：${title}`)
  }

  async function playCard(card: MediaCard) {
    if (card.kind === "dir") {
      setSearching(false)
      setQuery("")
      // 库模式下目录带自己的 relativePath（服务端给的）；旧路由只有名字，只能按名字拼。
      openPath(usesLibraries ? card.relativePath || "/" : childDirectoryPath(view?.currentPath ?? "/", card.title))
      return
    }
    if (!card.playable) {
      setMessage(card.note ?? "桌面端无法播放这个文件")
      return
    }
    if (!canPlay) {
      setMessage("选片仅限房主操作")
      return
    }
    const media: MediaSource = { kind: "openlist", mediaId: card.id, title: card.title, container: card.extension || "mp4" }
    if (await command({ type: "mediaSet", media })) {
      setMessage(`正在播放 ${card.title}`)
      navigate("room")
    }
  }

  async function enqueueCard(card: MediaCard) {
    if (!mediaQueueAvailable || !card.playable) return
    if (!canQueue) {
      setMessage("请先加入房间")
      return
    }
    const media: MediaSource = { kind: "openlist", mediaId: card.id, title: card.title, container: card.extension || "mp4" }
    if (await command({ type: "playlistAdd", media })) setMessage(`已加入队列：${card.title}`)
  }

  useEffect(() => {
    let live = true
    void (async () => {
      let caps: MediaCapabilities | null = null
      try { caps = await mediaCapabilities() } catch { caps = null }
      if (!live) return
      setCapabilities(caps)
      if (caps?.libraries === true) {
        try {
          // 顺序按服务端返回（seed 在前），客户端不排序。
          const list = await mediaLibraries()
          if (!live) return
          setLibraries(list)
          const first = list[0]
          if (first) {
            setActiveLibraryId(first.id)
            // 默认进 Titles（裁决 ②）；文件视图切过去时再按需载入。
            await loadWall(first.id)
            void refreshScrapeFor(first.id)
          } else {
            setMessage("这台服务器还没有可浏览的库")
          }
        } catch (error) {
          if (live) setMessage(mediaErrorText(error, "无法读取媒体库列表"))
        }
        return
      }
      try {
        const names = await mediaRoots()
        if (!live) return
        setRoots(names)
        if (names.length > 0) {
          setActiveRoot(names[0]!)
          await loadLegacy(names[0]!, "/")
        }
      } catch {
        if (live) setMessage("媒体浏览需要先配置站点")
      }
    })()
    return () => { live = false }
  }, [loadLibrary, loadLegacy, loadWall, refreshScrapeFor])

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
    if (!play && !mediaQueueAvailable) return
    if (play && !canPlay) {
      setMessage("选片仅限房主操作")
      return
    }
    if (!play && !canQueue) {
      setMessage("请先加入房间")
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

  const currentSourceName = usesLibraries ? activeLibrary?.name ?? null : activeRoot
  // 库本身不可用时，横幅已经说清「哪个库坏了、其它库不受影响」，行内错误就不再重复一遍。
  const unhealthyLibrary = usesLibraries && !searching && activeLibrary && activeLibrary.health !== "ok" ? activeLibrary : null
  const overlayHost = document.querySelector(".desktop-main")

  return (
    <div className="media-library-view mx-auto min-h-full w-full max-w-[var(--shell-content-wide)] px-8 py-8">
      <header className="flex flex-wrap items-center gap-3">
        <SectionTitle level={1}>媒体库</SectionTitle>
        <div className="flex-1" />
        {usesLibraries
          ? libraries.map((library) => (
            <button
              key={library.id}
              type="button"
              className={cn("media-lib-chip", library.id === activeLibraryId && !searching && "on")}
              aria-pressed={library.id === activeLibraryId && !searching}
              title={`${library.sourceName} · ${libraryKindLabel(library.kind)} · ${healthLabel(library.health)}`}
              onClick={() => selectLibrary(library.id)}
            >
              <span className={cn("media-lib-health", library.health)} aria-hidden="true" />
              <span className="min-w-0 truncate">{library.name}</span>
              <span className="media-lib-kind">{libraryKindLabel(library.kind)}</span>
            </button>
          ))
          : roots.map((root) => (
            <Button key={root} size="sm" variant={root === activeRoot && !searching ? "default" : "ghost"}
              className="px-3"
              onClick={() => { setActiveRoot(root); setSearching(false); setQuery(""); void loadLegacy(root, "/") }}>
              {root}
            </Button>
          ))}
        {usesLibraries && activeLibraryId ? (
          <div className="seg" role="group" aria-label="媒体库视图">
            <button type="button" className={cn("seg-item", mode === "titles" && "on")} aria-pressed={mode === "titles"} onClick={() => selectMode("titles")}>点播</button>
            <button type="button" className={cn("seg-item", mode === "files" && "on")} aria-pressed={mode === "files"} onClick={() => selectMode("files")}>文件</button>
          </div>
        ) : null}
        {mediaSearchAvailable ? <form className="relative w-56" onSubmit={(event) => {
          event.preventDefault()
          if (!query.trim() || searchPending) return
          setSearchPending(true)
          Promise.resolve(runSearch(query.trim())).catch(() => {}).finally(() => setSearchPending(false))
        }}>
          <SearchRegular className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={mode === "titles" ? "搜索标题…" : "搜索文件名…"} aria-label={mode === "titles" ? "搜索标题" : "搜索媒体"} disabled={searchPending} className={cn("h-8 pl-9 text-xs", searchPending && "pr-8")} />
          {searchPending ? <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2"><ProgressRing size={16} /></span> : null}
        </form> : null}
      </header>

      {/* 添加/管理片源已经搬到「设置 · 媒体库」：房间里只做选片。 */}

      {unhealthyLibrary ? (
        <div className="mt-3 flex items-center gap-3 border border-[var(--stroke-card)] bg-[var(--fill-card)] px-3 py-2 text-xs text-muted-foreground" role="status">
          <span>这个库当前不可用（{healthLabel(unhealthyLibrary.health)}）。其它库不受影响。</span>
          <Button size="sm" variant="outline" onClick={retry}>重试</Button>
        </div>
      ) : null}

      <form className="mt-4 flex flex-wrap items-center gap-2 border-y border-border py-3" onSubmit={(event) => event.preventDefault()}>
        <span className="text-xs font-semibold text-muted-foreground">粘贴 HTTPS / HLS</span>
        <Input value={pasteUrl} onChange={(event) => setPasteUrl(event.target.value)} placeholder="https://example.com/video.mp4 或 .m3u8" aria-label="粘贴媒体地址" className="h-8 min-w-64 flex-1 font-mono text-xs" />
        <Input value={pasteTitle} onChange={(event) => setPasteTitle(event.target.value)} placeholder="标题（可选）" aria-label="粘贴媒体标题" className="h-8 w-40 text-xs" />
        <Button size="sm" disabled={!canPlay || !pasteUrl.trim()} onClick={() => void submitPaste(true)}>
          <PlayRegular />播放
        </Button>
        <Button variant="outline" size="sm" disabled={!mediaQueueAvailable || !canQueue || !pasteUrl.trim()} onClick={() => void submitPaste(false)}>
          <AddRegular />入队
        </Button>
      </form>

      {usesLibraries && activeLibraryId && mode === "titles" ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{wall ? `${wall.cards.filter(card => card.status !== "unmatched").length} 个标题 · ${wall.cards.filter(card => card.needsReview).length} 个待确认` : "正在读取标题库…"}</span>
          {wall && wall.cards.some(card => card.needsReview) ? (
            <Button size="sm" variant={onlyReview ? "default" : "ghost"} aria-pressed={onlyReview} onClick={() => setOnlyReview(value => !value)}>
              只看待确认
            </Button>
          ) : null}
          {catalogQuery.trim() ? (
            <span className="catalog-query">标题：{catalogQuery}
              <button type="button" onClick={() => { setCatalogQuery(""); setSearching(false); setQuery(""); if (activeLibraryId) void loadWall(activeLibraryId) }}>清除</button>
            </span>
          ) : null}
          <span className="flex-1" />
          {scrape ? <span role="status">{scrapeSummary(scrape)}<button type="button" className="ml-2 underline" onClick={() => void refreshScrape()}>刷新</button></span> : null}
          {capabilities?.mediaAdmin === true ? (
            <Button size="sm" variant="outline" disabled={catalogBusy} onClick={() => void updateScrape()}>
              <ArrowSyncRegular />更新标题库
            </Button>
          ) : null}
        </div>
      ) : null}

      {usesLibraries && activeLibraryId && mode === "titles" ? (
        wall ? (
          <>
            <div className="catalog-split">
              <CatalogWall
                cards={wall.cards.filter(card => card.status !== "unmatched" && (!onlyReview || card.needsReview))}
                selectedId={selectedId}
                onSelect={card => void openDetail(card)}
              />
            </div>
            {detail && overlayHost ? createPortal(
              <div className="catalog-detail-overlay">
                <button type="button" className="catalog-detail-scrim" aria-label="关闭作品详情" onClick={closeDetail} />
                <CatalogRail
                  detail={detail}
                  controlEnabled={canPlay}
                  queueEnabled={mediaQueueAvailable && canQueue}
                  onPlay={playCatalogChild}
                  onEnqueue={enqueueCatalogChild}
                  onConfirm={candidateId => void reviewCandidate("confirm", candidateId)}
                  onReject={candidateId => void reviewCandidate("reject", candidateId)}
                  onUnconfirm={() => void unconfirmCurrent()}
                  onSearchBangumi={searchBangumi}
                  onRebind={hit => void rebindCurrent(hit)}
                  onClose={closeDetail}
                  busy={catalogBusy}
                />
              </div>,
              overlayHost
            ) : null}
            <UnmatchedLine count={wall.cards.filter(card => card.status === "unmatched").length} onShowFiles={() => selectMode("files")} />
            {wall.hasMore && wall.nextCursor ? (
              <Button variant="outline" size="sm" className="mt-3" onClick={() => activeLibraryId && loadWall(activeLibraryId, wall.nextCursor ?? undefined, catalogQuery.trim() || undefined)}>载入更多</Button>
            ) : null}
          </>
        ) : (
          <EmptyPosterGrid label="正在读取标题库…" busy />
        )
      ) : null}

      {mode === "files" || !usesLibraries ? (
        <>
          {view && !searching ? (
            <nav aria-label="目录路径" className="mt-4 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              {/* 库路由的面包屑第一格就是库根，再顶一个同名按钮会重复；旧路由只给文件夹名，才需要这个根。 */}
              {!usesLibraries && currentSourceName ? (
                <button type="button" aria-current={view.currentPath === "/" ? "page" : undefined} className="hover:text-foreground" onClick={() => openPath("/")}>
                  {currentSourceName}
                </button>
              ) : null}
              {view.crumbs.map((crumb, index) => (
                <span key={`${crumb.path}-${index}`} className="flex items-center gap-1">
                  <span aria-hidden="true">/</span>
                  <button type="button" aria-current={view.currentPath === crumb.path ? "page" : undefined} className="hover:text-foreground" onClick={() => openPath(crumb.path)}>
                    {crumb.name}
                  </button>
                </span>
              ))}
            </nav>
          ) : null}

          {view?.posterUrl ? <MediaFolderBanner imageUrl={view.posterUrl} title={view.crumbs[view.crumbs.length - 1]?.name ?? currentSourceName ?? view.currentPath} /> : null}

          {view?.cards.length ? (
            <MediaCardGrid
              cards={visibleCards(view.cards, showAllFiles)}
              controlEnabled={canPlay}
              queueEnabled={mediaQueueAvailable && canQueue}
              onOpen={card => void playCard(card)}
              onPlay={card => void playCard(card)}
              onEnqueue={card => void enqueueCard(card)}
            />
          ) : view ? (
            // 有页面才是"空目录"；一次都没载出来（换库失败/没配好）留给错误行说，别谎报目录为空。
            <EmptyPosterGrid label={searching ? "没有匹配的媒体" : "这里还没有内容"} />
          ) : null}

          {view && hiddenCardCount(view.cards) > 0 ? (
            <p className="catalog-unmatched">
              已隐藏 <b>{hiddenCardCount(view.cards)}</b> 个非视频文件（.nfo / 图片 / 字幕一类）
              <Button size="sm" variant="ghost" onClick={() => setShowAllFiles(show => !show)}>{showAllFiles ? "隐藏它们" : "显示全部"}</Button>
            </p>
          ) : null}

          {view?.hasMore && view.nextCursor ? (
            <Button variant="outline" size="sm" className="mt-3" onClick={() => { if (searching) { void runSearch(query, view.nextCursor ?? undefined) } else { void openPath(view.currentPath, view.nextCursor ?? undefined) } }}>
              载入更多
            </Button>
          ) : null}
        </>
      ) : null}

      {message && !unhealthyLibrary ? (
        <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
          <span role="status">{message}</span>
          {view || wall || activeLibraryId || activeRoot ? <Button size="sm" variant="ghost" onClick={retry}>重试</Button> : null}
        </div>
      ) : null}
    </div>
  )
}

async function persistTheme(theme: ThemePreference, windowMaterial: WindowMaterial, setTheme: (theme: ThemePreference) => void) {
  const current = await getDesktopSettings()
  await updateDesktopSettings({
    backendOrigin: current.backendOrigin,
    nickname: current.nickname,
    theme,
    windowMaterial,
    playerPreferences: current.playerPreferences,
    allowRemoteHttp: current.allowRemoteHttp,
  })
  setTheme(theme)
}

async function persistWindowMaterial(windowMaterial: WindowMaterial, setWindowMaterial: (material: WindowMaterial) => void) {
  const nextMaterial = windowMaterial === "auto" ? "none" : "auto"
  const current = await getDesktopSettings()
  await updateDesktopSettings({
    backendOrigin: current.backendOrigin,
    nickname: current.nickname,
    theme: current.theme,
    windowMaterial: nextMaterial,
    playerPreferences: current.playerPreferences,
    allowRemoteHttp: current.allowRemoteHttp,
  })
  setWindowMaterial(nextMaterial)
}

function TerminalOverlay({ state, onLeave }: { state: DesktopUiState; onLeave: () => void }) {
  // M2.5：错误码只进日志，界面上说人话（标题给结论、正文给原因与下一步）。
  const code = state.error?.code
  useEffect(() => { if (code) console.error("[desktop-session]", code) }, [code])
  return <section className="fixed inset-0 z-50 grid place-items-center bg-black/86 px-6" aria-live="assertive"><div className="terminal-overlay-card w-full max-w-lg border border-border p-7"><h1 className="text-2xl font-semibold">{state.connection === "expired" ? "桌面会话已过期" : "桌面会话不可用"}</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">{state.error?.message ?? "请返回网页房间重新生成一次性交接码。"}</p><Button className="mt-6" onClick={onLeave}>重新加入</Button></div></section>
}
