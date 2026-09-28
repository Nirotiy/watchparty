import { invoke, listen, type UnlistenFn } from "../../shared/desktop-runtime"

import type { CommandAck, DesktopCommand, DesktopUiState, MediaCompatibility, MediaDirectoryPage } from "@/lib/contracts"

export interface PlayerPreferences {
  hardwareDecoding: "auto-safe" | "auto" | "no"
  deinterlace: "auto" | "on" | "off"
  hdr: "auto" | "sdr" | "passthrough"
  audioDevice: string | null
  channelLayout: "auto" | "stereo"
  defaultVolume: number
  audioLanguage: string
  subtitleLanguage: string
  subtitleFont: string
  subtitleScale: number
  subtitleAssOverride: boolean
  subtitleDelay: number
  cacheProfile: "auto" | "low-latency" | "stable"
  networkTimeout: number
}

export interface DesktopSettingsStatus {
  backendOrigin: string | null
  allowRemoteHttp: boolean
  nickname: string
  theme: "dark" | "light"
  windowMaterial: "auto" | "none"
  playerPreferences: PlayerPreferences
  credentialsConfigured: boolean
  /** Setup Guide completion flag: the first-run guide shows while this is false. */
  setupCompleted: boolean
  playerPreferenceFailures: string[]
}

export interface DesktopRoomResult { roomId: string }

export interface DesktopProbeReport {
  status: "ok"
  protocolVersion: number
  serviceVersion: string
  capabilities: {
    createRoom: boolean
    joinRoom: boolean
    restoreSession: boolean
    mediaSearch: boolean
    mediaQueue: boolean
    handoffCode: boolean
    /**
     * Whether the backend serves `GET /api/desktop/readiness`. Older backends
     * omit it; absence means "no readiness endpoint", which must NOT be read as
     * a degraded backend (the caller falls back to the reachable-means-usable
     * rule).
     */
    readiness?: boolean
  }
}

/**
 * Readiness payload as served by Node. Two different status vocabularies:
 * the top-level `status` is `ready|degraded`, while every *component* uses
 * `up|down` (see `server/core/http/readiness.ts:54-81`). The guide keys off
 * `status`/`code`/`diagnostics[].code` and never off a localized `message`
 * (backend handoff §6.3).
 */
export type ReadinessStatus = "ready" | "degraded"
export type ReadinessComponentStatus = "up" | "down"

export interface ReadinessComponent {
  status: ReadinessComponentStatus
  code?: string
  latencyMs?: number
  message?: string
  remediation?: string
}

export interface MediaRootProbe {
  name?: string
  ok?: boolean
  code?: "MEDIA_ROOT_OK" | "MEDIA_ROOT_NOT_FOUND"
}

export interface ReadinessDiagnostic {
  severity?: "error" | "warning"
  code: string
  message?: string
  remediation?: string
}

export interface DesktopReadinessReport {
  status: ReadinessStatus
  service: string
  protocolVersion?: number
  serviceVersion?: string
  readinessVersion: number
  bootId?: string
  startedAt?: number
  checkedAt: number
  listener?: { host?: string; configuredPort?: number; boundPort?: number; secure?: boolean }
  cache?: { ttlMs: number; ageMs: number; fromCache: boolean }
  config?: { openlist?: { url?: string; username?: string; password?: string }; mediaIdKey?: { mode?: string } }
  components: {
    core: ReadinessComponent
    openlist?: ReadinessComponent
    mediaRoots?: ReadinessComponent & { roots?: MediaRootProbe[] }
  }
  diagnostics?: ReadinessDiagnostic[]
}

/**
 * Probes the readiness endpoint. Resolves `null` when the backend predates the
 * endpoint (capability bit absent) or when the probe fails — an unavailable
 * readiness endpoint is not a degraded backend, only absent information.
 */
export async function probeDesktopReadiness(): Promise<DesktopReadinessReport | null> {  try {
    const report = await invoke<DesktopReadinessReport>("probeDesktopReadiness")
    return report ?? null
  } catch { return null }
}

export function probeDesktopBackend(): Promise<DesktopProbeReport> {
  return invoke("probeDesktopBackend")
}

