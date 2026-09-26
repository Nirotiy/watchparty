import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import { Dropdown, Option } from "@fluentui/react-components"
import {
  ArrowExitRegular, ArrowShuffleRegular, ArrowStepOverRegular, ChatMultipleRegular, ClosedCaptionRegular, DeleteRegular,
  DismissRegular, HeartFilled, HeartRegular, LibraryRegular, MoreHorizontalRegular,
  MusicNote2Regular, NextRegular, PauseRegular, PeopleRegular, PlayRegular, PreviousRegular, ReorderRegular,
  AddRegular, AddSquareMultipleRegular, ArrowExportRegular, ChevronDownRegular, ChevronUpRegular, HistoryRegular, SearchRegular, SendRegular, SelectAllOnRegular,
  Speaker1Regular, Speaker2Regular, SpeakerMuteRegular, SubtractCircleRegular,
  TextBulletListAddRegular, TextBulletListLtrRegular,
} from "@fluentui/react-icons"
import type { DomainEvent, MediaItem, SharedCommandKind, SharedRoomState } from "../../shared/domain"
import { sharedPositionMs, clockTrusted } from "../../shared/shared-room-state"
import { MusicPartyControlError, MusicPartyPlaylistError } from "../../shared/musicparty-adapter"
import { invoke } from "../../shared/desktop-runtime"
import type { MusicPartyAdapter, MusicSearchResult, PlaylistScope, PlaylistSummary, PlaylistTrack } from "../../shared/musicparty-adapter"
import type { MusicAlbum, MusicMetadata, PlaybackHistoryItem } from "../../shared/musicparty-contract"
import type { MusicPartyConnection } from "../../shared/musicparty-connection"
import type { RoomIdentity } from "../../shared/lobby-contract"
import { pairByTime, parseYrc } from "../../shared/yrc"
import { linkleIdentity, linkleMemberOf, migrateLocalSettings, type LinkleMemberIdentity } from "../../shared/local-schema"
import type { MusicPartyAccount } from "../../shared/musicparty-adapter"
import type { LyricDetail } from "../../shared/musicparty-adapter"
import { KawarpBackground } from "./kawarp-background"
import { accentVars, type AccentVars } from "./cover-palette"

type RoomPanel = "listen" | "queue" | "search" | "playlists" | "chat"
/** A fill unit: one word (or the whole line when only line-level timing exists). */
type LyricUnit = { text: string; startMs: number; endMs: number }
type LyricLine = { atMs: number; endMs: number; text: string; trans: string; units: LyricUnit[] }
type LyricState = { status: "none" | "loading" | "ready" | "error"; lines: LyricLine[] }
/** Line highlight leads the fill start so the scale/blur transition lands on time. */
const LYRIC_LEAD_MS = 100
const LINE_TAIL_MS = 3000