export interface AudioOutputDevice { id: string; name: string }
export function listAudioOutputDevices(): Promise<AudioOutputDevice[]> {
  return invoke("listAudioOutputDevices")
}

export interface DesktopWallpaperBackdrop { image: string | null; average: string | null }
export function getDesktopWallpaperBackdrop(): Promise<DesktopWallpaperBackdrop> {
  return invoke("getDesktopWallpaperBackdrop")
}

interface DesktopStateEvent {
  type: "state"
  state: DesktopUiState
}

interface DesktopLaunchEvent {
  roomId: string
}

export function listenForLaunch(handler: (payload: DesktopLaunchEvent) => void): Promise<UnlistenFn> {
  return listen<DesktopLaunchEvent>("desktop://launch", ({ payload }) => handler(payload))
}

/** 自绘窗口按钮：播放页要随播放控件一起收放，所以窗口动作走同一条受白名单约束的通道。 */
export function windowControl(action: "minimize" | "maximize" | "close"): Promise<{ maximized: boolean }> {
  return invoke("windowControl", { action })
}

export function listenForWindowState(handler: (state: { maximized: boolean }) => void): Promise<UnlistenFn> {
  return listen<{ maximized: boolean }>("watchparty:window-state", ({ payload }) => handler(payload))
}

/**
 * Replays the latest deep-link launch. Cold-start deep links are emitted by the
 * runtime before the renderer registers listeners, so the hook must call this
 * right after subscribing.
 */
export function currentDesktopLaunch(): Promise<DesktopLaunchEvent | null> {
  return invoke("currentDesktopLaunch")
}

export function listenForState(handler: (state: DesktopUiState) => void): Promise<UnlistenFn> {
  return listen<DesktopStateEvent>("desktop://state", ({ payload }) => {
    if (payload.type === "state") handler(payload.state)
  })
}

export function startDesktopSession(ticket: string, expectedRoomId?: string | null): Promise<void> {
  return invoke("startDesktopSession", { ticket, expectedRoomId: expectedRoomId ?? null })
}

export function executeRoomCommand(command: DesktopCommand): Promise<CommandAck> {
  return invoke("executeRoomCommand", { command })
}

export function stopDesktopSession(): Promise<void> {
  return invoke("stopDesktopSession")
}

export function checkpointDesktopSession(): Promise<{ id: string } | null> {
  return invoke("checkpointDesktopSession")
}
export function suspendDesktopSession(): Promise<void> { return invoke("suspendDesktopSession") }
export function rollbackDesktopSession(checkpointId: string): Promise<void> {
  return invoke("rollbackDesktopSession", { checkpointId })
}
export function discardDesktopSessionCheckpoint(checkpointId: string): Promise<void> {
  return invoke("discardDesktopSessionCheckpoint", { checkpointId })
}

/** Install the existing native state listener before joining or rolling back. */
export async function withAuthoritativeSnapshot(roomId: string, action: () => Promise<unknown>, timeoutMs = 10000): Promise<void> {
  let unsubscribe: UnlistenFn | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let resolveState: () => void = () => {}
  let rejectState: (error: Error) => void = () => {}
  const stateReady = new Promise<void>((resolve, reject) => { resolveState = resolve; rejectState = reject })
  // The state may reject while the native action is still pending.
  void stateReady.catch(() => {})
  try {
    unsubscribe = await listenForState(state => {
      if (state.roomId === roomId && state.connection === "ready" && state.room) resolveState()
      else if (state.connection === "expired" || state.connection === "failed") rejectState(new Error("room_connection_failed"))
    })
    timer = setTimeout(() => rejectState(new Error("room_snapshot_timeout")), timeoutMs)
    await Promise.all([action(), stateReady])
  } finally { clearTimeout(timer); unsubscribe?.() }
}

export function createDesktopRoom(input: { nickname: string; pin?: string }): Promise<DesktopRoomResult> {
  return invoke("createDesktopRoom", { input })
}

export function accessDesktopRoom(input: { roomId: string; nickname: string; pin?: string }): Promise<DesktopRoomResult> {
  return invoke("accessDesktopRoom", { input })
}

export function restoreDesktopSession(): Promise<boolean> {
  return invoke("restoreDesktopSession")
}

export function getDesktopSettings(): Promise<DesktopSettingsStatus> {
  return invoke("getDesktopSettings")
}

export function updateDesktopSettings(input: {
  backendOrigin: string | null
  allowRemoteHttp: boolean
  nickname: string
  theme: "dark" | "light"
  windowMaterial?: "auto" | "none"
  playerPreferences: PlayerPreferences
  /**
   * Setup Guide completion flag. Omit it from ordinary settings saves: the
   * native side then keeps the stored value, so a theme or preference change
   * can never replay the first-run guide. Only the guide itself sends it.
   */
  setupCompleted?: boolean
}): Promise<DesktopSettingsStatus> {
  return invoke("updateDesktopSettings", { input })
}

export function promptSiteCredentials(): Promise<DesktopSettingsStatus | null> {
  return invoke("promptSiteCredentials")
}

export function listenForSessionReset(handler: () => void): Promise<UnlistenFn> {
  return listen("desktop://session-reset", handler)
}

export function listenForSettings(handler: (settings: DesktopSettingsStatus) => void): Promise<UnlistenFn> {
  return listen<DesktopSettingsStatus>("desktop://settings", ({ payload }) => handler(payload))
}

export function clearSiteCredentials(): Promise<DesktopSettingsStatus> {
  return invoke("clearSiteCredentials")
}

export function verifyBackend(): Promise<void> {
  return invoke("verifyBackend")
}

/** Catch the local management website before saving it as the Electron backend. */
export function backendAddressError(origin: string): string | undefined {
  try {
    const url = new URL(origin.trim())
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.port === "18083") {
      return "18083 是管理网页，不是 Banguru 后端。后端默认监听 8080，请填写如 http://主机:8080 或 https://主机。"
    }
  } catch { /* Native settings validation handles incomplete or invalid URLs on save. */ }
  return undefined
}

interface MusicPartyResponse { status: number; body: string }
function musicPartyRequest(origin: string | null, path: string, body?: unknown): Promise<MusicPartyResponse> {
  if (!origin) return Promise.reject(new Error("musicparty_origin_missing"))
  return invoke("musicPartyRequest", { input: { origin, path, method: "POST", body: body ?? null, clientVersion: "0.2.0" } })
}

export async function verifyPrivateRoom(roomId: string, password: string, origin: string | null): Promise<void> {
  const response = await musicPartyRequest(origin, `/api/rooms/${encodeURIComponent(roomId)}/verify`, { password })
  if (response.status < 200 || response.status >= 300) throw new Error(`musicparty_http_${response.status}`)
}

export interface OriginTrustRecord { origin: string; fingerprint: string; label?: string }

export function listOriginTrust(): Promise<OriginTrustRecord[]> {
  return invoke("listOriginTrust")
}

export function importOriginTrust(input: { origin: string; pem: string; fingerprint?: string }): Promise<OriginTrustRecord> {
  return invoke("importOriginTrust", { origin: input.origin, pem: input.pem })
}

export function deleteOriginTrust(origin: string): Promise<void> {
  return invoke("deleteOriginTrust", { origin })
}

export function mediaRoots(): Promise<string[]> {
  return invoke("mediaRoots")
}

export function mediaList(root: string, path?: string, cursor?: string): Promise<MediaDirectoryPage> {
  return invoke("mediaList", { root, path: path ?? "/", cursor: cursor ?? null })
}

export function mediaSearch(query: string, cursor?: string): Promise<MediaDirectoryPage> {
  return invoke("mediaSearch", { query, cursor: cursor ?? null })
}

/**
 * Media library contract, frozen 2026-09-26 (see temp-html/library-multi-source-frontend-handoff.md).
 * Server codes travel inside the body; the UI maps codes and never parses message text.
 */
export type MediaLibraryKind = "anime" | "movie" | "tv" | "other"
export type MediaLibraryHealth = "ok" | "unreachable" | "auth_failed" | "root_missing" | "not_configured"

export interface MediaLibrary {
  id: string
  name: string
  kind: MediaLibraryKind
  sourceId: string
  sourceName: string
  health: MediaLibraryHealth
}

export interface MediaCapabilities {
  libraries: boolean
  artwork: boolean
  catalog: boolean
  mediaAdmin: boolean
}