function formatTime(ms: number): string {
  const whole = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`
}

const CONNECTION_LABEL: Record<string, string> = {
  idle: "未连接", connecting: "正在连接", ready: "已连接", reconnecting: "正在重新连接", expired: "会话已过期", failed: "连接失败",
}

/** Local-only view state: the shell remembers the last mode and shows the hint once. */
function stored(key: string): string | null {
  try { return window.localStorage.getItem(key) } catch { return null }
}
function store(key: string, value: string) {
  try { window.localStorage.setItem(key, value) } catch { /* private mode / disabled storage */ }
}

/**
 * 服务端既有的「喜欢」系统歌单 key（handoff §15.1：桌面与网页共用一个喜欢集合）。
 * 它只用来**找到那一行**并给它换文案；能不能显示移除键由能力位 `features.likedSongsEdit` 决定
 * （handoff §16：`likePlaylist`=服务端会不会替你写那一行，`likedSongsEdit`=那一行你能不能自己删）。
 */
const LIKED_SONGS_SYSTEM_KEY = "liked-songs"

/** 房间音量的出厂默认（用户 2026-09-25：默认 30%）。 */
const DEFAULT_VOLUME = 30
/** 本机音量记忆：音量属于本机属性（每台机器输出设备不同），所以只记在本机、不进服务端。
    没有记忆就落到出厂默认 30%。 */
function storedVolume(key: string): number | null {
  const raw = stored(key)
  const value = raw == null ? NaN : Number(raw)
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
}

/**
 * One lyric model for both granularities: the word track wins when the server has
 * one, otherwise the plain track is parsed into whole-line units, so the renderer
 * keeps a single path (spec §3: 同一套 DOM，只换填充单元的粒度).
 * Line windows fall back to the next line's start, then to a fixed tail.
 */
function buildLyrics(detail: LyricDetail): LyricState {
  const word = parseYrc(detail.wordLyric)
  const source = word.length ? word : parseYrc(detail.lyric)
  if (!source.length) return { status: "none", lines: [] }
  const translated = parseYrc(detail.translatedLyric)
  const paired = pairByTime(source, translated.length ? translated : parseYrc(detail.wordTranslatedLyric))
  const lines = source.map((line, index) => {
    const windowEnd = line.end > line.start ? line.end : source[index + 1]?.start ?? line.start + LINE_TAIL_MS
    const units = line.segments
      .filter(segment => segment.text.length > 0)
      .map(segment => ({ text: segment.text, startMs: segment.start, endMs: Math.max(segment.end, segment.start) }))
    return {
      atMs: line.start,
      endMs: windowEnd,
      text: line.text,
      trans: paired[index] ?? "",
      units: units.length ? units : [{ text: line.text, startMs: line.start, endMs: windowEnd }],
    }
  })
  return { status: "ready", lines }
}

/** Index of the line the reader is on, with the highlight leading the fill. */
function lyricIndexAt(lines: LyricLine[], atMs: number): number {
  let index = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].atMs <= atMs) index = i
    else break
  }
  return index
}

/** Fill ratio for one unit; zero-duration units (punctuation) pop in on arrival. */
function unitProgress(unit: LyricUnit, atMs: number): number {
  if (unit.endMs <= unit.startMs) return atMs >= unit.startMs ? 1 : 0
  return Math.min(1, Math.max(0, (atMs - unit.startMs) / (unit.endMs - unit.startMs)))
}

function prefersReducedMotion(): boolean {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches } catch { return false }
}

/** Providers without artist metadata arrive as an empty string, not as undefined. */
function artistOf(item: MediaItem | null): string {
  return item?.artist?.trim() ? item.artist : "未知艺术家"
}

/** The shell swaps the `dark` class on <html>; palette derivation follows it. */
function documentTheme(): "dark" | "light" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light"
}

/**
 * Linkle one-screen room workspace: listen view + floating player bar + 沉浸收听.
 * Shared commands ride the adapter's requestId channel (single in flight, 2000ms
 * timeout → unknown → throttled resync); local-only affordances (view mode, volume,
 * sleep timer, lyrics translation/size) never send commands. Copy stays plain:
 * protocol terms live in the adapter, not in the interface.
 */
export function LinkleRoom({ room, connection, subscribeRoom, onLeave }: {
  room: RoomIdentity
  connection: MusicPartyConnection
  subscribeRoom: (listener: (event: DomainEvent) => void) => () => void
  onLeave: () => void
}) {
  const sharedRef = useRef<SharedRoomState | null>(null)
  const [, tick] = useState(0)
  const [queue, setQueue] = useState<MediaItem[]>([])
  const [members, setMembers] = useState<Array<{ id: string; name: string; online: boolean }>>([])
  const [roomHistory, setRoomHistory] = useState<RoomHistoryEntry[]>(() => readRoomHistory(room.roomId))
  // 本机身份：启动时指定的本地 ID 优先（用户 2026-09-25 计划中的「开机指定 ID」），
  // 没指定就回落服务端账号。成员区据此标「我」，消息据此右对齐。见 linkleIdentity()。
  const [localMember] = useState<LinkleMemberIdentity | null>(() => {
    try { return linkleMemberOf(migrateLocalSettings(JSON.parse(localStorage.getItem("watchparty.local-settings") ?? "null"))) } catch { return null }
  })
  const [account, setAccount] = useState<MusicPartyAccount | null>(null)
  const [chatUnread, setChatUnread] = useState(0)
  const [connLabel, setConnLabel] = useState("连接中")
  const [pendingKind, setPendingKind] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [panel, setPanel] = useState<RoomPanel>("listen")
  const panelRef = useRef<RoomPanel>("listen")
  panelRef.current = panel
  const [lyrics, setLyrics] = useState<LyricState>({ status: "none", lines: [] })
  const [timerOn, setTimerOn] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [menuOpen, setMenuOpen] = useState<"room" | "bar" | null>(null)
  // 音量记忆的键先按服务器，账号一到就升级成「服务器 + 账号」（用户 2026-09-25）。
  const volumeMemory = useRef<{ key: string; value: number }>({ key: `linkle.volume.${room.origin}`, value: storedVolume(`linkle.volume.${room.origin}`) ?? DEFAULT_VOLUME })
  const volumeSeeded = useRef(false)
  const accountAdopted = useRef(false)
  const [seekOverride, setSeekOverride] = useState<number | null>(null)
  const seekOverrideRef = useRef<number | null>(null)
  seekOverrideRef.current = seekOverride
  const [volume, setVolumeState] = useState(volumeMemory.current.value)
  const lastVolume = useRef(volumeMemory.current.value > 0 ? volumeMemory.current.value : DEFAULT_VOLUME)
  const fadeRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [showTranslation, setShowTranslation] = useState(() => stored("linkle.translation") !== "off")
  const [lyricScale, setLyricScale] = useState(1)
  const [coverColorsEnabled, setCoverColorsEnabled] = useState(() => stored("linkle.cover-colors") !== "off")
  const [accent, setAccent] = useState<AccentVars | null>(null)
  const [cover, setCover] = useState<string | null>(null)
  const [dynamicBackground, setDynamicBackground] = useState<"system" | "on" | "off">(() => {
    const value = stored("linkle.dynamic-bg")
    return value === "on" || value === "off" ? value : "system"
  })
  // The word sweep is informational (karaoke timing), so it defaults on; the switch
  // still allows "跟随系统" for anyone who wants reduced-motion to freeze it.
  const [lyricMotion, setLyricMotion] = useState<"system" | "on" | "off">(() => {
    const value = stored("linkle.lyric-motion")
    return value === "system" || value === "off" ? value : "on"
  })
  const [themeMode, setThemeMode] = useState<"dark" | "light">(documentTheme)
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion)
  const lyricMotionOn = lyricMotion === "on" || (lyricMotion === "system" && !reducedMotion)
  const [activeLyric, setActiveLyric] = useState(-1)
  const lyricsRef = useRef<LyricState>({ status: "none", lines: [] })
  lyricsRef.current = lyrics
  const paintedIndex = useRef(-1)
  const paintedUnits = useRef<HTMLElement[]>([])
  const trackStartedAt = useRef(Date.now())
  const lyricScrollRef = useRef<HTMLDivElement>(null)
  const followedLine = useRef(-1)

  // The shell owns the theme class; palette derivation and the background tint follow it.
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeMode(documentTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => setReducedMotion(query.matches)
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])

  useEffect(() => { store("linkle.dynamic-bg", dynamicBackground) }, [dynamicBackground])

  useEffect(() => { store("linkle.lyric-motion", lyricMotion) }, [lyricMotion])

  // Esc unwinds the floating panel; the immersive page is the only playback surface.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return
      if (menuOpen) setMenuOpen(null)
      else if (panel !== "listen") setPanel("listen")
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [menuOpen, panel])

  useEffect(() => subscribeRoom(event => {
    if (event.type === "shared-room-state") sharedRef.current = event.state
    else if (event.type === "command-pending") setPendingKind(event.pending ? event.kind : null)
    else if (event.type === "denied") setNote(denyMessage(event.code))
    else if (event.type === "queue-state") setQueue(event.items)
    else if (event.type === "members") setMembers(event.members)
    else if (event.type === "chat") { if (panelRef.current !== "chat") setChatUnread(value => value + 1) }
    else if (event.type === "connection") setConnLabel(CONNECTION_LABEL[event.status] ?? event.status)
  }), [subscribeRoom])

  useEffect(() => { if (panel === "chat") setChatUnread(0) }, [panel])


  // D4/D5 interpolation clock: the shared projection advances between frames.
  useEffect(() => {
    const timer = setInterval(() => tick(value => value + 1), 250)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); if (fadeRef.current) clearInterval(fadeRef.current) }, [])

  const shared = sharedRef.current

  // 记一条播放历史：同一首不重复记录，重复出现的旧条目提到最前（重播也算"找得到"）。
  useEffect(() => {
    const current = sharedRef.current?.item
    if (!current?.id) return
    setRoomHistory(history => {
      if (history[0]?.musicId === current.id) return history
      const by = sharedRef.current?.enqueuedByName ?? null
      const entry: RoomHistoryEntry = { key: current.id, musicId: current.id, name: current.title, artist: current.artist ?? "", platform: current.source, duration: current.durationSeconds ?? 0, coverUrl: current.artworkUrl ?? "", at: Date.now(), by }
      const next = [entry, ...history.filter(row => row.musicId !== current.id)].slice(0, 200)
      storeRoomHistory(room.roomId, next)
      return next
    })
  }, [shared?.item?.id, room.roomId])
  // 拿本机账号：房间用的适配器常常没探过（大厅列表那次是另一个实例），补一次只读探测。
  // 只在进房与首个共享状态到达时各试一次，避免 shared 每次更新都打一次探测。
  const accountTries = useRef(0)
  useEffect(() => {
    const adapter = adapterOf(connection)
    if (!adapter) return
    const known = adapter.desktopProbe?.account ?? null
    if (known) { setAccount(known); return }
    if (accountTries.current >= 2) return
    accountTries.current += 1
    let active = true
    void adapter.ensureProbe(true).then(() => { if (active) setAccount(adapterOf(connection)?.desktopProbe?.account ?? null) }).catch(() => undefined)
    return () => { active = false }
  }, [connection, shared !== null])
  const item = shared?.item ?? null
  const positionMs = shared ? sharedPositionMs(shared, Date.now()) : 0
  const durationMs = shared?.durationMs ?? 0
  const paused = shared?.paused ?? true
  const hasTrack = Boolean(item)
  const locked = Boolean(shared && (shared.pauseLocked || shared.skipLocked || shared.shuffleLocked))

  // Album art: the main process proxies the platform URL into a data URL (CSP
  // forbids remote images, and a cross-origin image would taint the palette canvas).
  const artworkUrl = item?.artworkUrl ?? ""
  useEffect(() => {
    if (!artworkUrl) { setCover(null); return }
    let active = true
    void Promise.resolve(adapterOf(connection)?.artwork(artworkUrl)).then(data => { if (active) setCover(data ?? null) }).catch(() => { if (active) setCover(null) })
    return () => { active = false }
  }, [artworkUrl, connection])

  useEffect(() => {
    store("linkle.cover-colors", coverColorsEnabled ? "on" : "off")
    if (!coverColorsEnabled || !cover) { setAccent(null); return }
    let active = true
    void accentVars(cover, themeMode === "dark").then(vars => { if (active) setAccent(vars) })
    return () => { active = false }
  }, [coverColorsEnabled, cover, themeMode])

  // Lyrics follow the current track; the detail route also carries word timing.
  const lyricKey = item ? `${item.source}:${item.id}` : ""
  useEffect(() => {
    for (const unit of paintedUnits.current) unit.style.removeProperty("--p")
    paintedUnits.current = []
    paintedIndex.current = -1
    trackStartedAt.current = Date.now()
    setActiveLyric(-1)
    if (!lyricKey) { setLyrics({ status: "none", lines: [] }); return }
    const [platform, songId] = lyricKey.split(":")
    let token = true
    setLyrics({ status: "loading", lines: [] })
    void adapterOf(connection)?.lyrics(platform, songId).then(detail => {
      if (!token) return
      setLyrics(buildLyrics(detail))
    }).catch(() => { if (token) setLyrics({ status: "error", lines: [] }) })
    return () => { token = false }
  }, [lyricKey, connection])

  const currentLyric = activeLyric

  /**
   * The sweep is written straight to the DOM: one custom property per fill unit,
   * no state updates per frame (spec §4 forbids per-frame text/filter writes).
   * Paused, the same function runs once per position change so seeks land exactly.
   */
  const paintLyrics = useCallback((atMs: number) => {
    const lines = lyricsRef.current.lines
    if (!lines.length) return
    const index = lyricIndexAt(lines, atMs + LYRIC_LEAD_MS)
    if (index !== paintedIndex.current) {
      for (const unit of paintedUnits.current) unit.style.removeProperty("--p")
      const host = lyricScrollRef.current
      paintedUnits.current = index >= 0 && host ? Array.from(host.querySelectorAll<HTMLElement>(`[data-line="${index}"] .u`)) : []
      paintedIndex.current = index
      setActiveLyric(index)
    }
    const line = index >= 0 ? lines[index] : null
    if (!line) return
    const fill = lyricMotionOn ? (unit: LyricUnit) => unitProgress(unit, atMs) : () => 1
    for (let i = 0; i < paintedUnits.current.length; i += 1) {
      const unit = line.units[i]
      const element = paintedUnits.current[i]
      if (!unit || !element) continue
      element.style.setProperty("--p", `${(fill(unit) * 100).toFixed(1)}%`)
    }
  }, [lyricMotionOn])

  // While playing, the fill advances on the frame clock; the shared projection
  // stays the only time base (no local audio clock, spec §5).
  useEffect(() => {
    if (lyrics.status !== "ready" || paused || !hasTrack) return
    let frame = 0
    const step = () => {
      const state = sharedRef.current
      const override = seekOverrideRef.current
      if (state) paintLyrics(override != null ? override * 1000 : sharedPositionMs(state, Date.now()))
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [lyrics, paused, hasTrack, paintLyrics])

  useEffect(() => {
    paintLyrics(seekOverride != null ? seekOverride * 1000 : positionMs)
  }, [paintLyrics, positionMs, seekOverride, lyrics, showTranslation, lyricScale])

  /** Anchor the current line at 42% of the immersive column (spec §11). */
  function locateLine() {
    const panel = lyricScrollRef.current
    const line = panel?.querySelector<HTMLElement>(".lyrictext .current")
    if (!panel || !line) return
    const offset = panel.scrollTop + (line.getBoundingClientRect().top - panel.getBoundingClientRect().top) - panel.clientHeight * 0.42 + line.offsetHeight / 2
    panel.scrollTo({ top: Math.max(0, offset), behavior: "smooth" })
    followedLine.current = currentLyric
  }

  // Only follow when the line number actually changes, so manual scrolling wins.
  useEffect(() => {
    if (currentLyric < 0 || currentLyric === followedLine.current) return
    locateLine()
  }, [currentLyric])

  function jumpToLine(atMs: number) {
    if (!item) return
    if (disconnected) { setNote("连接已断开，暂时无法跳转"); return }
    void send("seek", { positionMs: atMs })
  }

  const send = useCallback(async (kind: SharedCommandKind, payload: { positionMs?: number } = {}) => {
    const adapter = adapterOf(connection)
    if (!adapter) { setNote("还没有连接到 Linkle 服务"); return }
    try {
      const outcome = await adapter.sendControl(kind, payload)
      if (outcome === "applied") setNote("")
      else if (outcome === "noop") setNote("")
      else if (outcome === "rejected") setNote("房间没有接受这个操作")
      else setNote("操作超时，已重新对齐房间进度")
    } catch (error) {
      // in-progress = 上一条命令还在飞（适配器一次只许一条），这是"手快"不是"连接坏了"。
      const code = error instanceof MusicPartyControlError ? error.code : null
      setNote(code === "in-progress" ? "上一个操作还没完成，请稍后再试" : "操作没有发出去，请检查连接")
    }
  }, [connection])

  function applyVolume(value: number, remember = true) {
    setVolumeState(value)
    if (value > 0 && remember) lastVolume.current = value
    // 只记非零值：静音（0）和睡眠定时的渐弱都不该覆盖"用户想要的音量"。
    if (remember) {
      if (value > 0) volumeMemory.current.value = value
      store(volumeMemory.current.key, String(volumeMemory.current.value))
    }
    const player = connection.audioPlayer
    if (player) void player.setVolume(value).catch(() => setNote("本机音量没有生效（播放器未就绪）"))
  }

  // 侧车是音量的执行者，但"用户想要多少"记在本机：第一次连上播放器时把记忆（或默认 30%）
  // 推过去，之后只把侧车的有效值读回来（睡眠渐弱、设备侧变化都不会被打回）。
  const playEpoch = shared?.playEpoch ?? 0
  const volumeSyncKey = `${connLabel}:${playEpoch}`
  useEffect(() => {
    let token = true
    const player = connection.audioPlayer
    if (!player) return
    const seed = !volumeSeeded.current
    if (seed) volumeSeeded.current = true
    const read = seed
      ? player.setVolume(volumeMemory.current.value).catch(() => undefined).then(() => player.getVolume())
      : player.getVolume()
    void read.then(value => {
      if (token && Number.isFinite(value)) { setVolumeState(value); if (value > 0) lastVolume.current = value }
    }).catch(() => undefined)
    return () => { token = false }
  }, [connection, volumeSyncKey])

  // 账号一到就把记忆键升级成「服务器 + 账号」：该账号在本机有记忆就用它，没有就把当前值登记为他/她的起点。
  useEffect(() => {
    if (!account || accountAdopted.current) return
    accountAdopted.current = true
    const key = `${volumeMemory.current.key}:${account.publicId}`
    const saved = storedVolume(key)
    if (saved != null) {
      volumeMemory.current = { key, value: saved }
      applyVolume(saved)
    } else {
      volumeMemory.current = { key, value: volumeMemory.current.value }
      store(key, String(volumeMemory.current.value))
    }
  }, [account])

  function toggleTimer() {
    if (timerRef.current || fadeRef.current) {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
      if (fadeRef.current) { clearInterval(fadeRef.current); fadeRef.current = null; applyVolume(lastVolume.current) }
      setTimerOn(false); setNote("睡眠定时已关闭 · 本机恢复跟随房间"); return
    }
    setTimerOn(true)
    setNote("睡眠定时已启动（30 分钟，仅本机）")
    const from = volume
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setTimerOn(false)
      // 渐弱按交接规格由前端分步发 Volume 递减实现。
      let current = from
      fadeRef.current = setInterval(() => {
        current = Math.max(0, current - 10)
        applyVolume(current, false)
        if (current <= 0) {
          clearInterval(fadeRef.current ?? undefined)
          fadeRef.current = null
          void connection.audioPlayer?.pause().catch(() => undefined)
          setNote("睡眠定时到点 · 已渐弱并暂停本机输出，房间不受影响")
        }
      }, 150)
    }, 30 * 60 * 1000)
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen().catch(() => setNote("全屏请求被拒绝"))
  }

  /**
   * Tabs are toggle-off: the mockup has no 收听 key in the head, so clicking the
   * active entry again is the way back to the listen view (and closes the panel).
   */
  function openPanel(next: RoomPanel) {
    setPanel(current => current === next && next !== "listen" ? "listen" : next)
    setMenuOpen(null)
  }

  function stepLyricScale(delta: number) {
    const next = Math.round(Math.min(1.6, Math.max(0.8, lyricScale + delta)) * 10) / 10
    if (next === lyricScale) return
    setLyricScale(next)
    requestAnimationFrame(locateLine)
  }

  function leave() {
    if (!window.confirm("退出当前活动会话？")) return
    if (timerRef.current) clearTimeout(timerRef.current)
    void adapterOf(connection)?.disconnect()
    onLeave()
  }

  function toggleTranslation() {
    setShowTranslation(value => {
      store("linkle.translation", value ? "off" : "on")
      return !value
    })
  }

  // 播放条那一排只该被"播放类"命令挡住。like/unlike 是封面上的动作：虽然同样受适配器
  // "一次只允许一条命令在飞"的约束（sendControl 的 in-progress 锁），但让它在飞行期间把整排
  // 按钮压成禁用态（.i32:disabled → opacity:.36），看起来就是"点一下红心、底下闪一下"
  // （用户 2026-09-25 报的）。顺带一提 seek 滑杆本来就没看 pendingKind，这里让播放键跟它一致。
  const transportPending = Boolean(pendingKind) && pendingKind !== "like" && pendingKind !== "unlike"
  const seekDisabled = !hasTrack
  const historyCursor = shared?.historyCursor ?? null
  // 「已知禁用不发送」：游标为 0（或服务端未上报）时上一首置灰且点击不发命令。
  const prevDisabled = !hasTrack || historyCursor === null || historyCursor <= 0
  const reconnecting = connLabel === "正在重新连接"
  const disconnected = connLabel === "连接失败" || connLabel === "会话已过期"
  // Connection state is a dot + people glyph + count; words stay in aria-label/title.
  const connTone = disconnected ? " lost" : reconnecting ? " recon" : ""
  const connText = `${connLabel} · 房间 ${members.length || "…"} 人`
  const flags: Array<{ text: string; local?: boolean }> = []
  if (locked) flags.push({ text: `房间锁：${[shared?.pauseLocked && "暂停", shared?.skipLocked && "切歌", shared?.shuffleLocked && "随机"].filter(Boolean).join("/")}` })
  if (reconnecting) flags.push({ text: "重连中" })
  if (disconnected) flags.push({ text: "连接已断开 · 操作暂不可用" })
  if (timerOn) flags.push({ text: "睡眠定时 · 仅本机", local: true })
  if (volume <= 0) flags.push({ text: "本机静音", local: true })
  // The right-hand views open as a floating panel over the same host.
  const showPanel = panel !== "listen"
  const panelTitle = ({ search: "点歌", queue: "播放队列", playlists: "歌单", chat: "聊天与成员" } as Partial<Record<RoomPanel, string>>)[panel] ?? "房间面板"
  const memberIdentity = linkleIdentity(localMember, account ? { publicId: account.publicId, displayName: account.displayName } : null)
  // 喜欢的心跳（handoff §15.1 冻结）：likedUserIds 现在**按当前曲目**作用域，且 /api/account/me
  // 给出本机 publicId，所以「是我点的」可以直接推导，不需要新契约字段：
  //   likedByMe = likedUserIds.includes(account.publicId)
  // 按下态跟 likedByMe（不是「有人点过」）；别人点过但本机没点，用文案说，不用改按下态。
  const likedByMe = Boolean(account && shared?.likedUserIds.includes(account.publicId))
  const likedByOthers = Boolean(shared?.likedUserIds.some(id => id !== account?.publicId))
  const canUnlike = adapterOf(connection)?.desktopProbe?.features?.unlike === true
  // 能取消就点第二次＝取消（服务端 unlike 会同时撤掉「喜欢的歌曲」里那一条，包括网页端加的）；
  // 老服务端没有 unlike 位时退回幂等加 + 直说"不支持取消"，别靠试错判断版本。
  async function likeTrack() {
    if (!hasTrack) { setNote("当前没有正在播放的曲目"); return }
    const adapter = adapterOf(connection)
    if (!adapter) { setNote("还没有连接到 Linkle 服务"); return }
    if (!canUnlike) {
      const hadLike = likedByMe || likedByOthers
      await send("like")
      if (hadLike) setNote("这首已经有人喜欢过 · 当前服务端不支持取消")
      return
    }
    try {
      // 成功/幂等一律不写提示行（用户 2026-09-25：有按下态就够）；失败与限制仍要说，别让失败变得静默。
      const outcome = await adapter.sendControl(likedByMe ? "unlike" : "like")
      if (outcome !== "applied" && outcome !== "noop") setNote(outcome === "rejected" ? "房间没有接受这个操作" : "操作超时，已重新对齐房间进度")
    } catch (error) {
      // 连点红心会撞上适配器的 in-progress 锁，别把它报成连接问题。
      if (error instanceof MusicPartyControlError && error.code === "in-progress") setNote("上一个操作还没完成，请稍后再试")
      else setNote("操作没有发出去，请检查连接")
    }
  }
  /** 歌单里删掉一首「喜欢」后，如果那首正是当前曲目且本机点过，就把房间那一份也撤掉。
      服务端不会替你同步这两份真相（handoff §16），所以由客户端在这里收口。 */
  function clearLikeIfCurrent(musicId: string, platform: string) {
    if (!likedByMe || !item) return
    if (musicId !== item.id || platform !== item.source) return
    void send("unlike")
  }

  // Without a trusted clock the fill cannot advance smoothly, so the panel says so
  // instead of showing a stuttering sweep (spec §5). The grace period keeps the
  // chip from flashing while the first clock samples are still in flight.
  const syncUnavailable = lyrics.status === "ready" && hasTrack && Boolean(shared) && !clockTrusted(shared as SharedRoomState, Date.now()) && Date.now() - trackStartedAt.current > 8000

  return (
    <div
      className="linkle-room immersive"
      data-panel={panel}
      ref={rootRef}
      style={accent ? accent as React.CSSProperties : undefined}
      onPointerOver={event => placeTooltip(event.target)}
      onFocus={event => placeTooltip(event.target)}
    >
      <header className="roomhead">
        <div className="identity">
          <h2>{room.roomId}</h2>
          <p className={`connection${connTone}`} aria-label={connText} title={connText}>
            <span className="conn-dot" aria-hidden="true" />
            <PeopleRegular className="conn-users" aria-hidden="true" />
            <span className="conn-count">{members.length || "…"}</span>
          </p>
        </div>
        {/* 状态标（房间锁/重连/断开/睡眠定时/本机静音）常驻房头：分栏播放条撤掉后，
            它们不能再只挂在被隐藏的那一块里（用户 2026-09-25 裁决）。 */}
        {flags.map(flag => <span key={flag.text} className={flag.local ? "flag local" : "flag"}>{flag.text}</span>)}
        <nav className="room-actions" aria-label="房间功能">
          <RoomTab icon={<SearchRegular />} label="点歌" active={panel === "search"} onClick={() => openPanel("search")} />
          <RoomTab icon={<TextBulletListLtrRegular />} label="播放队列" active={panel === "queue"} onClick={() => openPanel("queue")} />
          <RoomTab icon={<LibraryRegular />} label="歌单" active={panel === "playlists"} onClick={() => openPanel("playlists")} />
          <RoomTab className="optional" icon={<ChatMultipleRegular />} label={`聊天与成员${chatUnread ? `，${chatUnread} 条未读` : ""}`} badge={panel === "chat" ? 0 : chatUnread} active={panel === "chat"} onClick={() => openPanel("chat")} />
          <span className="tip below end">
            <button type="button" className="i32" aria-label="更多房间功能" onClick={() => setMenuOpen(menuOpen === "room" ? null : "room")}><MoreHorizontalRegular /></button>
            <span className="tooltip" role="tooltip">更多房间功能</span>
          </span>
          <span className="tip below end">
            <button type="button" className="i32" aria-label="退出房间" onClick={leave}><ArrowExitRegular /></button>
            <span className="tooltip" role="tooltip">退出房间</span>
          </span>
        </nav>
        {menuOpen === "room" ? (
          <>
            <button type="button" className="menu-backdrop" aria-label="关闭菜单" onClick={() => setMenuOpen(null)} />
            <div className="menu topmenu" role="menu">
              <h3>房间功能</h3>
              {/* 未开放项不进菜单（用户 2026-09-25 裁决）：置灰条目看着像坏了。 */}
              <button type="button" role="menuitem" onClick={() => openPanel("chat")}>聊天与成员</button>
              <button type="button" role="menuitem" onClick={() => openPanel("playlists")}>歌单与导出</button>
            </div>
          </>
        ) : null}
      </header>

      <KawarpBackground
        cover={cover}
        active={dynamicBackground === "on" || (dynamicBackground === "system" && !reducedMotion)}
        dark={themeMode === "dark"}
        onDegrade={reason => console.warn(`linkle_background_css_fallback:${reason}`)}
      />
      <div className="content-area">
        <div className="bodygrid">
          {/* 沉浸页的两栏：左列封面+控制台，右列歌词；面板打开时整个列区被面板盖住。 */}
          <div className="imm-left">
            <figure className="imm-cover" aria-label="当前曲目封面">
              <div
                className="imm-art" role="button" tabIndex={0}
                aria-pressed={likedByMe}
                aria-label={hasTrack ? (likedByMe ? "已经点了喜欢 · 再点取消" : likedByOthers ? "别人喜欢过这首 · 点击也喜欢" : "点击封面喜欢这首") : "点击封面喜欢这首 · 当前无曲目"}
                onClick={likeTrack}
                onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.currentTarget.click() } }}
              >
                {cover ? <img src={cover} alt="" /> : <MusicNote2Regular />}
                {/* 悬浮层：灰遮罩 + 红心（空心/实心=是否已喜欢）。用主题 token 走深浅色，不用红色。
                    必须是 div —— 用 span 会被 `.imm-cover span{display:block;font-size/margin-top}` 那条 figcaption
                    规则命中（选择器带元素名、优先级更高），遮罩会被顶下去 6px 且失去网格居中。 */}
                <div className="imm-like" aria-hidden="true">
                  <div className="imm-like-ico">{likedByMe ? <HeartFilled /> : <HeartRegular />}</div>
                </div>
              </div>
              <figcaption>
                <strong>{item ? item.title : "暂无曲目"}</strong>
                <span>{item ? artistOf(item) : "等待点歌"}</span>
                <small>{room.roomId}{shared?.enqueuedByName ? ` · 点歌者 ${shared.enqueuedByName}` : ""}</small>
              </figcaption>
            </figure>
            <div className="bar-holder">
              <footer className="player" aria-label="唯一播放控制区">
                <p className="control-note" role="status" aria-live="polite">{note}</p>
                <div className="stack">
                  <div className="progress">
                    <span className="seek-end current">{formatTime(seekOverride != null ? seekOverride * 1000 : positionMs)}</span>
                    <input
                      className="seek" type="range" min={0} max={Math.max(1, Math.round(durationMs / 1000))}
                      value={seekOverride ?? Math.round(positionMs / 1000)} step={1}
                      style={{ "--fill": `${(() => { const total = Math.max(1, Math.round(durationMs / 1000)); return ((seekOverride ?? Math.round(positionMs / 1000)) / total) * 100 })()}%` } as React.CSSProperties}
                      aria-label={`房间播放进度${seekDisabled ? " · 当前无曲目" : ""}${disconnected ? " · 连接已断开" : ""}`}
                      aria-disabled={seekDisabled || disconnected}
                      onInput={event => setSeekOverride(Number(event.currentTarget.value))}
                      onBlur={() => setSeekOverride(null)}
                      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setSeekOverride(null) } }}
                      onChange={event => {
                        const seconds = Number(event.currentTarget.value)
                        setSeekOverride(null)
                        if (disconnected) { setNote("连接已断开，暂时无法跳转"); return }
                        if (!seekDisabled) void send("seek", { positionMs: seconds * 1000 })
                      }}
                    />
                    <span className="seek-end">{formatTime(durationMs)}</span>
                  </div>
                  <div className="controls">
                    <div className="grp">
                      <Key label="暂停 / 继续 · 整个房间同步" ariaLabel={paused ? "继续整个房间" : "暂停整个房间"} disabled={!hasTrack || transportPending || disconnected} onClick={() => void send(paused ? "play" : "pause")}>{paused ? <PlayRegular /> : <PauseRegular />}</Key>
                      <Key label="上一首 · 整个房间同步" ariaLabel="上一首（房间）" disabled={prevDisabled || transportPending || disconnected} onClick={() => void send("previous")}><PreviousRegular /></Key>
                      <Key label="下一首 · 整个房间同步" ariaLabel="房间下一首" disabled={!hasTrack || transportPending || disconnected} onClick={() => void send("next")}><NextRegular /></Key>
                    </div>
                    <div className="grp volume">
                      <Key label="静音 · 只影响本机" ariaLabel={volume <= 0 ? "恢复本机音量" : "本机静音"} pressed={volume <= 0} onClick={() => applyVolume(volume <= 0 ? (lastVolume.current || 65) : 0)}>{volume <= 0 ? <SpeakerMuteRegular /> : volume <= 50 ? <Speaker1Regular /> : <Speaker2Regular />}</Key>
                      <input className="slider" type="range" min={0} max={100} value={Math.round(volume)} step={1}
                        aria-label={`本机音量 ${Math.round(volume)}，只影响本机`}
                        style={{ "--fill": `${Math.round(volume)}%` } as React.CSSProperties}
                        onChange={event => applyVolume(Number(event.currentTarget.value))} />
                    </div>
                    <div className="grp extras">
                      {/* 喜欢键已按用户要求从播放条搬到封面悬浮层（2026-09-25）：这颗撤掉，省一行空间；
                          状态（按下态/实心）由 .imm-art 上的 aria-pressed 与悬浮层里的红心表达。 */}
                      <Key label="随机播放 · 整个房间同步" ariaLabel="房间随机" pressed={shared?.shuffle === true} disabled={transportPending || disconnected} onClick={() => void send("shuffle")}><ArrowShuffleRegular /></Key>
                      <span className="tip">
                        <button type="button" className="i32" aria-label="更多播放选项" onClick={() => setMenuOpen(menuOpen === "bar" ? null : "bar")}><MoreHorizontalRegular /></button>
                      </span>
                    </div>
                  </div>
                </div>
              </footer>
              {menuOpen === "bar" ? (
                <>
                  <button type="button" className="menu-backdrop" aria-label="关闭菜单" onClick={() => setMenuOpen(null)} />
                  <div className="menu barmenu" role="menu">
                    <h3>更多播放选项</h3>
                    <button type="button" role="menuitem" aria-pressed={timerOn} onClick={toggleTimer}>睡眠定时（30 分钟，只影响本机）</button>
                    <button type="button" role="menuitem" aria-pressed={coverColorsEnabled} onClick={() => setCoverColorsEnabled(value => !value)}>封面取色</button>
                    <h3>动效</h3>
                    {([[dynamicBackground, setDynamicBackground, "动态背景"], [lyricMotion, setLyricMotion, "歌词动效"]] as const).map(([value, setValue, label]) => (
                      <div key={label} role="group" aria-label={label}>
                        <p className="menu-group">{label}</p>
                        {([["system", "跟随系统"], ["on", "开启"], ["off", "关闭"]] as const).map(([option, optionLabel]) => (
                          <button key={option} type="button" role="menuitemradio" aria-checked={value === option} className={value === option ? "selected" : undefined} onClick={() => setValue(option)}>{optionLabel}</button>
                        ))}
                      </div>
                    ))}
                    <h3>房间与窗口</h3>
                    <button type="button" role="menuitem" onClick={() => openPanel("chat")}>聊天与成员</button>
                    <button type="button" role="menuitem" disabled={!hasTrack} onClick={() => openPanel("playlists")}>保存至歌单</button>
                    <button type="button" role="menuitem" onClick={() => openPanel("queue")}>打开播放队列</button>
                    <button type="button" role="menuitem" onClick={toggleFullscreen}>切换全屏</button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
          <section className={showPanel ? "task has-panel" : "task"} aria-label="当前任务">
            {showPanel ? (
              <header className="panel-head">
                <strong>{panelTitle}</strong>
                <span className="tip below end">
                  <button type="button" className="i32" aria-label="关闭面板" onClick={() => setPanel("listen")}><DismissRegular /></button>
                  <span className="tooltip" role="tooltip">关闭面板（也可按 <code>Esc</code>）</span>
                </span>
              </header>
            ) : null}
            <div className="panel-body">
          {panel === "listen" ? null : panel === "queue" ? (
            <QueuePanel queue={queue} connection={connection} />
          ) : panel === "search" ? (
            <SearchPanel connection={connection} roomId={room.roomId} />
          ) : panel === "playlists" ? (
            <PlaylistsPanel connection={connection} queue={queue} history={roomHistory} onLikesRowRemoved={clearLikeIfCurrent} />
          ) : (
            <ChatPanel connection={connection} subscribeRoom={subscribeRoom} members={members} enqueuerName={shared?.enqueuedByName ?? null} identity={memberIdentity} roomId={room.roomId} onOpenSearch={() => openPanel("search")} />
          )}
            </div>
          </section>
          <aside className="lyrics" aria-label="歌词" style={{ "--lyric-scale": String(lyricScale) } as React.CSSProperties}>
            <div className="lyrics-tools">
              {syncUnavailable ? <span className="sync-note" title="本机时钟还没有与房间对齐，歌词暂时只做静态高亮">歌词同步不可用</span> : null}
              <span className="tip">
                <button type="button" className="tbtn" aria-pressed={showTranslation} aria-label="歌词译文" onClick={toggleTranslation}><ClosedCaptionRegular /></button>
                <span className="tooltip" role="tooltip">歌词译文 · 显示或隐藏翻译行（本机视图开关，不发命令）</span>
              </span>
              <span className="tip">
                <button type="button" className="tbtn" aria-label="歌词字号减小" aria-disabled={lyricScale <= 0.8} onClick={() => stepLyricScale(-0.1)}>A-</button>
                <span className="tooltip" role="tooltip">歌词字号减小（本机视图，0.8～1.6）</span>
              </span>
              <span className="tip">
                <button type="button" className="tbtn" aria-label="歌词字号增大" aria-disabled={lyricScale >= 1.6} onClick={() => stepLyricScale(0.1)}>A+</button>
                <span className="tooltip" role="tooltip">歌词字号增大（本机视图，0.8～1.6）</span>
              </span>
            </div>
            <div className="lyric-scroll" ref={lyricScrollRef} title="点空白处定位到当前行" onClick={event => {
              if ((event.target as HTMLElement).closest(".seekable")) return
              locateLine()
            }}>
              {lyrics.status === "ready" ? (
                <div className={`lyrictext${seekDisabled || disconnected ? " noseek" : ""}`}>
                  {lyrics.lines.map((line, index) => (
                    <p
                      key={`${line.atMs}-${index}`}
                      className={`seekable${index === currentLyric ? " current" : ""}`}
                      data-line={index}
                      role={seekDisabled ? undefined : "button"} tabIndex={seekDisabled ? -1 : 0}
                      aria-label={seekDisabled ? line.text : `跳转到 ${formatTime(line.atMs)}`}
                      data-jump={formatTime(line.atMs)}
                      onClick={() => jumpToLine(line.atMs)}
                      onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); jumpToLine(line.atMs) } }}
                    >
                      {line.units.map((unit, unitIndex) => <span className="u" key={unitIndex}>{unit.text}</span>)}
                      {showTranslation && line.trans ? <small className="translation-line">{line.trans}</small> : null}
                    </p>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  <h3>{{ none: "暂无歌词", loading: "正在获取歌词", error: "歌词获取失败" }[lyrics.status]}</h3>
                  <p>{{ none: "继续收听，歌词可用时显示在这里。", loading: "此处保留空间，播放控件不移动。", error: "播放不受影响，可稍后重试。" }[lyrics.status]}</p>
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

function adapterOf(connection: MusicPartyConnection): MusicPartyAdapter | null {
  return connection.current
}

/** Row cover: the platform thumbnail, thumb-sized, resolved through the adapter cache. */
function RowCover({ connection, url }: { connection: MusicPartyConnection; url?: string }) {
  const [cover, setCover] = useState<string | null>(null)
  useEffect(() => {
    if (!url) { setCover(null); return }
    let active = true
    void Promise.resolve(adapterOf(connection)?.artwork(url, "thumb")).then(data => { if (active) setCover(data ?? null) }).catch(() => { if (active) setCover(null) })
    return () => { active = false }
  }, [url, connection])
  return <span className="rowcover" aria-hidden="true">{cover ? <img src={cover} alt="" /> : <MusicNote2Regular />}</span>
}

function errCode(error: unknown): string {
  if (error instanceof MusicPartyPlaylistError) return error.code
  return error instanceof Error ? error.message : "unknown"
}

/** Server rejection codes, phrased for the person who clicked. */
const DENY_MESSAGE: Record<string, string> = {
  PAUSE_LOCKED: "房主开启了暂停锁，暂停和继续暂时不可用",
  SKIP_LOCKED: "房主开启了切歌锁，切歌暂时不可用",
  SHUFFLE_LOCKED: "房主开启了随机锁，随机暂时不可用",
  SEEK_FORBIDDEN: "只有点歌者或房主可以拖动进度",
  NO_HISTORY: "已经是队列里的第一首了",
  NO_CURRENT_TRACK: "当前没有正在播放的曲目",
  PRECONDITION_FAILED: "房间状态刚刚变化，请再试一次",
}
function denyMessage(code: string): string {
  return DENY_MESSAGE[code] ?? "房间没有接受这个操作"
}

/**
 * Tooltips flip above/below their key and shift horizontally so they stay inside
 * the room and inside any scroll container they live in — the panel-head keys sit
 * at the very top of a scrolling column, where a fixed "above" tooltip is clipped.
 * CSS owns the look; only the two offsets are written here. Measurement is synchronous
 * (temporary display:block + visibility:hidden), so the shift is in place before the
 * tooltip's first paint — waiting for :hover to land made the shift miss that paint.
 */
function placeTooltip(target: EventTarget | null) {
  const element = target instanceof Element ? target : null
  const tip = element?.closest<HTMLElement>(".tip")
  const bubble = tip?.querySelector<HTMLElement>(".tooltip")
  const room = tip?.closest<HTMLElement>(".linkle-room")
  if (!tip || !bubble || !room) return
  positionTooltip(tip, bubble, room)
  // 再补一帧：字体/封面加载完可能让气泡尺寸变化，重算一次是幂等的。
  requestAnimationFrame(() => positionTooltip(tip, bubble, room))
}

function positionTooltip(tip: HTMLElement, bubble: HTMLElement, room: HTMLElement) {
  /** 定位改成「锚点几何 + 宽度上限」（用户 2026-09-25 定稿）：水平方向不再看气泡量出来的位置，
      只按锚点与可用盒子算；宽度先夹住，位置再夹住 —— 于是"偏移写晚一帧"不再造成越界。 */
  const pad = 8
  const roomBox = room.getBoundingClientRect()
  const bounds = { left: roomBox.left, top: roomBox.top, right: roomBox.right, bottom: roomBox.bottom }
  for (let node = tip.parentElement; node && node !== room; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (!/(auto|scroll|hidden|clip)/.test(`${style.overflow}${style.overflowX}${style.overflowY}`)) continue
    const rect = node.getBoundingClientRect()
    bounds.left = Math.max(bounds.left, rect.left)
    bounds.top = Math.max(bounds.top, rect.top)
    bounds.right = Math.min(bounds.right, rect.right)
    bounds.bottom = Math.min(bounds.bottom, rect.bottom)
  }
  const usable = Math.max(160, bounds.right - bounds.left - pad * 2)
  const cap = Math.min(280, usable)
  bubble.style.maxWidth = `${Math.round(cap)}px`

  const anchor = tip.getBoundingClientRect()
  const centered = !tip.classList.contains("end")
  // 气泡宽度 ≤ cap（CSS 已夹住），所以"最坏占位"就是 cap：按它算位移，结果对更窄的真实宽度同样成立。
  let left = 0
  if (centered) {
    const center = anchor.left + anchor.width / 2
    if (center - cap / 2 < bounds.left + pad) left = bounds.left + pad - (center - cap / 2)
    else if (center + cap / 2 > bounds.right - pad) left = bounds.right - pad - (center + cap / 2)
  } else if (anchor.right - cap < bounds.left + pad) {
    left = bounds.left + pad - (anchor.right - cap)
  }

  /** 垂直仍需一次高度（要选上/下）：临时显示但不可见地量，量不到就按 CSS 默认的上方，
      并且无论如何把结果夹进 bounds —— 水平已经与这次测量无关，所以它迟到也不会越界。 */
  const inlineDisplay = bubble.style.display
  const inlineVisibility = bubble.style.visibility
  bubble.style.display = "block"
  bubble.style.visibility = "hidden"
  const measured = bubble.getBoundingClientRect()
  const height = measured.height
  bubble.style.display = inlineDisplay
  bubble.style.visibility = inlineVisibility
  const aboveTop = anchor.top - 6 - height
  const belowTop = anchor.bottom + 6
  const fitsAbove = height > 0 && aboveTop >= bounds.top + pad
  const fitsBelow = height > 0 && belowTop + height <= bounds.bottom - pad
  let top = fitsAbove ? aboveTop : fitsBelow ? belowTop : Math.max(bounds.top + pad, Math.min(aboveTop, bounds.bottom - pad - height))
  if (height <= 0) top = anchor.top - 6
  // CSS 里气泡的"自然位置"是贴在锚点上方 6px（bottom: calc(100% + 6px)），所以 Y 用相对它的位移。
  const naturalTop = anchor.top - 6 - height

  // 一次写完：内联 transform（立即生效，不依赖变量时序）+ 同步清掉可能残留的旧变量。
  bubble.style.removeProperty("--tip-shift-x")
  bubble.style.removeProperty("--tip-shift-y")
  const base = centered ? `calc(-50% + ${Math.round(left)}px)` : `${Math.round(left)}px`
  bubble.style.transform = `translate(${base}, ${Math.round(top - naturalTop)}px)`
}

function toMusicMetadata(entry: MediaItem): MusicMetadata | null {
  const id = entry.musicId ?? entry.id
  if (!id || !entry.title || !entry.source) return null
  const duration = entry.durationSeconds != null && Number.isFinite(entry.durationSeconds) ? Math.max(0, Math.round(entry.durationSeconds * 1000)) : 0
  return { id, name: entry.title, artists: entry.artist ? entry.artist.split(", ") : [], duration, platform: entry.source as MusicMetadata["platform"], coverUrl: entry.artworkUrl ?? "" }
}

/** Queue view: drag or keyboard reorder, 一键置顶, and a separate multi-select pass. */
function QueuePanel({ queue, connection }: { queue: MediaItem[]; connection: MusicPartyConnection }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [multi, setMulti] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null)
  const [message, setMessage] = useState("")
  const [saveOpen, setSaveOpen] = useState(false)
  const adapter = () => adapterOf(connection)
  function toggle(id: string) {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function removeSelected() {
    const target = adapter()
    if (!target) { setMessage("还没有连接到 Linkle 服务"); return }
    let sent = 0
    for (const id of selected) if (target.sendQueueMutation("queue.remove", id)) sent += 1
    setSelected(new Set())
    setMessage(`已移出 ${sent} 首`)
  }
  /** 松手即发：顺序属于用户直接意图，攒批防抖只会让反馈更差。 */
  function drop(targetId: string, after: boolean) {
    const target = adapter()
    setDragId(null)
    setDropAt(null)
    if (!target || !dragId || dragId === targetId) return
    if (target.reorderQueue(dragId, targetId, after ? "after" : "before")) setMessage("顺序已更新")
    else setMessage("排序没有发出去，请检查连接")
  }
  function moveByKeyboard(id: string, direction: "up" | "down") {
    const target = adapter()
    if (!target) return
    const index = queue.findIndex(entry => entry.id === id)
    const neighbor = queue[direction === "up" ? index - 1 : index + 1]
    if (!neighbor) return
    target.reorderQueue(id, neighbor.id, direction === "up" ? "before" : "after")
    setMessage(`已${direction === "up" ? "上移" : "下移"}一位`)
  }
  function toTop(id: string) {
    const target = adapter()
    if (!target) return
    if (target.sendQueueMutation("queue.top", id)) setMessage("已移到队列最前")
    else setMessage("置顶没有发出去，请检查连接")
  }
  async function clearAll() {
    const target = adapter()
    if (!target) { setMessage("还没有连接到 Linkle 服务"); return }
    if (!queue.length) { setMessage("队列已经是空的"); return }
    if (!window.confirm(`清空房间队列（${queue.length} 首）？其他成员也会一起清空。`)) return
    const ok = await target.clearQueue()
    setMessage(ok ? "队列已清空" : "清空没有成功，请稍后重试")
  }
  return (
    <>
      <div className="row inline-actions actions-end">
        <Key label="多选 · 批量移出或保存" ariaLabel="多选" pressed={multi} onClick={() => { setMulti(value => !value); setSelected(new Set()) }}><SelectAllOnRegular /></Key>
        <Key label="保存至歌单" ariaLabel="保存至歌单" pressed={saveOpen} disabled={!selected.size} onClick={() => setSaveOpen(value => !value)}><TextBulletListAddRegular /></Key>
        <Key label="移出队列" ariaLabel="移出选中" disabled={!selected.size} onClick={removeSelected}><SubtractCircleRegular /></Key>
        <Key label="清空队列 · 需要确认" ariaLabel="清空队列" disabled={!queue.length} onClick={() => void clearAll()}><DeleteRegular /></Key>
      </div>
      {saveOpen ? (
        <div className="notice save-notice" role="group" aria-label="选择目标歌单">
          <strong>保存选中 {selected.size} 首到…</strong>
          <SaveToPlaylist
            connection={connection}
            items={queue.filter(entry => selected.has(entry.id)).map(entry => toMusicMetadata(entry)).filter((entry): entry is MusicMetadata => entry !== null)}
            onDone={message => { setMessage(message); setSaveOpen(false); setSelected(new Set()) }}
          />
        </div>
      ) : null}
      {queue.map((entry, index) => {
        const dropHere = dropAt?.id === entry.id ? (dropAt.after ? " drop-after" : " drop-before") : ""
        return (
          <div
            className={`song with-cover${multi ? "" : " has-lead"}${dragId === entry.id ? " dragging" : ""}${dropHere}`} key={entry.id}
            draggable={!multi}
            onDragStart={event => { setDragId(entry.id); event.dataTransfer.effectAllowed = "move" }}
            onDragOver={event => {
              if (!dragId || dragId === entry.id) return
              event.preventDefault()
              const box = event.currentTarget.getBoundingClientRect()
              setDropAt({ id: entry.id, after: event.clientY > box.top + box.height / 2 })
            }}
            onDrop={event => { event.preventDefault(); drop(entry.id, dropAt?.after ?? false) }}
            onDragEnd={() => { setDragId(null); setDropAt(null) }}
          >
            {multi
              ? <input type="checkbox" aria-label={`选择 ${entry.title}`} checked={selected.has(entry.id)} onChange={() => toggle(entry.id)} />
              : <button type="button" className="grip" aria-label={`拖动排序或按上下方向键移动 ${entry.title}`} onKeyDown={event => {
                  if (event.key === "ArrowUp") { event.preventDefault(); moveByKeyboard(entry.id, "up") }
                  else if (event.key === "ArrowDown") { event.preventDefault(); moveByKeyboard(entry.id, "down") }
                }}><ReorderRegular /></button>}
            <RowCover connection={connection} url={entry.artworkUrl} />
            <div><strong>{entry.title}</strong><small>{artistOf(entry)}{entry.durationSeconds ? ` · ${formatTime(entry.durationSeconds * 1000)}` : ""} · {entry.source}</small></div>
            {multi ? null : (
              <Key label="移到队列最前" ariaLabel="置顶" disabled={index === 0} onClick={() => toTop(entry.id)}><ArrowStepOverRegular /></Key>
            )}
          </div>
        )
      })}
      {!queue.length ? <div className="empty"><h3>队列是空的</h3><p>去点歌或从歌单加入曲目。</p></div> : null}
      {message ? <p className="notice" role="status">{message}</p> : null}
    </>
  )
}


/** 每页大小：与服务端默认一致（搜索响应没有 total，用「满页」判还有下一页，网页端同款启发式）。 */
const SEARCH_PAGE_SIZE = 20

/** Search-to-queue view backed by the desktop search and enqueue endpoints. */
function SearchPanel({ connection, roomId }: { connection: MusicPartyConnection; roomId: string }) {
  const [platforms, setPlatforms] = useState<Array<{ id: string; name: string }>>([{ id: "netease", name: "网易云" }, { id: "youtube", name: "YouTube" }, { id: "bilibili", name: "Bilibili" }])
  const [platform, setPlatform] = useState("netease")
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<MusicSearchResult[]>([])
  // 分页：服务端本来就吃 offset/limit，只是以前写死 0/20；没有 total ⇒ 满页即认为还有下一页。
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  // 专辑视图（后端 §14.1）：只按能力位点灯 —— 总开关 features.albumSearch + 该平台 albumSearchProviders[platform]，
  // 缺键视为不支持；专辑曲目定死不分页，在面板内原地展开。
  const [searchType, setSearchType] = useState<"song" | "album">("song")
  const [albums, setAlbums] = useState<MusicAlbum[]>([])
  const [albumTotal, setAlbumTotal] = useState(0)
  const [albumHasMore, setAlbumHasMore] = useState(false)
  const [albumBusy, setAlbumBusy] = useState(false)
  const [expandedAlbum, setExpandedAlbum] = useState<string | null>(null)
  const [albumSongs, setAlbumSongs] = useState<MusicSearchResult[]>([])
  const [albumSongsBusy, setAlbumSongsBusy] = useState(false)
  const probe = adapterOf(connection)?.desktopProbe ?? null
  const albumSearchOn = probe?.features?.albumSearch === true && probe?.albumSearchProviders?.[platform] === true
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [multi, setMulti] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  // 翻页改成"滚到底自动续"（用户 2026-09-25）：按钮每次出现/消失都会顶动列表，
  // 所以只留一条哨兵 + 一个回到顶部的浮标。哨兵落在面板滚动容器里，滚到附近就续一页。
  const sentinelRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)
  const [atTop, setAtTop] = useState(true)
  // 回到顶部浮标只在"停止滚动"后出现（用户 2026-09-25）：滚动中收起，停 500ms 才浮出来。
  const [settled, setSettled] = useState(false)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadMoreRef = useRef<() => void>(() => {})
  loadMoreRef.current = () => { if (searchType === "album") void loadMoreAlbums(); else void loadMore() }
  const canLoadMoreRef = useRef(false)
  canLoadMoreRef.current = searchType === "album"
    ? albums.length > 0 && albumHasMore && !albumBusy && !busy
    : results.length > 0 && hasMore && !loadingMore && !busy
  useEffect(() => {
    const scroller = sentinelRef.current?.closest(".panel-body") as HTMLElement | null
    scrollerRef.current = scroller
    if (!scroller) return
    const onScroll = () => {
      const top = scroller.scrollTop <= 120
      setAtTop(top)
      setSettled(false)
      if (settleTimer.current) clearTimeout(settleTimer.current)
      if (!top) settleTimer.current = setTimeout(() => setSettled(true), 500)
    }
    onScroll()
    scroller.addEventListener("scroll", onScroll, { passive: true })
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting) && canLoadMoreRef.current) loadMoreRef.current()
    }, { root: scroller, rootMargin: "120px 0px" })
    if (sentinelRef.current) observer.observe(sentinelRef.current)
    return () => {
      scroller.removeEventListener("scroll", onScroll)
      observer.disconnect()
      if (settleTimer.current) clearTimeout(settleTimer.current)
    }
  }, [])
  const remainAlbums = Math.max(0, albumTotal - albums.length)
  useEffect(() => {
    const adapter = adapterOf(connection)
    if (!adapter) return
    let token = true
    void adapter.listPlatforms().then(list => { if (token && list.length) setPlatforms(list) }).catch(() => undefined)
    return () => { token = false }
  }, [connection])
  function toTop() { scrollerRef.current?.scrollTo({ top: 0, behavior: "smooth" }) }
  async function run(event: React.FormEvent) {
    event.preventDefault()
    const adapter = adapterOf(connection)
    if (!adapter || !query.trim()) return
    setBusy(true); setMessage(""); setHasMore(false); setAlbumHasMore(false); setExpandedAlbum(null); setAlbumSongs([])
    scrollerRef.current?.scrollTo({ top: 0 })
    try {
      if (searchType === "album") {
        const page = await adapter.searchAlbums(platform, query.trim(), { roomId, limit: SEARCH_PAGE_SIZE })
        setAlbums(page.items)
        setAlbumTotal(page.total)
        setAlbumHasMore(page.total > 0 ? page.items.length < page.total : page.items.length >= SEARCH_PAGE_SIZE)
        if (!page.items.length) setMessage("没有匹配的专辑")
      } else {
        const found = await adapter.search(platform, query.trim(), { roomId, limit: SEARCH_PAGE_SIZE })
        setResults(found)
        setHasMore(found.length >= SEARCH_PAGE_SIZE)
        if (!found.length) setMessage("没有匹配的曲目")
      }
    } catch { setMessage("搜索失败，请检查服务连接") }
    finally { setBusy(false) }
  }
  /** 专辑翻页：有 total 就按它判到底，total===0 回落满页启发式（§14.1）。 */
  async function loadMoreAlbums() {
    const adapter = adapterOf(connection)
    if (!adapter || !query.trim() || albumBusy) return
    setAlbumBusy(true); setMessage("")
    try {
      const page = await adapter.searchAlbums(platform, query.trim(), { roomId, offset: albums.length, limit: SEARCH_PAGE_SIZE })
      setAlbums(current => [...current, ...page.items.filter(entry => !current.some(existing => existing.id === entry.id))])
      setAlbumTotal(page.total)
      setAlbumHasMore(page.total > 0 ? albums.length + page.items.length < page.total : page.items.length >= SEARCH_PAGE_SIZE)
    } catch { setMessage("加载更多失败，请稍后重试") }
    finally { setAlbumBusy(false) }
  }
  /** 展开/收起专辑曲目（一次全量，契约不分页）。 */
  async function toggleAlbum(album: MusicAlbum) {
    if (expandedAlbum === album.id) { setExpandedAlbum(null); return }
    const adapter = adapterOf(connection)
    if (!adapter) { setMessage("还没有连接到 Linkle 服务"); return }
    setExpandedAlbum(album.id); setAlbumSongsBusy(true); setAlbumSongs([]); setMessage("")
    try { setAlbumSongs(await adapter.albumSongs(album.platform || platform, album.id)) }
    catch { setMessage("专辑曲目读取失败，请稍后重试") }
    finally { setAlbumSongsBusy(false) }
  }
  async function enqueueAlbum(album: MusicAlbum) {
    const adapter = adapterOf(connection)
    if (!adapter) { setMessage("还没有连接到 Linkle 服务"); return }
    setMessage(`正在把「${album.name}」整张加入队列…`)
    const ok = await adapter.enqueueAlbum(album.platform || platform, album.id)
    setMessage(ok ? `已把「${album.name}」整张加入队列` : `整张加入失败：${album.name}`)
  }
  /** 加载更多：服务端没有 total，只能一页页追加；返回不足一页就判定到底。 */
  async function loadMore() {
    const adapter = adapterOf(connection)
    if (!adapter || !query.trim() || loadingMore) return
    setLoadingMore(true); setMessage("")
    try {
      const page = await adapter.search(platform, query.trim(), { roomId, offset: results.length, limit: SEARCH_PAGE_SIZE })
      setResults(current => [...current, ...page.filter(entry => !current.some(existing => existing.id === entry.id))])
      setHasMore(page.length >= SEARCH_PAGE_SIZE)
    } catch { setMessage("加载更多失败，请稍后重试") }
    finally { setLoadingMore(false) }
  }
  async function enqueue(result: MusicSearchResult) {
    const adapter = adapterOf(connection)
    if (!adapter) { setMessage("还没有连接到 Linkle 服务"); return }
    const ok = await adapter.enqueue(result.platform, result.sourceId)
    setMessage(ok ? `已加入队列：${result.title}` : `没能加入队列：${result.title}`)
  }
  async function enqueueSelected() {
    const adapter = adapterOf(connection)
    if (!adapter || !selected.size) return
    let ok = 0
    for (const result of results.filter(entry => selected.has(entry.id))) if (await adapter.enqueue(result.platform, result.sourceId)) ok += 1
    setMessage(`已加入 ${ok}/${selected.size} 首`)
    setSelected(new Set())
  }
  const platformName = platforms.find(entry => entry.id === platform)?.name ?? "网易云"
  return (
    <>
      {albumSearchOn ? (
        <div className="pl-seg search-tabs" role="group" aria-label="搜索类型">
          {([["song", "歌曲"], ["album", "专辑"]] as const).map(([value, label]) => (
            <button key={value} type="button" className={searchType === value ? "on" : undefined} aria-pressed={searchType === value} onClick={() => { setSearchType(value); setMessage("") }}>{label}</button>
          ))}
        </div>
      ) : null}
      <form className="searchbar" onSubmit={event => void run(event)}>
        <Dropdown
          className="platform-picker" aria-label="音乐平台" value={platformName} selectedOptions={[platform]}
          onOptionSelect={(_event, data) => { if (data.optionValue) setPlatform(data.optionValue) }}
        >
          {platforms.map(entry => <Option key={entry.id} value={entry.id}>{entry.name}</Option>)}
        </Dropdown>
        <input type="search" value={query} onChange={event => setQuery(event.currentTarget.value)} placeholder="搜索歌曲、艺术家或粘贴链接" aria-label="搜索曲目" />
        <button type="submit" className="i32 search-go" aria-label="搜索" title="搜索" disabled={busy || !query.trim()}><SearchRegular /></button>
      </form>
      {searchType === "album" ? (
        <>
          {albums.map(album => (
            <div key={album.id}>
              <div className="song with-cover">
                <RowCover connection={connection} url={album.coverUrl} />
                <div>
                  <strong>{album.name}</strong>
                  <small>{album.artistName || "未知艺术家"} · {album.platform}{album.trackCount ? ` · ${album.trackCount} 首` : ""}</small>
                </div>
                <span className="actions">
                  <Key className="end" label={expandedAlbum === album.id ? "收起曲目" : "展开曲目"} ariaLabel={`${expandedAlbum === album.id ? "收起" : "展开"}：${album.name}`} onClick={() => void toggleAlbum(album)}>{expandedAlbum === album.id ? <ChevronUpRegular /> : <ChevronDownRegular />}</Key>
                  <Key className="end" label="整张加入队列" ariaLabel={`整张加入：${album.name}`} onClick={() => void enqueueAlbum(album)}><AddSquareMultipleRegular /></Key>
                </span>
              </div>
              {expandedAlbum === album.id ? (
                <div className="album-songs" aria-label={`专辑曲目：${album.name}`}>
                  {albumSongsBusy ? <p className="muted">正在读取曲目…</p> : null}
                  {albumSongs.map(song => (
                    <div className="song with-cover has-lead" key={song.id}>
                      <RowCover connection={connection} url={song.artworkUrl} />
                      <div><strong>{song.title}</strong><small>{artistOf(song)} · {song.platform}{song.durationSeconds ? ` · ${formatTime(song.durationSeconds * 1000)}` : ""}</small></div>
                      <Key className="add-btn end" label="加入队列" ariaLabel={`加入队列：${song.title}`} onClick={() => void enqueue(song)}><AddRegular /></Key>
                    </div>
                  ))}
                  {!albumSongsBusy && !albumSongs.length ? <p className="muted">这张专辑没有可加入的曲目</p> : null}
                </div>
              ) : null}
            </div>
          ))}
        </>
      ) : null}
      {searchType === "song" && results.length ? (
        <div className="row inline-actions actions-end">
          <Key label="多选 · 批量加入队列" ariaLabel="多选" pressed={multi} onClick={() => { setMulti(value => !value); setSelected(new Set()) }}><SelectAllOnRegular /></Key>
          {multi ? <button type="button" className="primary" disabled={!selected.size} onClick={() => void enqueueSelected()}>加入选中（{selected.size}）</button> : null}
        </div>
      ) : null}
      {searchType === "song" ? results.map(result => (
        <div className={multi ? "song with-cover has-lead" : "song with-cover"} key={result.id}>
          {multi ? <input type="checkbox" aria-label={`选择 ${result.title}`} checked={selected.has(result.id)} onChange={() => setSelected(current => {
            const next = new Set(current)
            if (next.has(result.id)) next.delete(result.id)
            else next.add(result.id)
            return next
          })} /> : null}
          <RowCover connection={connection} url={result.artworkUrl} />
          <div><strong>{result.title}</strong><small>{artistOf(result)} · {result.platform}{result.durationSeconds ? ` · ${formatTime(result.durationSeconds * 1000)}` : ""}</small></div>
          {multi ? null : <Key className="add-btn end" label="加入队列" ariaLabel={`加入队列：${result.title}`} onClick={() => void enqueue(result)}><AddRegular /></Key>}
        </div>
      )) : null}
      {busy ? <p className="notice">正在搜索…</p> : null}
      {message ? <p className="notice" role="status">{message}</p> : null}
      {/* 翻页哨兵：滚到列表末尾附近自动续一页（按钮已撤，用户 2026-09-25）；
          它常驻 DOM，所以观察器不用随结果重建。 */}
      <div className="load-sentinel" ref={sentinelRef} role="status">
        {loadingMore || albumBusy ? "正在加载…" : searchType === "album" && albumHasMore && remainAlbums ? `继续滚动加载 · 还有 ${remainAlbums} 张` : ""}
      </div>
      {!atTop && settled ? (
        <button type="button" className="panel-top" aria-label="回到顶部" title="回到顶部" onClick={toTop}><ChevronUpRegular /></button>
      ) : null}
    </>
  )
}

/** 导出的一行：队列与歌单条目都归一到这个形状，三种格式共用一份拼装逻辑。 */
type ExportRow = { title: string; artist: string | null; durationSeconds: number | null; source: string }
function exportRowsText(rows: ExportRow[], format: "TXT" | "CSV" | "JSON"): string {
  if (format === "JSON") return JSON.stringify(rows, null, 2)
  if (format === "CSV") return ["title,artist,duration_seconds,platform", ...rows.map(row => [row.title, row.artist ?? "", row.durationSeconds ?? "", row.source].map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","))].join("\r\n")
  return rows.map((row, index) => `${index + 1}. ${row.title} — ${row.artist || "未知艺术家"}`).join("\n")
}
const queueExportRows = (queue: MediaItem[]): ExportRow[] => queue.map(entry => ({ title: entry.title, artist: entry.artist ?? null, durationSeconds: entry.durationSeconds ?? null, source: entry.source }))
const playlistExportRows = (tracks: PlaylistTrack[]): ExportRow[] => tracks.map(track => ({ title: track.music.name, artist: track.music.artists.join(", ") || null, durationSeconds: track.music.duration ? Math.round(track.music.duration / 1000) : null, source: track.music.platform }))

/** Playlists ride the WS playlist.* surface (requestId correlated); export still copies the live queue. */
/** 保存到歌单：目标下拉 + 内联新建 + 结果回报。队列批量保存与房间历史收藏共用这一份。
    以前是「一排按钮 + window.prompt」——按钮一多就换行，prompt 在 Electron 里根本不能用。 */
function SaveToPlaylist({ connection, items, onDone, compact = false }: {
  connection: MusicPartyConnection
  items: MusicMetadata[]
  onDone: (message: string) => void
  compact?: boolean
}) {
  const [lists, setLists] = useState<PlaylistSummary[]>([])
  const [targetId, setTargetId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    const target = adapterOf(connection)
    if (!target) { setError("还没有连接到 Linkle 服务"); return }
    let live = true
    void target.listPlaylists("user").then(items => {
      if (!live) return
      const usable = items.filter(entry => !entry.systemKey)
      setLists(usable)
      setTargetId(current => current ?? (usable[0]?.id ?? null))
    }).catch(() => { if (live) setError("歌单加载失败") })
    return () => { live = false }
  }, [connection])

  async function save(playlistId: string | null, newName = "") {
    const target = adapterOf(connection)
    if (!target) { setError("还没有连接到 Linkle 服务"); return }
    if (!items.length) { setError("没有可保存的曲目"); return }
    setBusy(true); setError("")
    try {
      let id = playlistId
      if (!id) {
        const trimmed = newName.trim()
        if (!trimmed) { setBusy(false); return }
        if (lists.some(entry => entry.name === trimmed)) { setError("已有同名歌单"); setBusy(false); return }
        id = (await target.createPlaylist("user", trimmed)).id
      }
      const result = await target.addPlaylistItems("user", id, items)
      const where = lists.find(entry => entry.id === id)?.name ?? newName.trim()
      onDone(`已加入「${where}」 ${result.addedCount} 首${result.skippedCount ? ` · 跳过 ${result.skippedCount} 首重复` : ""}`)
      setCreating(false); setName("")
    } catch { setError("保存失败，请检查连接") }
    finally { setBusy(false) }
  }

  return (
    <div className={`save-block${compact ? " compact" : ""}`}>
      {creating ? (
        <div className="row inline-actions">
          <input
            autoFocus value={name} maxLength={60} aria-label="新歌单名称" placeholder="新歌单名称"
            onChange={event => { setName(event.currentTarget.value); setError("") }}
            onKeyDown={event => { if (event.key === "Enter") void save(null, name); if (event.key === "Escape") { setCreating(false); setName("") } }}
          />
          <button type="button" className="primary" disabled={!name.trim() || busy} onClick={() => void save(null, name)}>创建并保存</button>
          <button type="button" onClick={() => { setCreating(false); setName(""); setError("") }}>返回</button>
        </div>
      ) : (
        <div className="row inline-actions">
          <Dropdown
            aria-label="目标歌单" disabled={busy || !lists.length} selectedOptions={targetId ? [targetId] : []}
            value={lists.find(entry => entry.id === targetId)?.name ?? (lists.length ? "选择歌单" : "还没有我的歌单")}
            onOptionSelect={(_, data) => setTargetId(data.optionValue ?? null)}
          >
            {lists.map(entry => <Option key={entry.id} value={entry.id} text={`${entry.name}（${entry.trackCount} 首）`}>{entry.name}（{entry.trackCount} 首）</Option>)}
          </Dropdown>
          <button type="button" className="primary" disabled={!targetId || busy} onClick={() => void save(targetId)}>{busy ? "保存中…" : `保存 ${items.length} 首`}</button>
          <button type="button" disabled={busy} onClick={() => { setCreating(true); setName("") }}>新建歌单…</button>
        </div>
      )}
      {error ? <p className="pl-error" role="status">{error}</p> : null}
    </div>
  )
}

/** 房间历史的一行：时间 + 封面 + 曲目 + 点歌者；动作是「加入队列」和「收藏到我的歌单」。 */
function HistoryRow({ connection, row, onNote }: { connection: MusicPartyConnection; row: RoomHistoryEntry; onNote: (message: string) => void }) {
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const at = new Date(row.at)
  const hh = String(at.getHours()).padStart(2, "0")
  const mm = String(at.getMinutes()).padStart(2, "0")
  async function enqueue() {
    const target = adapterOf(connection)
    if (!target) { onNote("还没有连接到 Linkle 服务"); return }
    setBusy(true)
    const ok = await target.enqueue(row.platform, row.musicId)
    setBusy(false)
    onNote(ok ? "已把这首加入队列" : "加入队列失败，请稍后重试")
  }
  const music: MusicMetadata = { id: row.musicId, name: row.name, artists: row.artist ? row.artist.split(", ") : [], duration: row.duration, platform: row.platform as MusicMetadata["platform"], coverUrl: row.coverUrl }
  return (
    <div className="pl-hist-row">
      <div className="pl-track">
        <span className="pl-num">{hh}:{mm}</span>
        <RowCover connection={connection} url={row.coverUrl || undefined} />
        <div className="pl-tinfo">
          <strong>{row.name}</strong>
          <small>{row.artist || "未知艺术家"} · {row.platform}{row.by ? ` · 点歌者 ${row.by}` : ""}</small>
        </div>
        <Key className="end" label="加入队列" ariaLabel={`加入队列：${row.name}`} disabled={busy} onClick={() => void enqueue()}><AddRegular /></Key>
        <Key className="end" label="收藏到歌单" ariaLabel={`收藏：${row.name}`} pressed={saving} disabled={busy} onClick={() => setSaving(value => !value)}><TextBulletListAddRegular /></Key>
      </div>
      {saving ? (
        <SaveToPlaylist compact connection={connection} items={[music]} onDone={message => { onNote(message); setSaving(false) }} />
      ) : null}
    </div>
  )
}

/** 歌单与导出（方案 A：单栏两级 + 面板头导出浮层；用户 2026-09-25 裁决）。
    数据全部走 playlist.*：list / getTracks(offset,limit) / create / rename / delete / add / remove / enqueue。
    摘要里没有封面、简介、更新时间与创建者，所以列表行只画名称、条数与系统徽标。 */
function PlaylistsPanel({ connection, queue, history, onLikesRowRemoved }: { connection: MusicPartyConnection; queue: MediaItem[]; history: RoomHistoryEntry[]; onLikesRowRemoved?: (musicId: string, platform: string) => void }) {
  const [scope, setScope] = useState<PlaylistScope>("room")
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [tracks, setTracks] = useState<PlaylistTrack[]>([])
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  // 房间历史：能位 `features.roomHistory` 为真时用服务端分页（handoff §13 冻结契约），
  // 否则/拉取失败时回落到本机记录（roomHistory 里那份 localStorage）。
  const [serverHistory, setServerHistory] = useState<{ rows: RoomHistoryEntry[]; total: number } | null>(null)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyNote, setHistoryNote] = useState("")
  const [exportOpen, setExportOpen] = useState(false)
  const [exportMessage, setExportMessage] = useState("")
  const [exporting, setExporting] = useState<string | null>(null)
  const PAGE = 100

  useEffect(() => {
    const target = adapterOf(connection)
    if (!target) { setMessage("还没有连接到 Linkle 服务"); return }
    let token = true
    setBusy(true)
    void target.listPlaylists(scope).then(list => {
      if (!token) return
      setPlaylists(list)
      const first = list.length ? list[0].id : null
      setOpenId(first)
      return first ? target.getPlaylistTracks(scope, first, { offset: 0, limit: PAGE }) : []
    }).then(items => { if (token && items) { setTracks(items); setMessage("") } })
      .catch(error => { if (token) setMessage(`歌单加载失败：${errCode(error)}`) })
      .finally(() => { if (token) setBusy(false) })
    return () => { token = false }
  }, [connection, scope])

  const supportsServerHistory = adapterOf(connection)?.desktopProbe?.features?.roomHistory === true
  // 按位点灯（§16）：位为假时 liked-songs 不显示行内删除键（老服务端上这条必然 SYSTEM_READONLY）。
  const likedSongsEdit = adapterOf(connection)?.desktopProbe?.features?.likedSongsEdit === true
  const historyRows = serverHistory?.rows ?? history
  /** 服务端历史的一页 → 行模型（music 是元数据、名字是读取时的 JOIN，null 就不猜）。 */
  const toRow = (item: PlaybackHistoryItem): RoomHistoryEntry => ({ key: item.id, musicId: item.music.id, name: item.music.name, artist: item.music.artists.join(", "), platform: item.music.platform, duration: item.music.duration, coverUrl: item.music.coverUrl, at: item.playedAt, by: item.enqueuerName })
  useEffect(() => {
    if (scope !== "room" || !supportsServerHistory) return
    const target = adapterOf(connection)
    if (!target) return
    let live = true
    setHistoryBusy(true)
    void target.listHistory({ offset: 0, limit: 50 }).then(page => {
      if (!live) return
      setServerHistory({ rows: page.items.map(toRow), total: page.total })
      setHistoryNote("")
    }).catch(() => { if (live) setHistoryNote("服务端历史暂时读不到，下面是本机记录") })
      .finally(() => { if (live) setHistoryBusy(false) })
    return () => { live = false }
  }, [scope, supportsServerHistory, connection])
  async function loadMoreHistory() {
    const target = adapterOf(connection)
    if (!target || !serverHistory) return
    setHistoryBusy(true)
    try {
      const page = await target.listHistory({ offset: serverHistory.rows.length, limit: 50 })
      setServerHistory({ rows: [...serverHistory.rows, ...page.items.map(toRow)], total: page.total })
    } catch { setHistoryNote("加载更早的历史失败，请稍后重试") }
    finally { setHistoryBusy(false) }
  }

  async function run(work: (target: MusicPartyAdapter) => Promise<string>) {
    const target = adapterOf(connection)
    if (!target) { setMessage("还没有连接到 Linkle 服务"); return }
    setBusy(true)
    try { setMessage(await work(target)) }
    catch (error) { setMessage(`操作失败：${errCode(error)}`) }
    finally { setBusy(false) }
  }

  function select(playlistId: string) {
    const target = adapterOf(connection)
    if (!target) return
    setOpenId(playlistId); setMenuId(null); setBusy(true)
    void target.getPlaylistTracks(scope, playlistId, { offset: 0, limit: PAGE }).then(items => { setTracks(items); setBusy(false) })
      .catch(error => { setMessage(`歌单加载失败：${errCode(error)}`); setBusy(false) })
  }
  function loadMore() {
    const target = adapterOf(connection)
    if (!target || !openId) return
    setBusy(true)
    void target.getPlaylistTracks(scope, openId, { offset: tracks.length, limit: PAGE })
      .then(items => { setTracks(current => [...current, ...items]); setBusy(false) })
      .catch(error => { setMessage(`歌单加载失败：${errCode(error)}`); setBusy(false) })
  }

  /** 新建改成面板内联输入：window.prompt 在沉浸整页里是块状的，也让「重名」无从提示。 */
  const [draft, setDraft] = useState<string | null>(null)
  const [draftError, setDraftError] = useState("")
  function commitDraft() {
    const name = (draft ?? "").trim()
    if (!name) { setDraft(null); setDraftError(""); return }
    if (name.length > 60) { setDraftError("名称太长（≤60 字）"); return }
    if (playlists.some(entry => entry.name === name)) { setDraftError("已有同名歌单"); return }
    void run(async target => {
      const created = await target.createPlaylist(scope, name)
      setPlaylists(current => [...current, created])
      setOpenId(created.id)
      setTracks([])
      setDraft(null); setDraftError("")
      return `已创建歌单「${created.name}」`
    })
  }
  /** 重命名走面板内联输入。原来用 window.prompt——Electron 不支持它，点了既没反应、
      还会把窗口焦点搅乱（用户 2026-09-25：新开文本框偶尔点不动，要 alt+tab 才恢复）。 */
  const [renameTarget, setRenameTarget] = useState<PlaylistSummary | null>(null)
  const [renameDraft, setRenameDraft] = useState("")
  function commitRename() {
    const entry = renameTarget
    const name = renameDraft.trim()
    if (!entry || !name || name === entry.name) { setRenameTarget(null); return }
    if (playlists.some(item => item.id !== entry.id && item.name === name)) { setMessage("已有同名歌单"); return }
    void run(async target => {
      const renamed = await target.renamePlaylist(scope, entry.id, name)
      setPlaylists(current => current.map(item => item.id === entry.id ? { ...item, ...renamed } : item))
      setRenameTarget(null)
      return "歌单已重命名"
    })
  }
  /** 删除同样内联两段确认（window.confirm 虽然能用，但外观与本面板不搭）。 */
  const [deleteTarget, setDeleteTarget] = useState<PlaylistSummary | null>(null)
  function commitDelete() {
    const entry = deleteTarget
    if (!entry) return
    void run(async target => {
      await target.deletePlaylist(scope, entry.id)
      setPlaylists(current => current.filter(item => item.id !== entry.id))
      setOpenId(null); setTracks([]); setDeleteTarget(null)
      return `已删除歌单「${entry.name}」`
    })
  }
  function enqueueAll(entry: PlaylistSummary) {
    setMenuId(null)
    void run(async target => `${await target.enqueuePlaylist(scope, entry.id)} 首已加入队列`)
  }
  function removeTrack(track: PlaylistTrack) {
    if (!openId) return
    void run(async target => {
      const removed = await target.removePlaylistTracks(scope, openId, [track.id])
      setTracks(current => current.filter(item => item.id !== track.id))
      setPlaylists(current => current.map(item => item.id === openId ? { ...item, trackCount: Math.max(0, item.trackCount - removed) } : item))
      const likedList = playlists.find(entry => entry.id === openId)?.systemKey === LIKED_SONGS_SYSTEM_KEY
      // 「喜欢歌单」删行与房间心跳在服务端是两份真相、互不同步（handoff §16）⇒ 删的若正是当前这首
      // 且本机点过，这里要一并撤掉房间那份，否则红心会继续亮着（用户 2026-09-25 报的 bug）。
      if (likedList) onLikesRowRemoved?.(track.music.id, track.music.platform)
      return likedList ? `${removed} 首已取消喜欢（网页端那份一起移除）` : `${removed} 首已从歌单移除`
    })
  }

  const opened = playlists.find(entry => entry.id === openId) ?? null
  /** 另存为：路径由主进程的系统保存对话框决定（渲染层只给建议名/后缀/正文）。 */
  async function saveExport(kind: "queue" | "playlist", format: "TXT" | "CSV" | "JSON") {
    const extension = format.toLowerCase() as "txt" | "csv" | "json"
    setExporting(`${kind}-${extension}`)
    setExportMessage("")
    try {
      let rows: ExportRow[]
      let label: string
      if (kind === "playlist") {
        const target = adapterOf(connection)
        if (!target || !opened) { setExportMessage("先选一个歌单"); return }
        // 导出歌单要拉全量：接口按 offset/limit 分页，长歌单得翻完再拼。
        const all: PlaylistTrack[] = []
        const total = opened.trackCount || 0
        for (let offset = 0; offset < 5000; offset += 50) {
          const page = await target.getPlaylistTracks(scope, opened.id, { offset, limit: 50 })
          all.push(...page)
          if (page.length < 50) break
          if (total) setExportMessage(`正在读取 ${Math.min(all.length, total)}/${total}…`)
        }
        rows = playlistExportRows(all)
        label = opened.name
      } else {
        rows = queueExportRows(queue)
        label = "队列"
      }
      if (!rows.length) { setExportMessage(`${label}是空的，没有可导出的曲目`); return }
      const reply = await invoke<{ saved?: boolean }>("saveTextFile", {
        suggestedName: `Linkle ${label} ${new Date().toISOString().slice(0, 10)}`,
        extension,
        text: exportRowsText(rows, format),
      })
      setExportMessage(reply?.saved ? `已保存 ${format} · ${label} ${rows.length} 首` : "已取消保存")
    } catch {
      setExportMessage("保存失败：无法写入所选位置")
    } finally {
      setExporting(null)
    }
  }
  async function copyExport() {
    const rows = queueExportRows(queue)
    if (!rows.length) { setExportMessage("队列是空的，没有可复制的曲目"); return }
    const text = exportRowsText(rows, "TXT")
    try {
      await navigator.clipboard.writeText(text)
      setExportMessage(`已复制 ${rows.length} 首到剪贴板`)
    } catch {
      const area = document.createElement("textarea")
      area.value = text
      document.body.append(area)
      area.select()
      const ok = document.execCommand("copy")
      area.remove()
      setExportMessage(ok ? `已复制 ${rows.length} 首到剪贴板` : "复制失败：剪贴板权限被拒绝")
    }
  }

  const scopeLabel = scope === "room" ? "房间历史" : "我的歌单"
  return (
    <div className="pl-panel">
      <div className="pl-toolbar">
        <div className="pl-seg" role="group" aria-label="歌单范围">
          {([["room", "房间历史"], ["user", "我的歌单"]] as const).map(([value, label]) => (
            <button key={value} type="button" className={scope === value ? "on" : undefined} aria-pressed={scope === value} onClick={() => { setScope(value); setMenuId(null) }}>{label}</button>
          ))}
        </div>
        <span className="spacer" />
        <Key className="end" label="导出" ariaLabel="导出" pressed={exportOpen} onClick={() => { setExportOpen(value => !value); setExportMessage("") }}><ArrowExportRegular /></Key>
        <Key className="end" label="新建歌单" ariaLabel="新建歌单" disabled={busy} onClick={() => { setDraft(""); setDraftError(""); setMenuId(null) }}><AddRegular /></Key>
      </div>
      {draft !== null ? (
        <div className="pl-draft">
          <input
            autoFocus value={draft} maxLength={60} aria-label="新歌单名称" placeholder={scope === "room" ? "房间歌单名称" : "我的歌单名称"}
            onChange={event => { setDraft(event.currentTarget.value); setDraftError("") }}
            onKeyDown={event => { if (event.key === "Enter") commitDraft(); if (event.key === "Escape") { setDraft(null); setDraftError("") } }}
          />
          <button type="button" className="pl-btn primary" disabled={busy} onClick={commitDraft}>创建</button>
          <button type="button" className="pl-btn" onClick={() => { setDraft(null); setDraftError("") }}>取消</button>
          {draftError ? <span className="pl-error" role="status">{draftError}</span> : null}
        </div>
      ) : null}
      {renameTarget ? (
        <div className="pl-draft">
          <span className="pl-cap">重命名「{renameTarget.name}」</span>
          <input
            autoFocus value={renameDraft} maxLength={60} aria-label="歌单名称"
            onChange={event => setRenameDraft(event.currentTarget.value)}
            onKeyDown={event => { if (event.key === "Enter") commitRename(); if (event.key === "Escape") setRenameTarget(null) }}
          />
          <button type="button" className="pl-btn primary" disabled={busy} onClick={commitRename}>保存</button>
          <button type="button" className="pl-btn" onClick={() => setRenameTarget(null)}>取消</button>
        </div>
      ) : null}
      {deleteTarget ? (
        <div className="pl-draft">
          <span className="pl-error">删除「{deleteTarget.name}」（{deleteTarget.trackCount} 首）？不可撤销</span>
          <span className="spacer" />
          <button type="button" className="pl-btn" onClick={() => setDeleteTarget(null)}>取消</button>
          <button type="button" className="pl-btn danger" disabled={busy} onClick={commitDelete}>确认删除</button>
        </div>
      ) : null}
      {exportOpen ? (
        <>
          <button type="button" className="pl-pop-backdrop" aria-label="关闭导出菜单" onClick={() => setExportOpen(false)} />
          <div className="pl-pop" role="menu" aria-label="导出">
            <p className="pl-cap">导出当前队列 · {queue.length} 首</p>
            <div className="pl-fmts">
              {(["TXT", "CSV", "JSON"] as const).map(format => (
                <button key={format} type="button" role="menuitem" disabled={!queue.length || Boolean(exporting)} onClick={() => void saveExport("queue", format)}>
                  {exporting === `queue-${format.toLowerCase()}` ? "保存中…" : `另存为 ${format}`}
                </button>
              ))}
              <button type="button" role="menuitem" disabled={!queue.length} onClick={() => void copyExport()}>复制 TXT</button>
            </div>
            <div className="pl-sep" />
            <p className="pl-cap">导出「{opened?.name ?? "未选择歌单"}」 · {opened?.trackCount ?? 0} 首</p>
            <div className="pl-fmts">
              {(["TXT", "CSV", "JSON"] as const).map(format => (
                <button key={format} type="button" role="menuitem" disabled={!opened || !opened.trackCount || Boolean(exporting)} onClick={() => void saveExport("playlist", format)}>
                  {exporting === `playlist-${format.toLowerCase()}` ? "保存中…" : format}
                </button>
              ))}
            </div>
            {exportMessage ? <p className="pl-cap" role="status">{exportMessage}</p> : null}
          </div>
        </>
      ) : null}
      {scope === "room" ? (
        <div className="pl-hist" role="listbox" aria-label="房间播放历史">
          <div className="pl-hist-head">
            <span className="pl-cap">{supportsServerHistory ? `房间历史 · 已加载 ${historyRows.length}${serverHistory ? ` / ${serverHistory.total}` : ""} 条` : "房间历史 · 本机记录"}</span>
            {historyBusy ? <span className="pl-cap">正在读取…</span> : null}
            {serverHistory && historyRows.length < serverHistory.total ? (
              <button type="button" className="pl-btn" disabled={historyBusy} onClick={() => void loadMoreHistory()}>加载更早</button>
            ) : null}
          </div>
          {historyNote ? <p className="pl-cap">{historyNote}</p> : null}
          {historyRows.map(row => (
            <HistoryRow key={row.key} connection={connection} row={row} onNote={message => setMessage(message)} />
          ))}
          {!historyRows.length && !historyBusy ? (
            <div className="pl-empty">
              <strong>这个房间还没有播过歌</strong>
              <p className="muted">播过的曲子会按时间倒序落在这里，方便回头收藏。</p>
            </div>
          ) : null}
        </div>
      ) : (
      <>
      <div className="pl-list" role="listbox" aria-label="歌单列表">
        {playlists.map(entry => (
          <div key={entry.id} className={`pl-row${entry.id === openId ? " on" : ""}`}>
            <button type="button" className="pl-open" aria-current={entry.id === openId} onClick={() => select(entry.id)}>
              <span className="pl-name">{entry.name}</span>
              <span className="pl-meta">{entry.trackCount} 首</span>
              {entry.systemKey ? <span className="pl-sys">系统</span> : null}
            </button>
            <button type="button" className="pl-ico" aria-label={`${entry.name} 的更多操作`} aria-expanded={menuId === entry.id} onClick={() => setMenuId(menuId === entry.id ? null : entry.id)}>⋯</button>
            {menuId === entry.id ? (
              <div className="pl-menu" role="menu" aria-label={`${entry.name} 操作`}>
                <button type="button" role="menuitem" onClick={() => { setMenuId(null); select(entry.id) }}>打开</button>
                <button type="button" role="menuitem" onClick={() => enqueueAll(entry)}>全部加入队列</button>
                <button type="button" role="menuitem" onClick={() => { setMenuId(null); setExportOpen(true) }}>导出此歌单…</button>
                {entry.systemKey ? null : (
                  <>
                    <button type="button" role="menuitem" onClick={() => { setMenuId(null); setRenameTarget(entry); setRenameDraft(entry.name) }}>重命名</button>
                    <button type="button" role="menuitem" className="danger" onClick={() => { setMenuId(null); setDeleteTarget(entry) }}>删除歌单</button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        ))}
        {busy && !playlists.length ? <p className="muted">正在加载歌单…</p> : null}
        {!busy && !playlists.length ? (
          <div className="pl-empty">
            <strong>这个账号还没有歌单</strong>
            <p className="muted">「我的歌单」跟着你的账号走，换机器也在；房间历史在左边那一格。</p>
            <button type="button" className="pl-btn primary" onClick={() => { setDraft(""); setDraftError("") }}>新建歌单</button>
          </div>
        ) : null}
      </div>
      {opened ? (
        <section className="pl-detail" aria-label={`歌单条目：${opened.name}`}>
          <div className="pl-dhead">
            <h4>{opened.name}</h4>
            <span className="pl-meta">{tracks.length}{opened.trackCount > tracks.length ? ` / ${opened.trackCount}` : ""} 首</span>
            <span className="spacer" />
            <button type="button" className="pl-btn primary" disabled={busy} onClick={() => enqueueAll(opened)}>全部加入队列</button>
          </div>
          <div className="pl-tracks">
            {tracks.map((track, index) => (
              <div className="pl-track" key={track.id}>
                <span className="pl-num">{index + 1}</span>
                <RowCover connection={connection} url={track.music.coverUrl} />
                <div className="pl-tinfo"><strong>{track.music.name}</strong><small>{track.music.artists.join(", ") || "未知艺术家"} · {track.music.platform}{track.music.duration ? ` · ${formatTime(track.music.duration)}` : ""}</small></div>
                {opened.systemKey && !(opened.systemKey === LIKED_SONGS_SYSTEM_KEY && likedSongsEdit) ? null : (
                  <button
                    type="button" className="pl-ico" disabled={busy} onClick={() => removeTrack(track)}
                    aria-label={opened.systemKey === LIKED_SONGS_SYSTEM_KEY ? `取消喜欢 ${track.music.name}` : `从 ${opened.name} 移除 ${track.music.name}`}
                    title={opened.systemKey === LIKED_SONGS_SYSTEM_KEY ? "取消喜欢 · 会同时从网页端那份移除" : "从歌单移除"}
                  ><DismissRegular /></button>
                )}
              </div>
            ))}
            {!tracks.length && !busy ? <p className="muted">歌单还是空的 · 从队列选中曲目后保存到这里</p> : null}
            {tracks.length && tracks.length < opened.trackCount ? <button type="button" className="pl-btn" disabled={busy} onClick={loadMore}>加载更多（还有 {opened.trackCount - tracks.length} 首）</button> : null}
          </div>
        </section>
      ) : <p className="muted">选一个歌单查看条目</p>}
      </>
      )}
      {message ? <p className="muted" role="status">{message}</p> : null}
    </div>
  )
}
/** 房间播放历史的一行。服务端只在内部存这份历史、对外只给 historyCursor（已播计数），
    没有列表接口——所以这里先记「本机在房间里看到过什么播过」，跨用户的历史要后端加 history.list。
    存 localStorage（按房间分键，最多 200 条），重启后还能回去找。 */
type RoomHistoryEntry = { key: string; musicId: string; name: string; artist: string; platform: string; duration: number; coverUrl: string; at: number; by: string | null }
const historyKey = (roomId: string) => `watchparty.linkle.history.${roomId}`
function readRoomHistory(roomId: string): RoomHistoryEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(historyKey(roomId)) ?? "[]") as unknown
    if (!Array.isArray(raw)) return []
    // 兼容早期只存了 id 的条目：那时 id 就是曲目 id。
    return raw.map(row => {
      const value = row as Partial<RoomHistoryEntry> & { id?: unknown }
      if (!value || typeof value !== "object" || typeof value.name !== "string") return null
      const key = typeof value.key === "string" ? value.key : (typeof value.id === "string" ? value.id : null)
      const musicId = typeof value.musicId === "string" ? value.musicId : (typeof value.id === "string" ? value.id : null)
      if (!key || !musicId) return null
      return { key, musicId, name: value.name, artist: typeof value.artist === "string" ? value.artist : "", platform: typeof value.platform === "string" ? value.platform : "", duration: typeof value.duration === "number" ? value.duration : 0, coverUrl: typeof value.coverUrl === "string" ? value.coverUrl : "", at: typeof value.at === "number" ? value.at : 0, by: typeof value.by === "string" ? value.by : null }
    }).filter((row): row is RoomHistoryEntry => row !== null).slice(0, 200)
  } catch { return [] }
}
function storeRoomHistory(roomId: string, entries: RoomHistoryEntry[]) {
  try { localStorage.setItem(historyKey(roomId), JSON.stringify(entries)) } catch { /* 本机存储不可用时只留内存 */ }
}

/** 房间功能页签：图标按钮 + 未读角标（label 同时是 aria-label；窄容器下 .optional 会被 CSS 隐藏）。 */
function RoomTab({ className = "", icon, label, badge, active, onClick }: {
  className?: string
  icon: React.ReactNode
  label: string
  badge?: number
  active?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={className ? `tab ${className}` : "tab"} aria-label={label} aria-current={active ? "page" : undefined} onClick={onClick}>
      {icon}
      {badge ? <span className="badge">{badge}</span> : null}
    </button>
  )
}

/** 图标键：按钮 + 提示气泡（提示的落位由 placeTooltip 在指针进入时算）。 */
function Key({ className = "", label, ariaLabel, pressed, disabled, onClick, children }: {
  className?: string
  label: React.ReactNode
  ariaLabel: string
  pressed?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <span className={className ? `tip ${className}` : "tip"}>
      <button type="button" className="i32" aria-label={ariaLabel} aria-pressed={pressed} disabled={disabled} onClick={onClick}>{children}</button>
      <span className="tooltip" role="tooltip">{label}</span>
    </span>
  )
}

/** 方案 B（用户 2026-09-25 裁决）：双栏常驻 —— 左消息流、右在线成员；
    面板窄于 420px（拖窄的分栏侧板）时成员栏收起，回到单栏。 */
function ChatPanel({ connection, subscribeRoom, members, enqueuerName, identity, roomId, onOpenSearch }: {
  connection: MusicPartyConnection
  subscribeRoom: (listener: (event: DomainEvent) => void) => () => void
  members: Array<{ id: string; name: string; online: boolean }>
  enqueuerName: string | null
  identity: { id: string; name: string; source: "local" | "server" } | null
  roomId: string
  onOpenSearch: () => void
}) {
  const [messages, setMessages] = useState<Array<{ id: string; author: string; content: string; createdAt?: string }>>([])
  const [input, setInput] = useState("")
  const [status, setStatus] = useState("")
  const [historyDone, setHistoryDone] = useState(false)
  const expectingHistory = useRef(false)
  const historyCount = useRef(0)
  const seen = useRef(new Set<string>())
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [focusMember, setFocusMember] = useState<string | null>(null)
  const [unread, setUnread] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(false)

  useEffect(() => subscribeRoom(event => {
    if (event.type !== "chat") return
    if (seen.current.has(event.id)) return
    seen.current.add(event.id)
    setMessages(current => {
      const entry = { id: event.id, author: event.author, content: event.content, createdAt: event.createdAt }
      return expectingHistory.current ? [entry, ...current] : [...current, entry]
    })
    if (!expectingHistory.current && !pinnedToBottom.current) setUnread(value => value + 1)
    if (expectingHistory.current) historyCount.current += 1
  }), [subscribeRoom])

  useEffect(() => {
    const list = scrollRef.current
    if (list && pinnedToBottom.current) list.scrollTop = list.scrollHeight
  }, [messages])
  function scrollToLatest() {
    const list = scrollRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
    pinnedToBottom.current = true
    setAtBottom(true)
    setUnread(0)
  }
  /** 滚到顶自动翻页；顶部那行同时说明是否还有更早的消息。 */
  function onListScroll(event: React.UIEvent<HTMLDivElement>) {
    const list = event.currentTarget
    pinnedToBottom.current = list.scrollTop + list.clientHeight >= list.scrollHeight - 24
    setAtBottom(pinnedToBottom.current)
    if (pinnedToBottom.current) setUnread(0)
    if (list.scrollTop <= 24 && !historyDone && !expectingHistory.current) fetchHistory()
  }
  /** 同一作者连续发言只显示一次名字；跨天或间隔 >5 分钟插一条时间分隔。 */
  function timeMark(index: number) {
    const current = messages[index]
    const previous = messages[index - 1]
    const at = current?.createdAt ? new Date(current.createdAt) : null
    if (!at || Number.isNaN(at.getTime())) return null
    const before = previous?.createdAt ? new Date(previous.createdAt) : null
    const sameDay = before && !Number.isNaN(before.getTime()) && before.toDateString() === at.toDateString()
    if (sameDay && at.getTime() - before.getTime() <= 5 * 60 * 1000) return null
    const today = at.toDateString() === new Date().toDateString()
    const label = today ? "今天" : `${at.getMonth() + 1} 月 ${at.getDate()} 日`
    return `${label} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
  }

  function fetchHistory() {
    const adapter = adapterOf(connection)
    if (!adapter) { setStatus("还没有连接到 Linkle 服务"); return }
    const before = historyCount.current
    expectingHistory.current = true
    setHistoryLoading(true)
    adapter.sendChatHistoryFetch(50, before)
    setTimeout(() => {
      expectingHistory.current = false
      setHistoryLoading(false)
      if (historyCount.current === before) setHistoryDone(true)
    }, 1500)
  }
  function send(event: React.FormEvent) {
    event.preventDefault()
    const text = input.trim()
    if (!text) return
    const adapter = adapterOf(connection)
    if (!adapter) { setStatus("还没有连接到 Linkle 服务 · 草稿已保留"); return }
    if (adapter.sendChat(text)) { setInput(""); setStatus("") }
    else setStatus("发送失败，草稿已保留")
  }
  const online = members.filter(entry => entry.online)
  const mine = identity?.name.trim() ?? ""
  const isMine = (author: string) => Boolean(mine) && author.trim() === mine
  return (
    <div className="chat-panel" data-identity={identity ? `${identity.name}|${identity.source}` : ""}>
      <div className="chat-cols">
        <div className="chat-main">
          {/* 加载更早：只在「还有消息没翻出来」时出现（用户 2026-09-25）。 */}
          {messages.length > 0 && !historyDone ? (
            <div className="chat-loader">
              <button type="button" className="chat-earlier" aria-label="加载更早消息" title="加载更早消息" disabled={historyLoading} onClick={fetchHistory}>{historyLoading ? "…" : <HistoryRegular />}</button>
              <span>滚到顶部也会自动加载</span>
            </div>
          ) : null}
          <div className="chat-scroll" ref={scrollRef} onScroll={onListScroll}>
            {messages.map((entry, index) => {
              const mark = timeMark(index)
              const sameAuthor = index > 0 && messages[index - 1].author === entry.author && !mark
              const focused = focusMember !== null && focusMember === entry.author
              return (
                <Fragment key={entry.id}>
                  {mark ? <span className="chat-day">{mark}</span> : null}
                  <div className={`chatline${isMine(entry.author) ? " me" : ""}${sameAuthor ? " same-author" : ""}${focused ? " focus" : ""}`}>
                    {sameAuthor ? null : <small className="chat-who">{entry.author}</small>}
                    <p className="chat-bub">{entry.content}</p>
                  </div>
                </Fragment>
              )
            })}
            {!messages.length ? (
              <div className="chat-empty">
                <strong>还没有消息</strong>
                <p>{roomId} · {online.length} 人在线，说点什么吧</p>
                <button type="button" onClick={onOpenSearch}>去点歌</button>
              </div>
            ) : null}
          </div>
          {!atBottom && unread > 0 ? <button type="button" className="chat-jump" onClick={scrollToLatest}>回到最新 · {unread} 条</button> : null}
          <form className="chat-composer" onSubmit={send}>
            <input type="text" value={input} maxLength={240} onChange={event => setInput(event.currentTarget.value)} placeholder="发送到当前频道" aria-label="聊天消息" />
            <button type="submit" className="chat-send" aria-label="发送" title="发送" disabled={!input.trim()}><SendRegular /></button>
          </form>
        </div>
        <aside className="chat-side" aria-label="在线成员">
          <span className="chat-side-cap">在线成员 · {online.length}</span>
          {online.map(entry => {
            const self = Boolean(identity) && entry.name.trim() === mine
            return (
              <button
                key={entry.id} type="button" className={`member${self ? " self" : ""}${focusMember === entry.name ? " hot" : ""}`}
                aria-pressed={focusMember === entry.name}
                onClick={() => setFocusMember(current => current === entry.name ? null : entry.name)}
              >
                <span className="dot" />
                <span className="member-name">{entry.name}{self ? <em>我</em> : null}</span>
                {entry.name && entry.name === enqueuerName ? <span className="member-tag">当前点歌者</span> : null}
              </button>
            )
          })}
          {!online.length ? <p className="muted">还没有在线成员</p> : null}
          <span className="chat-side-cap">点成员可高亮其发言</span>
        </aside>
      </div>
      {status ? <p className="notice" role="status">{status}</p> : null}
    </div>
  )
}