export interface MediaLibraryBreadcrumb { name: string; path: string }

export interface MediaLibraryItem {
  id: string
  name: string
  type: "file" | "dir"
  size?: number | null
  extension?: string | null
  compatibility?: MediaCompatibility
  /** A path under the library root (safe to display); never played, never sent as displayPath. */
  relativePath: string
  /** Ignored until the image proxy exists (phase 2). */
  posterId?: string | null
}

export interface MediaLibraryPage {
  libraryId: string
  currentPath: string
  breadcrumbs: MediaLibraryBreadcrumb[]
  hasMore: boolean
  nextCursor?: string | null
  items: MediaLibraryItem[]
  /** Cover of the directory itself, when it holds a poster file. */
  posterId?: string | null
}

/**
 * Same-origin address for one library image. The shell's asset server owns the fetch
 * (`/artwork/<kind>/<id>` → sidecar → backend with site credentials), so a card can use
 * a plain `<img>` under the renderer's `img-src 'self'` rule.
 */
export function artworkUrl(kind: "media" | "poster", id: string): string {
  return `${window.location.origin}/artwork/${kind}/${encodeURIComponent(id)}`
}

export type CatalogStatus = "unmatched" | "candidate" | "confirmed" | "rejected"

export interface CatalogCard {
  id: string
  title: string
  year: number | null
  kind: MediaLibraryKind
  status: CatalogStatus
  /** Path under `/api/media/posters/<id>`; null when no poster was cached. */
  posterUrl: string | null
  subtitle: string | null
}

export interface CatalogChild {
  mediaId: string
  name: string
  /** Optional scraped episode title. Older servers omit it. */
  episodeTitle?: string | null
  season: number | null
  episode: number | null
  /** 文件真正所在的子目录（相对库根）：番剧的 episode 几乎全是 null，分节只能靠它。 */
  relDir?: string | null
  /** 后端从文件名算出来的可播性；旧后端没有这个字段（缺字段 = 放行）。 */
  compatibility?: MediaCompatibility | null
}

/** 这个绑定是谁定的：机器、人，还是说不清。manual/rebind/unknown 都不再被自动流程改写。 */
export type CatalogConfirmedBy = "auto" | "manual" | "rebind" | "unknown"

export interface CatalogCandidate {
  id: string
  title: string
  year: number | null
  score: number
}

export interface CatalogDetail extends CatalogCard {
  /** 正式卡的身份键：与草稿行靠它对齐（§9）。 */
  itemKey?: string
  originalTitle: string | null
  overview: string | null
  candidates: CatalogCandidate[]
  children: CatalogChild[]
  confirmedBy?: CatalogConfirmedBy | null
}

export interface BangumiHit {
  externalDb: "bangumi" | "tmdb"
  externalId: string
  title: string
  originalTitle?: string | null
  year?: number | null
  episodes?: number | null
  imageUrl?: string | null
}

export interface CatalogRebindInput {
  externalDb: "bangumi" | "tmdb"
  externalId: string
  title: string
  year?: number | null
  overview?: string | null
  originalTitle?: string | null
  imageUrl?: string | null
}

export interface CatalogPage {
  items: CatalogCard[]
  hasMore: boolean
  nextCursor?: string | null
}

export interface ScrapeJob {
  libraryId: string
  status: "running" | "done" | "failed"
  total: number
  scanned: number
  matched: number
  lastError: string | null
}

export function catalogPage(input: { libraryId: string; cursor?: string; q?: string }): Promise<CatalogPage> {
  return mediaRequest<CatalogPage>("GET", "/api/media/catalog", {
    query: { libraryId: input.libraryId, cursor: input.cursor, q: input.q },
  })
}

export function catalogDetail(id: string, includeEpisodeTitles = true): Promise<CatalogDetail> {
  return mediaRequest<CatalogDetail>("GET", `/api/media/catalog/${encodeURIComponent(id)}`, {
    query: includeEpisodeTitles ? undefined : { episodeTitles: "0" },
  })
}

/** Confirming writes the chosen candidate as the item's title; the poster is cached server-side. */
export function catalogConfirm(id: string, candidateId: string): Promise<CatalogDetail> {
  return mediaRequest<CatalogDetail>("POST", `/api/media/catalog/${encodeURIComponent(id)}/confirm`, { body: { candidateId } })
}

export function catalogReject(id: string, candidateId: string): Promise<CatalogDetail> {
  return mediaRequest<CatalogDetail>("POST", `/api/media/catalog/${encodeURIComponent(id)}/reject`, { body: { candidateId } })
}

/** 撤销确认：绑定清空、标题回到解析名，文件一张不丢。 */
export function catalogUnconfirm(id: string): Promise<CatalogDetail> {
  return mediaRequest<CatalogDetail>("POST", `/api/media/catalog/${encodeURIComponent(id)}/unconfirm`)
}

/** 人工挑条目（刮削提不出正确条目时的出口）。 */
export function bangumiSearch(q: string): Promise<{ items: BangumiHit[] }> {
  return mediaRequest<{ items: BangumiHit[] }>("GET", "/api/media/bangumi/search", { query: { q } })
}

/** 直接绑一个条目，走 confirmed_by='rebind'，服务端顺带拉封面。 */
export function catalogRebind(id: string, input: CatalogRebindInput): Promise<CatalogDetail> {
  return mediaRequest<CatalogDetail>("POST", `/api/media/catalog/${encodeURIComponent(id)}/rebind`, { body: input })
}

export function libraryScrapeStatus(libraryId: string): Promise<ScrapeJob> {
  return mediaRequest<ScrapeJob>("GET", `/api/admin/media-libraries/${encodeURIComponent(libraryId)}/scrape`)
}

// ---- 草稿审阅与应用（第 4 块，2026-09-28） ----
// 链路 scan → classify → judge → apply：前三段只写 catalog_draft，正式卡一行不动；
// apply 是唯一落库动作。形状见 temp-html/library-catalog-draft-ui-handoff.md §2/§3。

export interface DraftCandidate {
  externalDb: string
  externalId: string
  title: string
  originalTitle: string | null
  year: number | null
  score: number
}

export interface DraftChild {
  mediaId: string
  name: string
  relativePath: string
  season: number | null
  episode: number | null
}

/** `draft[]` 的一项。列表投影**不含** children（§8.1：展开单张才走 `?item=` 子请求）。 */
export interface DraftItem {
  itemKey: string
  query: string
  rawName: string
  subtitle: string | null
  files: number
  rev: number
  status: CatalogStatus
  lookupState: "pending" | "done" | "error"
  title: string | null
  originalTitle: string | null
  year: number | null
  overview: string | null
  externalDb: string | null
  externalId: string | null
  confirmedBy: CatalogConfirmedBy | null
  posterUrl: string | null
  /** 列表投影不再带 candidates（后端 2026-09-28 把候选挪进 ?item=）；这两个扁平字段给表格排序用。 */
  candidateCount: number
  topScore: number | null
  /**
   * 这一张草稿当前**承接**谁的下发键位（§9 keep-binding）：null 表示「没有承接关系」，
   * 非空时值就是承接方的 itemKey。这是 apply 确认框下拉的**当前值**；
   * diff 里的 `keepsBindingOnKey` 是 apply 预览的推算结果，两者平时一致。
   */
  carriesKey: string | null
}

/** 展开单张：`GET .../classify?item=<itemKey>`。 */
export interface DraftCardDetail {
  libraryId: string
  card: DraftItem
  children: DraftChild[]
  /** 候选跟 children 一起从 ?item= 返回（顺序与分数即判定结果）。 */
  candidates: DraftCandidate[]
}

/** 差异项：added/dropped/moved 用 `files: number`；changed/confirmedDrift 用 `{from,to}`。 */
export interface DraftDiffItem {
  id: string
  itemKey: string
  title?: string
  query?: string
  files?: number | { from: number; to: number }
  fromKey?: string
  /** 劈卡：这张新卡从哪张正式卡接走文件、接走几个（权威字段，2026-09-28 §8.3）。 */
  splitFromKey?: string | null
  fromFiles?: number
}

/** changed 的形状与 confirmedDrift 不同：from/to 各自带 title 与 subtitle。 */
export interface DraftChangedItem {
  id: string
  itemKey: string
  from: { title: string; subtitle: string | null }
  to: { title: string; subtitle: string | null }
  /** 这张卡的文件被哪些草稿卡接走了（劈卡；空数组=没劈）。 */
  splitIntoKeys: string[]
  /** 应用后人的绑定跟着哪一份草稿走（含自己）。 */
  keepsBindingOnKey: string
}

export interface DraftDriftItem {
  id: string
  itemKey: string
  title: string
  subtitle: { from: string | null; to: string | null }
  files: { from: number; to: number }
  /** 这张卡的文件被哪些草稿卡接走了（劈卡；空数组=没劈）。 */
  splitIntoKeys: string[]
  /** 应用后人的绑定跟着哪一份草稿走（含自己；人合并过的卡重分类会拆成几份）。 */
  keepsBindingOnKey: string
}

export interface DraftDiff {
  added: DraftDiffItem[]
  dropped: DraftDiffItem[]
  moved: DraftDiffItem[]
  changed: DraftChangedItem[]
  confirmedDrift: DraftDriftItem[]
  unchanged: number
  autoConfirmed: number
  draftCards: number
  formalCards: number
}

/** 阈值由服务端下发（§8.5），界面不许硬编码。 */
export interface DraftThresholds {
  autoScore: number
  autoGap: number
  candidateScore: number
  variantCap: number
}

export interface DraftState {
  libraryId: string
  cards: number
  files: number
  pending: number
  classifiedAt: string | null
  thresholds: DraftThresholds | null
  scan: { files: number; enumeratedAt: string | null; rev: number } | null
  draft: DraftItem[]
  diff: DraftDiff | null
}

export interface DraftJudgeResult {
  libraryId: string
  kind: string
  judged: number
  confirmed: number
  pending: number
  /** 本批判定过的 itemKey（表格只刷这几行）。 */
  items: string[]
  diff: DraftDiff | null
}

export interface DraftApplyResult {
  libraryId: string
  cards: number
  created: number
  updated: number
  skipped: number
  deferred: number
  posters: number
  /** 本次按 keep-binding 搬走了几张绑定（§9）。 */
  transferred?: number
}

/** 409 的响应体带数据（§8.3）：弹窗直接拿这里的数字，不用猜。 */
export interface DraftErrorData {
  pending?: number
  draftCards?: number
  draftRev?: number
  scanRev?: number
}

/** 读回草稿 + 差异（审阅页的数据源）。没有草稿时服务端给 409 CATALOG_DRAFT_EMPTY。 */
export function mediaDraft(libraryId: string): Promise<DraftState> {
  return mediaRequest<DraftState>("GET", `/api/admin/media-libraries/${encodeURIComponent(libraryId)}/classify`)
}

/** 展开一张：children 走这条子请求（列表里已经没有 children 了）。未知 itemKey → 404。 */
export function mediaDraftCard(libraryId: string, itemKey: string): Promise<DraftCardDetail> {
  return mediaRequest<DraftCardDetail>("GET", `/api/admin/media-libraries/${encodeURIComponent(libraryId)}/classify`, { query: { item: itemKey } })
}

/** 重新分组落草稿。整批替换：已有判定会被清空。 */
export function mediaDraftClassify(libraryId: string): Promise<DraftState> {
  return mediaRequest<DraftState & { rev: number }>("POST", `/api/admin/media-libraries/${encodeURIComponent(libraryId)}/classify`)
}

/** 只判定草稿里 pending 的前 N 张（打条目站，匿名限速 ~60 req/min）。 */
export function mediaDraftJudge(libraryId: string, max: number): Promise<DraftJudgeResult> {
  return mediaRequest<DraftJudgeResult>("POST", `/api/admin/media-libraries/${encodeURIComponent(libraryId)}/judge`, { query: { max: String(max) } })
}

/** 唯一让草稿落到正式卡的步骤。force=1 才允许未判完就应用（代价见回执 §4）。 */
export function mediaDraftApply(libraryId: string, force = false): Promise<DraftApplyResult> {
  return mediaRequest<DraftApplyResult>("POST", `/api/admin/media-libraries/${encodeURIComponent(libraryId)}/apply`, { query: force ? { force: "1" } : undefined })
}

/** 只枚举片源存快照（rev+1），不分组、不判定、不动卡。 */
export function mediaLibraryScan(libraryId: string): Promise<{ libraryId: string; files: number; enumeratedAt: string; rev: number }> {
  return mediaRequest<{ libraryId: string; files: number; enumeratedAt: string; rev: number }>("POST", `/api/admin/media-libraries/${encodeURIComponent(libraryId)}/scan`)
}

export function startLibraryScrape(libraryId: string): Promise<ScrapeJob> {
  return mediaRequest<ScrapeJob>("POST", `/api/admin/media-libraries/${encodeURIComponent(libraryId)}/scrape`)
}

/** Raised for any non-2xx media answer. `code` is the server's own code when the body carries one. */
export class MediaRequestError extends Error {
  constructor(readonly code: string, readonly status: number, readonly data: unknown = null) {
    super(code)
    this.name = "MediaRequestError"
  }
}

/**
 * The one media call for the whole library surface. Routes and verbs are gated by the
 * sidecar's allow-list; this wrapper only carries status and body, so the server's error
 * codes survive to the UI. Never parses a human-readable message.
 */
export async function mediaRequest<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: { query?: Record<string, string | number | undefined | null>; body?: unknown } = {},
): Promise<T> {
  const query = new URLSearchParams(
    Object.entries(options.query ?? {})
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  ).toString()
  const reply = await invoke<{ status: number; body: string }>("mediaRequest", {
    method,
    path,
    query: query || null,
    body: options.body === undefined ? null : options.body,
  })
  const parsed = ((): unknown => {
    try { return reply.body ? JSON.parse(reply.body) : null } catch { return null }
  })()
  // 错误体一起带上：409 会带 pending / draftCards / draftRev / scanRev（§8.3）。
  if (reply.status < 200 || reply.status >= 300) throw new MediaRequestError(mediaErrorCode(parsed, reply.status), reply.status, parsed)
  return parsed as T
}

/** The body's own code wins; the status only fills in when the body has none. */
function mediaErrorCode(body: unknown, status: number): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>
    for (const key of ["error", "code"]) {
      const value = record[key]
      if (typeof value === "string" && value) return value
    }
  }
  if (status === 401) return "AUTH_REJECTED"
  if (status === 403) return "ADMIN_FORBIDDEN"
  if (status === 404) return "MEDIA_NOT_FOUND"
  return `MEDIA_HTTP_${status}`
}

export function mediaCapabilities(): Promise<MediaCapabilities> {
  return mediaRequest<MediaCapabilities>("GET", "/api/media/capabilities")
}

export function mediaLibraries(): Promise<MediaLibrary[]> {
  return mediaRequest<{ libraries?: MediaLibrary[] }>("GET", "/api/media/libraries").then(reply => reply.libraries ?? [])
}

/** Directory page for one library. `cursor` is the server's own decimal offset: round-trip it. */
export function mediaLibraryPage(input: { libraryId: string; path?: string; cursor?: string }): Promise<MediaLibraryPage> {
  return mediaRequest<MediaLibraryPage>("GET", "/api/media/list", {
    query: { libraryId: input.libraryId, path: input.path ?? "/", cursor: input.cursor },
  })
}

/** Filename search inside one library (title search arrives with the catalog in phase 3). */
export function mediaLibrarySearch(input: { libraryId: string; q: string; cursor?: string }): Promise<MediaLibraryPage> {
  return mediaRequest<MediaLibraryPage>("GET", "/api/media/search", {
    query: { libraryId: input.libraryId, q: input.q, cursor: input.cursor },
  })
}

export interface AdminMediaLibrary { id: string; name: string; kind: MediaLibraryKind; path: string }

/** Admin view of a source. The password never comes back — only whether one is set. */
export interface AdminMediaSource {
  id: string
  name: string
  internalBaseUrl: string
  publicBaseUrl: string
  username: string
  passwordSet: boolean
  libraries: AdminMediaLibrary[]
}

/**
 * Add a source. The body's password is write-only: the server stores it and returns
 * `passwordSet` instead. Loopback peers or the admin header are the only callers the
 * server accepts (`ADMIN_FORBIDDEN` otherwise).
 */
export function createMediaSource(input: {
  name: string
  internalBaseUrl: string
  publicBaseUrl: string
  username: string
  password: string
  libraries: Array<{ name: string; kind: MediaLibraryKind; path: string }>
}): Promise<AdminMediaSource> {
  return mediaRequest<AdminMediaSource>("POST", "/api/admin/media-sources", { body: input })
}

export function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return fallback
}

// ---- 草稿编辑（第 4 块扩成编辑机能；§9 的六个接口） ----
// 共同约定：只写草稿、身份用 itemKey、任何编辑置 confirmedBy=manual + lookupState=done、
// 重新 classify 会整体丢掉编辑。每次写返回同一份摘要，前端直接换本地状态。

/**
 * `DRAFT_EDIT_INVALID` 的 reason（§9）。`keepsBindingOnKey === itemKey` 是**复位**不是
 * 非法（后端 2026-09-28 的 `1c4c866c` 起的语义），所以 bad-carrier 只在不认识那个键时出现。
 */
export type DraftEditReason =
  | "no-candidate"
  | "unknown-candidate"
  | "nothing-to-split"
  | "bad-carrier"
  | "bad-keep-list"
  | "unknown-media"

/** 统一返回：与 classify 的摘要同形（`card` 是列表投影那一行）。 */
export interface DraftEditResult {
  libraryId: string
  card: DraftItem
  cards: number
  files: number
  pending: number
  diff: DraftDiff
  /** 仅 split：新建出来的草稿键。 */
  createdKeys?: string[]
}

export interface DraftEditInput {
  itemKey: string
  title?: string
  originalTitle?: string | null
  year?: number | null
  overview?: string | null
  posterUrl?: string | null
  externalDb?: "bangumi" | "tmdb" | null
  externalId?: string | null
}

/** 改草稿的展示/绑定字段（给了 externalId → confirmed，只改名 → candidate）。 */
export function mediaDraftEdit(input: { libraryId: string } & DraftEditInput): Promise<DraftEditResult> {
  return mediaRequest<DraftEditResult>("POST", `/api/admin/media-libraries/${encodeURIComponent(input.libraryId)}/draft/edit`, { body: input })
}

/** 人工确认（不传条目对 = 确认第一个候选；传了必须是该卡候选之一）。 */
export function mediaDraftConfirm(input: { libraryId: string; itemKey: string; externalDb?: string; externalId?: string }): Promise<DraftEditResult> {
  return mediaRequest<DraftEditResult>("POST", `/api/admin/media-libraries/${encodeURIComponent(input.libraryId)}/draft/confirm`, { body: input })
}

/** 撤销草稿上的人工决定：条目对与名字都留着，只退回 candidate。 */
export function mediaDraftUnconfirm(input: { libraryId: string; itemKey: string }): Promise<DraftEditResult> {
  return mediaRequest<DraftEditResult>("POST", `/api/admin/media-libraries/${encodeURIComponent(input.libraryId)}/draft/unconfirm`, { body: input })
}

/** 合并草稿卡；drop 行里有人工决定 → 400 DRAFT_EDIT_CONFLICT（带 keys）。 */
export function mediaDraftMerge(input: { libraryId: string; keepKey: string; dropKeys: string[] }): Promise<DraftEditResult> {
  return mediaRequest<DraftEditResult>("POST", `/api/admin/media-libraries/${encodeURIComponent(input.libraryId)}/draft/merge`, { body: input })
}

/** 拆分草稿卡：`keep` 是留在原卡的那批 mediaId，其余按父目录自动成新卡。 */
export function mediaDraftSplit(input: { libraryId: string; itemKey: string; keep: string[] }): Promise<DraftEditResult> {
  return mediaRequest<DraftEditResult>("POST", `/api/admin/media-libraries/${encodeURIComponent(input.libraryId)}/draft/split`, { body: input })
}

/** 绑定改由另一份草稿承接（apply 时才搬；目标卡已有人工答案会跳过；原卡变 unmatched）。 */
export function mediaDraftKeepBinding(input: { libraryId: string; itemKey: string; keepsBindingOnKey: string }): Promise<DraftEditResult> {
  return mediaRequest<DraftEditResult>("POST", `/api/admin/media-libraries/${encodeURIComponent(input.libraryId)}/draft/keep-binding`, { body: input })
}
