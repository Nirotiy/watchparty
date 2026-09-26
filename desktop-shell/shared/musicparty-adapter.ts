import type { DomainEvent, MediaItem, ProductId, PlaybackSnapshot, SharedCommandKind, SharedRoomState } from "./domain"
import type { AlbumPage, HistoryPage, MediaResolveResponse, MusicAlbum, MusicMetadata, PlaybackHistoryItem, PlayerStatePayload, QueuePatchPayload } from "./musicparty-contract"
import type { ProductAdapter } from "./adapter"
import type { RoomSummaryRecord } from "./lobby-contract"
import type { PlayerAdapter } from "./player"
import { DEFAULT_RETRY_POLICY, retryDelay } from "./retry"
import { MUSICPARTY_DESKTOP_API_VERSION, MUSICPARTY_MIN_CLIENT_VERSION } from "./musicparty-contract"
import { addClockSample, applyPlayerState, applyProgress, emptySharedRoomState } from "./shared-room-state"

export interface MusicPartyTransport {
  origin: string
  fetchImpl?: typeof fetch
  nativeInvoke?: MusicPartyInvoke
  clientVersion?: string
}

export interface MusicPartyAdapterOptions extends MusicPartyTransport {
  roomId?: string
  webSocketFactory?: (url: string) => WebSocket
  /** How long a welcome may stay silent before the adapter asks for the room snapshot itself. */
  firstSnapshotNudgeMs?: number
}

/**
 * Shorter than the lobby switch transaction's snapshot window, so the adapter reports the
 * failed join and rolls the room back before the caller's own timeout can fire.
 */
const ROOM_JOIN_SNAPSHOT_TIMEOUT_MS = 8000
const FIRST_SNAPSHOT_NUDGE_MS = 1200

export type MusicPartyProbeStatus = "ok" | "incompatible" | "unreachable"

/** The account behind the native cookie jar; the renderer never sees the token itself. */

/** 服务端的 ChatMessage 是 {id,userId,userName,content,timestamp,type}（store/sqlite/models.go）；
    早先这里读的是 author.name / createdAt，两个字段都不存在 → 所有发言都显示成「成员」、
    也没有时间分隔。旧形状一并兼容，避免回退到老服务端就哑掉。 */
type ChatMessagePayload = { id?: string; content?: string; userName?: string; timestamp?: number; createdAt?: string; author?: { name?: string } }
function chatAuthor(payload: ChatMessagePayload): string {
  const name = payload.userName ?? payload.author?.name
  return typeof name === "string" && name.trim() ? name.trim() : "成员"
}
function chatTimestamp(payload: ChatMessagePayload): string | undefined {
  if (typeof payload.timestamp === "number" && Number.isFinite(payload.timestamp)) return new Date(payload.timestamp).toISOString()
  return typeof payload.createdAt === "string" ? payload.createdAt : undefined
}


/** `history.page` 的每条：music 是 Music（元数据，没有 url），点歌者名字来自读取时的 LEFT JOIN。 */
function toPlaybackHistoryItem(value: unknown): PlaybackHistoryItem | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  const music = row.music && typeof row.music === "object" ? row.music as Record<string, unknown> : null
  if (typeof row.id !== "string" || !music || typeof music.id !== "string" || typeof music.name !== "string") return null
  return {
    id: row.id,
    music: {
      id: music.id,
      name: music.name,
      artists: Array.isArray(music.artists) ? music.artists.filter((artist): artist is string => typeof artist === "string") : [],
      duration: typeof music.duration === "number" ? music.duration : 0,
      // 服务端 Music.platform 是字符串；本地库还可能出现 "local" 这类值，原样带过来（点歌按钮会另行判断）。
      platform: (typeof music.platform === "string" ? music.platform : "") as MusicMetadata["platform"],
      coverUrl: typeof music.coverUrl === "string" ? music.coverUrl : "",
    },
    enqueuerPublicId: typeof row.enqueuerPublicId === "string" ? row.enqueuerPublicId : null,
    enqueuerName: typeof row.enqueuerName === "string" ? row.enqueuerName : null,
    playedAt: typeof row.playedAt === "number" ? row.playedAt : 0,
  }
}


/** 桌面搜索/专辑曲目共用的行映射：服务端字段可能是 name/artists/coverUrl 那套。 */
function toSearchResult(item: Record<string, unknown>, platform: string, index: number): MusicSearchResult {
  return {
    id: String(item.id ?? item.songId ?? `${platform}-${index}`),
    sourceId: String(item.id ?? item.songId ?? index),
    platform,
    title: String(item.name ?? item.title ?? "未命名歌曲"),
    artist: Array.isArray(item.artists) ? item.artists.filter((value): value is string => typeof value === "string").join(", ") : typeof item.artist === "string" ? item.artist : typeof item.artists === "string" ? item.artists : undefined,
    artworkUrl: typeof item.coverUrl === "string" ? item.coverUrl : typeof item.picUrl === "string" ? item.picUrl : typeof item.cover === "string" ? item.cover : undefined,
    durationSeconds: typeof item.duration === "number" ? item.duration / 1000 : undefined,
    kind: "audio" as const,
    source: platform,
  }
}

/** 专辑行：字段名以 §14.1 实测为准（artistName/coverUrl/id/name/platform/trackCount）。 */
function toMusicAlbum(value: unknown): MusicAlbum | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== "string" || typeof row.name !== "string") return null
  return {
    id: row.id,
    name: row.name,
    artistName: typeof row.artistName === "string" ? row.artistName : "",
    coverUrl: typeof row.coverUrl === "string" ? row.coverUrl : "",
    platform: typeof row.platform === "string" ? row.platform : "",
    trackCount: typeof row.trackCount === "number" ? row.trackCount : 0,
  }
}

export interface MusicPartyAccount {
  publicId: string
  displayName: string
  /** Platform administrators may manage any room, not only the ones they created. */
  isAdmin: boolean
  /** Guest sessions may listen along but must not create rooms (server gates this too). */
  isGuest: boolean
}

/**
 * What the Go side reports about itself in `GET /api/desktop/v1/readiness`
 * (readinessVersion = 1). Deliberately its own shape, not `DesktopReadinessReport`:
 * that one is the Node dialect (`components` = core/openlist/mediaRoots), and Go
 * answers with `core`/`neteaseApi`. Mounting the Node type here would silently read
 * `undefined` for every component and report a healthy server as unknown.
 *
 * Only `status` / `code` are kept. `message` is a localized string the server may
 * reword, so no caller is allowed to branch on it (backend handoff §9 invariant 3).
 */
export interface LinkleReadiness {
  /** Top level only: "ready" | "degraded". Component status is "up" | "down". */
  status: string
  /** `components.neteaseApi.status` — "up" | "down"; absent when the field is missing. */
  mediaSource: string | null
  /** `components.neteaseApi.code` — a transport code, never a provisioning one. */
  mediaSourceCode: string | null
  /** `diagnostics[].code`, in server order; [0] is the most actionable one. */
  diagnosticCodes: string[]
}

/** Unknown/absent readiness is "no information", never "degraded". */
export interface MusicPartyProbeOptions {
  /**
   * Ask for the readiness payload. Opt-in: the probe backs the lobby and the settings
   * page too, and those must not pay for (or depend on) an extra round trip.
   */
  readiness?: boolean
}

/** What a server advertises before any session exists; drives the S1 address gate. */
export interface MusicPartyProbe {
  status: MusicPartyProbeStatus
  origin: string
  expectedApiVersion: string
  clientVersion: string
  apiVersion?: string
  serverVersion?: string
  minimumClientVersion?: string
  providers: string[]
  features: Record<string, boolean>
  /** 哪些平台有专辑搜索（缺键=不点亮）。后端 §14.1：与网页的 supportsAlbumSearch 同源。 */
  albumSearchProviders: Record<string, boolean>
  account: MusicPartyAccount | null
  message: string
  /**
   * `undefined` = not asked for, `null` = asked and got nothing usable (old backend
   * without `features.readiness`, non-200, unparseable). `null` must not render as a
   * degraded server — the same three-state rule as `BanguruProbeState.readiness`.
   */
  readiness?: LinkleReadiness | null
}

const HEALTH_PATH = "/api/desktop/v1/health"
const CAPABILITIES_PATH = "/api/desktop/v1/capabilities"
const ACCOUNT_PATH = "/api/account/me"
const READINESS_PATH = "/api/desktop/v1/readiness"

export async function probeMusicParty(transport: MusicPartyTransport, options: MusicPartyProbeOptions = {}): Promise<MusicPartyProbe> {
  const origin = new URL(transport.origin.trim()).origin
  const clientVersion = transport.clientVersion ?? MUSICPARTY_MIN_CLIENT_VERSION
  const result = (status: MusicPartyProbeStatus, message: string, over: Partial<MusicPartyProbe> = {}): MusicPartyProbe =>
    ({ status, origin, expectedApiVersion: MUSICPARTY_DESKTOP_API_VERSION, clientVersion, providers: [], features: {}, albumSearchProviders: {}, account: null, message, ...over })
  const declared = (body: Record<string, unknown>) => ({
    apiVersion: typeof body.apiVersion === "string" ? body.apiVersion : undefined,
    serverVersion: typeof body.serverVersion === "string" ? body.serverVersion : undefined,
    minimumClientVersion: typeof body.minimumClientVersion === "string" ? body.minimumClientVersion : undefined,
  })
  // A 426 body is the only place the server states the version it wants, so read it
  // instead of reporting "unreachable" for what is really a version mismatch.
  const versionHint = (body: Record<string, unknown>) => result("incompatible",
    `服务版本不兼容：服务端要求 API ${body.apiVersion ?? "未知"}，客户端为 ${MUSICPARTY_DESKTOP_API_VERSION}`
    + (typeof body.minimumClientVersion === "string" ? `；最低客户端 ${body.minimumClientVersion}` : ""), declared(body))

  const health = await sendDesktopRequest(transport, HEALTH_PATH).then(readJson).catch(() => null)
  if (!health) return result("unreachable", "MusicParty 服务不可用，请检查服务地址与网络")
  if (health.status === 426) return versionHint(health.body)
  if (!health.ok) return result("unreachable", `MusicParty 服务不可用（HTTP ${health.status}）`, declared(health.body))

  const capabilities = await sendDesktopRequest(transport, CAPABILITIES_PATH).then(readJson).catch(() => null)
  if (!capabilities) return result("unreachable", "MusicParty 服务不可用，请检查服务地址与网络")
  if (capabilities.status === 426) return versionHint(capabilities.body)
  if (!capabilities.ok) return result("incompatible", `服务端未提供桌面能力信息（HTTP ${capabilities.status}）`, declared(capabilities.body))
  const fields = { ...declared(capabilities.body), providers: providerIds(capabilities.body.providers), features: featureFlags(capabilities.body.features), albumSearchProviders: featureFlags(capabilities.body.albumSearchProviders) }
  if (typeof capabilities.body.apiVersion !== "string") return result("incompatible", "服务端未声明桌面 API 版本，无法确认兼容", fields)
  if (capabilities.body.apiVersion !== MUSICPARTY_DESKTOP_API_VERSION) {
    return result("incompatible", `服务版本不兼容：服务端 API 为 ${capabilities.body.apiVersion}，客户端需要 ${MUSICPARTY_DESKTOP_API_VERSION}`, fields)
  }
  if (fields.minimumClientVersion && compareVersions(clientVersion, fields.minimumClientVersion) < 0) {
    return result("incompatible", `服务版本不兼容：服务端要求客户端最低版本 ${fields.minimumClientVersion}，当前 ${clientVersion}`, fields)
  }
  const account = await readAccount(transport)
  // Opt-in, and only when the server advertises the endpoint: an old backend must not be
  // probed for a route it does not serve. `undefined` (not asked for) and `null` (asked,
  // no usable answer) stay distinct so a caller can tell "unknown" from "absent".
  const readiness = options.readiness
    ? fields.features.readiness === true ? await readLinkleReadiness(transport) : null
    : undefined
  return result("ok", account ? `Linkle 服务可用，当前账号：${account.displayName || account.publicId}` : "Linkle 服务可用（本机尚未登录）", { ...fields, account, ...(readiness === undefined ? {} : { readiness }) })
}

/**
 * Reads the Go readiness payload. Any failure — non-200, no `components` object,
 * transport error — yields `null`: an unreachable probe is missing information, not a
 * degraded backend, and must never make the UI claim the media source is broken.
 */
async function readLinkleReadiness(transport: MusicPartyTransport): Promise<LinkleReadiness | null> {
  const response = await sendDesktopRequest(transport, READINESS_PATH).then(readJson).catch(() => null)
  // `readJson` turns unparseable JSON into `{}`, so an empty body is "could not parse",
  // not a readiness document. Missing information stays null.
  if (!response?.ok || Object.keys(response.body).length === 0) return null
  const components = asRecord(response.body.components)
  if (!components) return null
  const mediaSource = asRecord(components.neteaseApi)
  const diagnostics = Array.isArray(response.body.diagnostics) ? response.body.diagnostics : []
  return {
    status: typeof response.body.status === "string" ? response.body.status : "",
    mediaSource: mediaSource && typeof mediaSource.status === "string" ? mediaSource.status : null,
    mediaSourceCode: mediaSource && typeof mediaSource.code === "string" ? mediaSource.code : null,
    diagnosticCodes: diagnostics
      .map(asRecord)
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry.code === "string")
      .map(entry => entry.code as string),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * Which account the native credential jar resolves to. Deliberately silent on failure:
 * an expired session is a normal state here, not an error the UI must explain.
 */
async function readAccount(transport: MusicPartyTransport): Promise<MusicPartyAccount | null> {
  const response = await sendDesktopRequest(transport, ACCOUNT_PATH).catch(() => null)
  if (!response?.ok) return null
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (typeof body?.publicId !== "string" || !body.publicId) return null
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")
  // `isAdmin` is derived on the server (Session.MarshalJSON, same source as Session.Admin).
  // The role comparison below only covers servers built before that field shipped — drop it once
  // every deployment in use has been rebuilt.
  const role = body.role
  return {
    publicId: body.publicId,
    displayName: text(body.displayName) || text(body.username),
    isAdmin: body.isAdmin === true || role === "ADMIN" || role === "PLATFORM_ADMIN",
    isGuest: body.guest === true,
  }
}

function providerIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
  if (value && typeof value === "object") return Object.entries(value).filter(([, enabled]) => enabled === true).map(([id]) => id)
  return []
}

function featureFlags(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, enabled]) => typeof enabled === "boolean").map(([id, enabled]) => [id, enabled as boolean]))
}

async function readJson(response: Response): Promise<{ status: number; ok: boolean; body: Record<string, unknown> }> {
  const value: unknown = await response.json().catch(() => null)
  return { status: response.status, ok: response.ok, body: value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
}

async function sendDesktopRequest(transport: MusicPartyTransport, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set("Accept", "application/json")
  headers.set("X-Desktop-API-Version", MUSICPARTY_DESKTOP_API_VERSION)
  headers.set("X-Desktop-Client-Version", transport.clientVersion ?? MUSICPARTY_MIN_CLIENT_VERSION)
  if (init.body) headers.set("Content-Type", "application/json")
  // Explicit transport injection supports browser fixtures; production uses native IPC.
  if (transport.fetchImpl) return transport.fetchImpl(new URL(path, transport.origin), { ...init, headers })
  const invoke = transport.nativeInvoke ?? (await import("./desktop-runtime")).invoke
  const result = await invoke<{ status: number; body: string }>("musicPartyRequest", { input: {
    origin: transport.origin, path, method: init.method ?? "GET",
    body: typeof init.body === "string" ? JSON.parse(init.body) as unknown : null,
    clientVersion: transport.clientVersion ?? MUSICPARTY_MIN_CLIENT_VERSION,
  } })
  return new Response([204, 205, 304].includes(result.status) ? null : result.body, { status: result.status })
}

/** NetEase serves covers with a `param=WxH` variant switch; lists ask for a small one. */
function sizedArtworkUrl(url: string | undefined, size: "card" | "thumb"): string | null {
  const target = url?.trim()
  if (!target) return null
  if (size === "card") return target
  return target.replace(/([?&])param=\d+y\d+/, "$1param=96y96")
}

export type MusicPartyInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>

export interface MusicSearchResult extends MediaItem { platform: string; sourceId: string }
export interface LyricDetail { lyric: string; translatedLyric: string; romanizedLyric: string; wordLyric: string; wordTranslatedLyric: string; wordRomanizedLyric: string }
export interface InviteRedeemResult { roomId: string; roomName?: string }
export interface CreateMusicPartyRoomInput { name: string; isPrivate: boolean; password?: string }
export type RoomCreateErrorCode = "not-connected" | "in-progress" | "invalid-input" | "rejected" | "unauthorized" | "name-exists" | "unreachable" | "disconnected" | "timeout" | "invalid-response"
export class MusicPartyRoomCreateError extends Error {
  constructor(readonly code: RoomCreateErrorCode) { super(`room_create_${code}`); this.name = "MusicPartyRoomCreateError" }
}

export type RoomManageErrorCode = "invalid-input" | "unauthorized" | "forbidden" | "not-found" | "rejected" | "unreachable" | "invalid-response"
export class MusicPartyRoomManageError extends Error {
  constructor(readonly code: RoomManageErrorCode) { super(`room_manage_${code}`); this.name = "MusicPartyRoomManageError" }
}

export type ControlOutcome = "applied" | "noop" | "rejected" | "unknown"
export type ControlErrorCode = "not-connected" | "in-progress" | "invalid-input" | "not-ready" | "unsupported"
export class MusicPartyControlError extends Error {
  constructor(readonly code: ControlErrorCode) { super(`control_${code}`); this.name = "MusicPartyControlError" }
}

export type PlaylistScope = "user" | "room"
export interface PlaylistSummary { id: string; name: string; systemKey: string | null; trackCount: number; createdAt: number; updatedAt: number }
export interface PlaylistTrack { id: string; playlistId: string; music: MusicMetadata; sortOrder: number; createdAt: number }
export class MusicPartyPlaylistError extends Error {
  constructor(readonly code: string) { super(`playlist_${code}`); this.name = "MusicPartyPlaylistError" }
}

/** Transport boundary for MusicParty. UI never sees raw HTTP or socket envelopes. */
export class MusicPartyAdapter implements ProductAdapter {
  readonly product: ProductId = "musicparty"
  private readonly listeners = new Set<(event: DomainEvent) => void>()
  private socket: WebSocket | null = null
  private stopped = false
  private attempt = 0
  private snapshot: PlaybackSnapshot | null = null
  private sharedState: SharedRoomState | null = null
  private queue: MediaItem[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private helloTimer: ReturnType<typeof setTimeout> | undefined
  private snapshotNudge: ReturnType<typeof setTimeout> | undefined
  private pingTimer: ReturnType<typeof setTimeout> | undefined
  private readonly outstandingPings = new Map<string, number>()
  private welcomed = false
  private nativeActive = false
  private nativeGeneration = 0
  private readonly mutationWaiters = new Map<string, { resolve: (value: boolean) => void; reject: (error: Error) => void }>()
  private readonly playlistWaiters = new Map<string, (result: { ok: true; payload: unknown } | { ok: false; error: Error }) => void>()
  private loadingItemId: string | null = null
  private roomCreate: { resolve: (room: RoomSummaryRecord) => void; reject: (error: MusicPartyRoomCreateError) => void } | undefined
  private roomCreateUncertain = false
  private controlPending: { requestId: string; roomId: string; generation: number; kind: SharedCommandKind; ack?: { outcome: "applied" | "noop"; stateVersion: number; queueVersion: number; playEpoch: number }; finish: (outcome: ControlOutcome) => void } | null = null
  private controlIdempotency = false
  private controlPreconditions = false
  private probeResult: MusicPartyProbe | null = null
  private controlScope: { id: string; ttlMs: number } | null = null
  private lastResyncAtMs = 0
  private readonly artworkCache = new Map<string, string | null>()

  constructor(private readonly options: MusicPartyAdapterOptions) {
  }

  async connect(): Promise<void> {
    await this.disconnect()
    this.stopped = false
    this.attempt = 0
    this.controlIdempotency = false
    this.controlPreconditions = false
    this.emit({ type: "connection", status: "connecting" })
    const probe = await probeMusicParty(this.options).catch(() => null)
    if (!probe) { this.emit({ type: "connection", status: "failed", message: "MusicParty 服务不可用" }); return }
    if (probe.status !== "ok") { this.emit({ type: "connection", status: "failed", message: probe.message }); return }
    this.probeResult = probe
    this.controlIdempotency = probe.features.controlIdempotency === true
    this.controlPreconditions = probe.features.controlPreconditions === true
    // An empty roomId is not "no room" to the server: the desktop route defaults it to `lounge`
    // (`internal/httpapi/websocket.go:61-63`), so connecting without a room must not open a
    // socket at all — otherwise the client silently joins a room the user never picked.
    if (!this.options.roomId) { this.emit({ type: "connection", status: "ready" }); return }
    await this.openSocket()
  }

  /** Latest successful probe; null until the server has been verified reachable. */
  get desktopProbe(): MusicPartyProbe | null { return this.probeResult }

  /**
   * Cache the capability probe without opening a socket. Entries the server has not enabled
   * must be hidden before any room exists, and browsing the lobby is not a reason to connect.
   * `force` re-reads the account too: redeeming an invite is what turns an anonymous machine into
   * a session, and a stale `account` would keep a now-legal entry switched off.
   */
  async ensureProbe(force = false): Promise<MusicPartyProbe | null> {
    if (this.probeResult && !force) return this.probeResult
    const probe = await probeMusicParty(this.options)
    if (probe.status !== "ok") return this.probeResult ?? null
    this.probeResult = probe
    return probe
  }

  get roomId(): string | undefined { return this.options.roomId }
  get origin(): string { return new URL(this.options.origin).origin }

  /**
   * Album art lives on the platform CDN, which the renderer cannot reach (CSP) and
   * whose bytes it must not sample cross-origin (a tainted canvas throws). The main
   * process fetches the image and returns a data URL, which displays and samples.
   * `size: "thumb"` asks the CDN for a small variant, so a list of 30 results does
   * not pull 30 full-size covers.
   */
  async artwork(url: string | undefined, size: "card" | "thumb" = "card"): Promise<string | null> {
    const target = sizedArtworkUrl(url, size)
    if (!target) return null
    if (this.artworkCache.has(target)) return this.artworkCache.get(target) ?? null
    let dataUrl: string | null = null
    try {
      const invoke = this.options.nativeInvoke ?? (await import("./desktop-runtime")).invoke
      const reply = await invoke<{ dataUrl?: unknown }>("fetchArtworkImage", { url: target })
      if (typeof reply?.dataUrl === "string" && reply.dataUrl.startsWith("data:image/")) dataUrl = reply.dataUrl
    } catch { dataUrl = null }
    if (this.artworkCache.size >= 64) this.artworkCache.delete(this.artworkCache.keys().next().value as string)
    this.artworkCache.set(target, dataUrl)
    return dataUrl
  }

  async listRooms(): Promise<RoomSummaryRecord[]> {
    const response = await this.request("/api/rooms")
    const payload: unknown = await response.json()
    if (!Array.isArray(payload)) throw new Error("invalid_room_list")
    return payload.map(room => this.roomSummary(room))
  }

  private roomSummary(value: unknown): RoomSummaryRecord {
    if (!value || typeof value !== "object") throw new Error("invalid_room_summary")
    const room = value as Record<string, unknown>
    if (typeof room.roomId !== "string" || !room.roomId || typeof room.name !== "string" || typeof room.privateRoom !== "boolean") throw new Error("invalid_room_summary")
    const summary: RoomSummaryRecord = { service: "musicparty", origin: this.origin, roomId: room.roomId, name: room.name,
      visibility: room.privateRoom ? "private" : "public",
      memberCount: typeof room.onlineCount === "number" && Number.isInteger(room.onlineCount) && room.onlineCount >= 0 ? room.onlineCount : null,
      requiresPassword: room.privateRoom && room.accessGranted !== true }
    // Only present when the server names a creator; the lobby reads it to decide ownership.
    if (typeof room.creatorPublicId === "string" && room.creatorPublicId) summary.creatorPublicId = room.creatorPublicId
    return summary
  }

  /**
   * The protocol has no request ID, so only one WS create may be outstanding per connection.
   *
   * Servers that advertise `roomCreate` take the HTTP route: the WS command is gated on
   * platform admins, while the desktop endpoint only needs a session, so an ordinary signed-in
   * member can open a room. The endpoint also answers a private room with its own access proof
   * (a cookie the native jar keeps), which the WS reply never carries.
   */
  async createRoom(input: CreateMusicPartyRoomInput, timeoutMs = 10000): Promise<RoomSummaryRecord> {
    if (this.roomCreate || this.roomCreateUncertain) throw new MusicPartyRoomCreateError("in-progress")
    if (!input.name.trim() || (input.isPrivate && !input.password?.trim())) throw new MusicPartyRoomCreateError("invalid-input")
    if (this.probeResult?.features.roomCreate === true) return this.createRoomOverHttp(input)
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.roomCreate = undefined }
      const timer = setTimeout(() => { this.roomCreateUncertain = true; this.roomCreate?.reject(new MusicPartyRoomCreateError("timeout")) }, timeoutMs)
      this.roomCreate = { resolve: room => { finish(); resolve(room) }, reject: error => { finish(); reject(error) } }
      if (!this.sendCommand({ type: "rooms.create", payload: { name: input.name.trim(), isPrivate: input.isPrivate, password: input.password ?? "" } })) this.roomCreate.reject(new MusicPartyRoomCreateError("not-connected"))
    })
  }

  /**
   * Deliberately bypasses `request()` so a failed create emits nothing: the lobby already
   * explains the attempt, and a 409 on a duplicate room name is not a session problem.
   */
  private async createRoomOverHttp(input: CreateMusicPartyRoomInput): Promise<RoomSummaryRecord> {
    const response = await sendDesktopRequest(this.options, "/api/desktop/v1/rooms", {
      method: "POST",
      body: JSON.stringify({ name: input.name.trim(), isPrivate: input.isPrivate, password: input.password ?? "" }),
    }).catch(() => null)
    if (!response) throw new MusicPartyRoomCreateError("unreachable")
    if (!response.ok) {
      const code: RoomCreateErrorCode = response.status === 400 ? "invalid-input" : response.status === 401 ? "unauthorized" : response.status === 409 ? "name-exists" : "rejected"
      throw new MusicPartyRoomCreateError(code)
    }
    const payload: unknown = await response.json().catch(() => null)
    try { return this.roomSummary(payload) }
    catch { throw new MusicPartyRoomCreateError("invalid-response") }
  }

  /**
   * A rename must echo the room's current privacy: the server reads an omitted `isPrivate` as a
   * request to go public, which would silently drop a private room's password.
   */
  async renameRoom(roomId: string, name: string, isPrivate: boolean): Promise<RoomSummaryRecord> {
    const trimmed = name.trim()
    if (!roomId || !trimmed) throw new MusicPartyRoomManageError("invalid-input")
    const response = await sendDesktopRequest(this.options, `/api/rooms/${encodeURIComponent(roomId)}`, {
      method: "PUT", body: JSON.stringify({ name: trimmed, isPrivate, keepExistingPassword: true }),
    }).catch(() => null)
    if (!response) throw new MusicPartyRoomManageError("unreachable")
    if (!response.ok) throw new MusicPartyRoomManageError(this.roomManageError(response.status))
    const payload: unknown = await response.json().catch(() => null)
    try { return this.roomSummary(payload) }
    catch { throw new MusicPartyRoomManageError("invalid-response") }
  }

  async deleteRoom(roomId: string): Promise<void> {
    if (!roomId) throw new MusicPartyRoomManageError("invalid-input")
    const response = await sendDesktopRequest(this.options, `/api/rooms/${encodeURIComponent(roomId)}`, { method: "DELETE" }).catch(() => null)
    if (!response) throw new MusicPartyRoomManageError("unreachable")
    if (!response.ok) throw new MusicPartyRoomManageError(this.roomManageError(response.status))
  }

  /** The server distinguishes "not your room" from "no session"; the lobby copy follows that. */
  private roomManageError(status: number): RoomManageErrorCode {
    return status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not-found" : status === 400 ? "invalid-input" : "rejected"
  }

  async verifyRoomAccess(roomId: string, password: string): Promise<void> {
    await this.request(`/api/rooms/${encodeURIComponent(roomId)}/verify`, { method: "POST", body: JSON.stringify({ password }) })
  }

  async disconnect(): Promise<void> {
    const generation = ++this.nativeGeneration
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.helloTimer)
    clearTimeout(this.snapshotNudge)
    this.stopClockSync()
    this.socket?.close()
    this.socket = null
    if (this.options.nativeInvoke && this.nativeActive) { this.nativeActive = false; await this.options.nativeInvoke<void>("musicPartyWsDisconnect", {}).catch(() => undefined) }
    this.controlPending?.finish("unknown")
    this.emit({ type: "connection", status: "idle" })
  }

  async redeemInvite(code: string, options?: { join?: boolean; displayName?: string }): Promise<InviteRedeemResult> {
    // 建号时把名字报上去（用户 2026-09-25：自定义 ID 写进服务端，之后以服务端为基准）；
    // 调用方没给就沿用「桌面用户」，老行为不变。
    const response = await this.request("/api/desktop/v1/invites/redeem", { method: "POST", body: JSON.stringify({ code, displayName: options?.displayName?.trim() || "桌面用户" }) })
    const result = await response.json() as { roomId?: string; roomName?: string }
    if (!result.roomId) throw new Error("invite_room_missing")
    if (options?.join !== false) await this.joinRoom(result.roomId)
    return { roomId: result.roomId, roomName: result.roomName }
  }

  /**
   * A join commits on this room's first snapshot, not on the socket opening: the server accepts
   * the connection before its room runtime has anything to show. Until then the adapter is still
   * in its previous room, so a failed join cannot leave a room id behind for a later switch to
   * re-enter.
   */
  async joinRoom(roomId: string, timeoutMs = ROOM_JOIN_SNAPSHOT_TIMEOUT_MS): Promise<void> {
    const previous = this.options.roomId
    this.options.roomId = roomId
    const committed = this.awaitFirstSnapshot(roomId, timeoutMs)
    try {
      await this.connect()
      await committed.promise
    } catch (error) {
      committed.cancel()
      this.options.roomId = previous
      throw error
    }
  }

  private awaitFirstSnapshot(roomId: string, timeoutMs: number): { promise: Promise<void>; cancel: () => void } {
    let settle: (error?: Error) => void = () => {}
    const promise = new Promise<void>((resolve, reject) => {
      let done = false
      let connecting = false
      const finish = (error?: Error) => {
        if (done) return
        done = true
        clearTimeout(timer)
        unsubscribe()
        if (error) reject(error); else resolve()
      }
      settle = finish
      const timer = setTimeout(() => finish(new Error("room_snapshot_timeout")), timeoutMs)
      const unsubscribe = this.subscribe(event => {
        if (event.type === "connection") {
          // connect() disconnects first, so only a stop after connecting abandoned this join.
          if (event.status === "connecting") connecting = true
          else if (connecting && (event.status === "failed" || event.status === "idle")) finish(new Error("room_join_failed"))
          return
        }
        if (event.type === "room" && event.room.id === roomId) finish()
      })
    })
    return { promise, cancel: () => settle() }
  }

  async listPlatforms(roomId?: string): Promise<Array<{ id: string; name: string }>> {
    const response = await this.request("/api/desktop/v1/capabilities")
    if (!response.ok) throw new Error(`platforms_failed:${response.status}`)
    const payload = await response.json() as { providers?: Record<string, unknown> | string[] }
    const providers = Array.isArray(payload.providers) ? payload.providers : Object.keys(payload.providers ?? {})
    return providers.map((id) => ({ id, name: id }))
  }

  /** 专辑搜索（§14.1）：`{items,total,offset,limit}`；total===0 表示平台不提供总数。 */
  async searchAlbums(platform: string, keyword: string, options: { roomId?: string; offset?: number; limit?: number } = {}): Promise<AlbumPage> {
    const { roomId, offset = 0, limit = 20 } = options
    const query = new URLSearchParams({ q: keyword, offset: String(offset), limit: String(limit) })
    if (roomId) query.set("roomId", roomId)
    const response = await this.request(`/api/desktop/v1/albums/${encodeURIComponent(platform)}?${query}`)
    if (!response.ok) throw new Error(`album_search_failed:${response.status}`)
    const payload = await response.json() as { items?: unknown; total?: unknown; offset?: unknown; limit?: unknown }
    const items = Array.isArray(payload.items) ? payload.items.map(toMusicAlbum).filter((item): item is MusicAlbum => item !== null) : []
    return {
      items,
      total: typeof payload.total === "number" ? payload.total : 0,
      offset: typeof payload.offset === "number" ? payload.offset : offset,
      limit: typeof payload.limit === "number" ? payload.limit : limit,
    }
  }

  /** 专辑曲目：§14.1 定死不分页（total === items.length），所以不发 offset。 */
  async albumSongs(platform: string, albumId: string): Promise<MusicSearchResult[]> {
    const response = await this.request(`/api/desktop/v1/albums/${encodeURIComponent(platform)}/${encodeURIComponent(albumId)}/songs`)
    if (!response.ok) throw new Error(`album_songs_failed:${response.status}`)
    const payload = await response.json() as { items?: unknown }
    const items = Array.isArray(payload.items) ? payload.items : []
    return items.map((entry, index) => toSearchResult(entry as Record<string, unknown>, platform, index))
  }

  /** 整张专辑入队：WS `enqueue.album`（与网页共用 dispatcher），按 mutationId 关联 ack/nack。 */
  async enqueueAlbum(platform: string, albumId: string, timeoutMs = 10000): Promise<boolean> {
    const mutationId = crypto.randomUUID()
    return new Promise<boolean>(resolve => {
      const finish = (accepted: boolean) => { clearTimeout(timer); this.mutationWaiters.delete(mutationId); resolve(accepted) }
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.mutationWaiters.set(mutationId, { resolve: () => finish(true), reject: () => finish(false) })
      if (!this.sendCommand({ type: "enqueue.album", roomId: this.options.roomId, payload: { platform, albumId, mutationId } })) finish(false)
    })
  }

  /**
   * 搜索。分页是服务端本来就支持的（`offset` 0–10000、`limit` 1–100），只是以前写死 0/20；
   * 响应只有 `{items, offset, limit}`，**没有 total/hasMore**，所以"还有下一页"按网页端的
   * 启发式判断：返回条数 == limit 就认为还有（`searchHasMore`）。
   */
  async search(platform: string, keyword: string, options: { roomId?: string; offset?: number; limit?: number } | string = {}): Promise<MusicSearchResult[]> {
    const { roomId, offset = 0, limit = 20 } = typeof options === "string" ? { roomId: options } : options
    const query = new URLSearchParams({ q: keyword, offset: String(offset), limit: String(limit) })
    if (roomId) query.set("roomId", roomId)
    const response = await this.request(`/api/desktop/v1/search/${encodeURIComponent(platform)}?${query}`)
    if (!response.ok) throw new Error(`search_failed:${response.status}`)
    const payload = await response.json() as { items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
    const results = Array.isArray(payload) ? payload : (payload.items ?? [])
    return results.map((item, index) => toSearchResult(item, platform, index))
  }

  /**
   * The `/media/` route returns the full lyric object (translation, romanization,
   * word-level YRC); `/music/` is the plain-LRC compatibility route. Translation
   * needs the former, but a sidecar that predates its allow-list entry rejects it
   * with `invalid_musicparty_request`, so fall back instead of losing lyrics.
   */
  async lyrics(platform: string, songId: string): Promise<LyricDetail> {
    const segment = `${encodeURIComponent(platform)}/${encodeURIComponent(songId)}`
    try {
      const detail = await this.request(`/api/desktop/v1/media/${segment}/lyrics`)
      if (detail.ok) {
        const payload = await detail.json() as Partial<Record<keyof LyricDetail, unknown>>
        if (typeof payload.lyric === "string") {
          const text = (key: keyof LyricDetail) => (typeof payload[key] === "string" ? payload[key] as string : "")
          return { lyric: payload.lyric, translatedLyric: text("translatedLyric"), romanizedLyric: text("romanizedLyric"), wordLyric: text("wordLyric"), wordTranslatedLyric: text("wordTranslatedLyric"), wordRomanizedLyric: text("wordRomanizedLyric") }
        }
      }
    } catch { /* an unreachable or unexpected detail route must not cost us the plain lyric */ }
    const response = await this.request(`/api/desktop/v1/music/${segment}/lyrics`)
    if (!response.ok) throw new Error(`lyrics_failed:${response.status}`)
    return { lyric: await response.text(), translatedLyric: "", romanizedLyric: "", wordLyric: "", wordTranslatedLyric: "", wordRomanizedLyric: "" }
  }

  async resolveMedia(platform: string, songId: string): Promise<MediaResolveResponse> {
    const response = await this.request(`/api/desktop/v1/media/${encodeURIComponent(platform)}/${encodeURIComponent(songId)}/resolve`)
    if (!response.ok) throw new Error(`media_resolve_failed:${response.status}`)
    const payload = await response.json() as MediaResolveResponse
    const url = payload.url
    if (typeof url !== "string" || !url) throw new Error("media_resolve_empty")
    return payload
  }

  async resolveMediaUrl(platform: string, songId: string): Promise<string> {
    return (await this.resolveMedia(platform, songId)).url
  }

  async loadForPlayer(player: PlayerAdapter, item: MusicSearchResult): Promise<void> {
    const resolved = await this.resolveMedia(item.platform, item.sourceId)
    await player.load(normalizeMusic(resolved.music), new URL(resolved.url, this.options.origin).href)
  }

  bindPlayer(player: PlayerAdapter, onLoaded?: () => Promise<unknown>): () => void {
    let active = true
    let latest = this.snapshot
    let target = ""
    let loaded = ""
    let failedTarget = ""
    let generation = 0
    let pending = Promise.resolve()
    const fail = () => this.emit({ type: "error", code: "playback-failed", message: "媒体解析或播放失败" })
    const stopAfterFailure = (key: string) => {
      if (!active) return
      failedTarget = key
      target = loaded = ""
      ++generation
      pending = pending.then(async () => { if (active) await player.stop() }).catch(() => {})
      fail()
    }
    const run = (work: () => Promise<void>, failureKey = "") => {
      pending = pending.then(work).catch(() => { if (active) stopAfterFailure(failureKey || target) })
    }
    const update = (snapshot: PlaybackSnapshot) => {
      latest = snapshot
      const item = snapshot.item
      const key = item ? JSON.stringify([item.source, item.id, snapshot.playEpoch]) : ""
      if (key && key === failedTarget) return
      if (key === target) {
        if (loaded === key) run(async () => { if (active && latest === snapshot) await player.applySnapshot(snapshot) })
        return
      }
      target = key
      loaded = ""
      failedTarget = ""
      const token = ++generation
      run(async () => { if (active && token === generation) await player.stop() }, key)
      if (!item) return
      void this.resolveMedia(item.source ?? "", item.id).then(resolved => {
        run(async () => {
          if (!active || token !== generation) return
          await player.load(item, new URL(resolved.url, this.options.origin).href)
          if (!active || token !== generation) return
          loaded = key
          if (latest) await player.applySnapshot(latest)
          if (!active || token !== generation) return
          await onLoaded?.()
          if (!active || token !== generation) return
          // Focus may await native work. Reapply the authoritative state after it settles.
          if (latest) await player.applySnapshot(latest)
        }, key)
      }).catch(() => { if (active && token === generation) stopAfterFailure(key) })
    }
    const unsubscribe = this.subscribe(event => {
      if (event.type === "playback") update(event.snapshot)
      if (event.type === "error" && event.code === "media-failed") stopAfterFailure(target)
      if (event.type === "connection" && event.status !== "ready") {
        ++generation; target = loaded = ""; failedTarget = ""; latest = null
        run(async () => { if (active) await player.stop() })
      }
    })
    if (latest) update(latest)
    return () => { active = false; ++generation; unsubscribe(); void player.stop().catch(() => {}) }
  }


  async enqueue(platform: string, musicId: string): Promise<boolean> {
    const mutationId = crypto.randomUUID()
    return new Promise<boolean>(resolve => {
      const finish = (accepted: boolean) => { clearTimeout(timer); this.mutationWaiters.delete(mutationId); resolve(accepted) }
      const timer = setTimeout(() => finish(false), 10000)
      this.mutationWaiters.set(mutationId, { resolve: finish, reject: () => finish(false) })
      if (!this.sendCommand({ type: "enqueue", roomId: this.options.roomId, payload: { platform, musicId, mutationId } })) finish(false)
    })
  }

  /**
   * Shared playback control per the contract: control.* with a correlated requestId.
   * One command in flight at a time; a timed-out command is never resent — the
   * projection plus a throttled resync reconcile the room instead.
   */
  sendControl(kind: SharedCommandKind, payload: { positionMs?: number } = {}, timeoutMs = 2000): Promise<ControlOutcome> {
    if (this.controlPending) return Promise.reject(new MusicPartyControlError("in-progress"))
    if (this.stopped || !this.welcomed) return Promise.reject(new MusicPartyControlError("not-connected"))
    if (this.controlIdempotency && !this.controlScope) return Promise.reject(new MusicPartyControlError("not-ready"))
    // like/unlike 都是「针对当前曲目」的动作（unlike 见 handoff §15.1）：没有当前曲目就不发。
    if (kind === "seek" || kind === "like" || kind === "unlike" || kind === "previous") {
      if (!this.controlPreconditions) return Promise.reject(new MusicPartyControlError("unsupported"))
      if (!this.sharedState?.item) return Promise.reject(new MusicPartyControlError("invalid-input"))
    }
    let wirePayload: Record<string, unknown> = {}
    if (kind === "seek") {
      if (typeof payload.positionMs !== "number" || !Number.isFinite(payload.positionMs)) return Promise.reject(new MusicPartyControlError("invalid-input"))
      const durationMs = this.sharedState?.durationMs ?? 0
      const upper = durationMs > 0 ? durationMs : Number.MAX_SAFE_INTEGER
      wirePayload = { positionMs: Math.min(Math.max(Math.round(payload.positionMs), 0), upper) }
    } else if ((kind === "like" || kind === "unlike") && !this.sharedState?.item) {
      return Promise.reject(new MusicPartyControlError("invalid-input"))
    }
    const type = kind === "play" || kind === "pause" ? "control.toggle-pause" : kind === "shuffle" ? "control.toggle-shuffle" : `control.${kind}`
    if ((kind === "seek" || kind === "like" || kind === "unlike" || kind === "previous") && this.sharedState) wirePayload.expectedPlayEpoch = this.sharedState.playEpoch
    const requestId = crypto.randomUUID()
    const roomId = this.options.roomId ?? ""
    return new Promise((resolve, reject) => {
      if (this.controlIdempotency && this.controlScope) wirePayload = { ...wirePayload, mutationId: crypto.randomUUID(), idempotencyScopeId: this.controlScope.id }
      const finish = (outcome: ControlOutcome) => {
        if (this.controlPending?.requestId !== requestId) return
        clearTimeout(timer)
        this.controlPending = null
        this.emit({ type: "command-pending", roomId, requestId, kind, pending: false })
        resolve(outcome)
      }
      const timer = setTimeout(() => {
        if (this.controlPending?.requestId !== requestId) return
        finish("unknown")
        this.requestResync()
      }, timeoutMs)
      this.controlPending = { requestId, roomId, generation: this.nativeGeneration, kind, finish }
      this.emit({ type: "command-pending", roomId: this.options.roomId ?? "", requestId, kind, pending: true })
      if (!this.sendCommand({ type, requestId, roomId: this.options.roomId, payload: wirePayload })) {
        clearTimeout(timer)
        this.controlPending = null
        this.emit({ type: "command-pending", roomId: this.options.roomId ?? "", requestId, kind, pending: false })
        reject(new MusicPartyControlError("not-connected"))
      }
    })
  }

  sendChat(content: string): boolean {
    return !!content.trim() && this.sendCommand({ type: "chat.message", roomId: this.options.roomId, payload: { content: content.trim() } })
  }

  sendChatHistoryFetch(limit = 50, offset = 0): boolean {
    return this.sendCommand({ type: "chat.history.fetch", roomId: this.options.roomId, payload: { limit, offset } })
  }

  sendQueueMutation(kind: "queue.top" | "queue.remove", queueId: string): boolean {
    return !!queueId && this.sendCommand({ type: kind, roomId: this.options.roomId, payload: { queueId, mutationId: crypto.randomUUID() } })
  }

  reorderQueue(queueId: string, targetQueueId: string, position: "before" | "after" = "before"): boolean {
    return this.sendCommand({ type: "queue.reorder", roomId: this.options.roomId, payload: { queueId, targetQueueId, position, mutationId: crypto.randomUUID() } })
  }

  /** Clears the whole shared queue; resolves false when the mutation is not confirmed in time. */
  clearQueue(timeoutMs = 10000): Promise<boolean> {
    const mutationId = crypto.randomUUID()
    return new Promise<boolean>(resolve => {
      const finish = (accepted: boolean) => { clearTimeout(timer); this.mutationWaiters.delete(mutationId); resolve(accepted) }
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.mutationWaiters.set(mutationId, { resolve: () => finish(true), reject: () => finish(false) })
      if (!this.sendCommand({ type: "queue.clear", roomId: this.options.roomId, payload: { mutationId } })) finish(false)
    })
  }

  private settlePlaylist(requestId: string | undefined, result: { ok: true; payload: unknown } | { ok: false; error: Error }): void {
    const settle = this.playlistWaiters.get(requestId ?? "")
    if (settle) { this.playlistWaiters.delete(requestId ?? ""); settle(result) }
  }

  /** Playlist commands are request-ID correlated; the server answers exactly once per command. */
  private playlistRequest<T>(type: string, payload: Record<string, unknown>, timeoutMs = 10000): Promise<T> {
    if (this.stopped || !this.welcomed) return Promise.reject(new MusicPartyPlaylistError("NOT_CONNECTED"))
    const requestId = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.playlistWaiters.delete(requestId); reject(new MusicPartyPlaylistError("TIMEOUT")) }, timeoutMs)
      this.playlistWaiters.set(requestId, result => {
        clearTimeout(timer)
        if (result.ok) resolve(result.payload as T); else reject(result.error)
      })
      if (!this.sendCommand({ type, requestId, roomId: this.options.roomId, payload })) {
        clearTimeout(timer)
        this.playlistWaiters.delete(requestId)
        reject(new MusicPartyPlaylistError("NOT_CONNECTED"))
      }
    })
  }

  /** 房间播放历史。服务端这条**不回 requestId**（`client.Send("history.page", roomId, page)`），
      所以按响应类型单飞匹配：同一时刻只允许一个在途请求，新的请求会先把旧的判超时。 */
  private historyWaiter: { resolve: (page: HistoryPage) => void; reject: (error: Error) => void } | null = null
  async listHistory(range: { offset?: number; limit?: number } = {}): Promise<HistoryPage> {
    const offset = Math.max(0, Math.trunc(range.offset ?? 0))
    const limit = Math.min(200, Math.max(1, Math.trunc(range.limit ?? 50)))
    return new Promise<HistoryPage>((resolve, reject) => {
      this.historyWaiter?.reject(new MusicPartyPlaylistError("TIMEOUT"))
      const timer = setTimeout(() => { if (this.historyWaiter) { this.historyWaiter = null; reject(new MusicPartyPlaylistError("TIMEOUT")) } }, 10000)
      this.historyWaiter = {
        resolve: page => { clearTimeout(timer); this.historyWaiter = null; resolve(page) },
        reject: error => { clearTimeout(timer); this.historyWaiter = null; reject(error) },
      }
      if (!this.sendCommand({ type: "history.list", roomId: this.options.roomId, payload: { offset, limit } })) {
        clearTimeout(timer); this.historyWaiter = null
        reject(new MusicPartyPlaylistError("DISCONNECTED"))
      }
    })
  }

  async listPlaylists(scope: PlaylistScope): Promise<PlaylistSummary[]> {
    const payload = await this.playlistRequest<{ playlists?: unknown }>("playlist.list", { scope })
    if (!Array.isArray(payload.playlists)) throw new MusicPartyPlaylistError("INVALID_RESPONSE")
    return payload.playlists.map(toPlaylistSummary)
  }

  async getPlaylistTracks(scope: PlaylistScope, playlistId: string, range: { offset?: number; limit?: number } = {}): Promise<PlaylistTrack[]> {
    const payload = await this.playlistRequest<{ tracks?: unknown }>("playlist.get", { scope, playlistId, ...range })
    if (!Array.isArray(payload.tracks)) throw new MusicPartyPlaylistError("INVALID_RESPONSE")
    return payload.tracks.map(toPlaylistTrack)
  }

  async createPlaylist(scope: PlaylistScope, name: string): Promise<PlaylistSummary> {
    const payload = await this.playlistRequest<{ playlist?: unknown }>("playlist.create", { scope, name, mutationId: crypto.randomUUID() })
    return toPlaylistSummary(payload.playlist)
  }

  async renamePlaylist(scope: PlaylistScope, playlistId: string, name: string): Promise<PlaylistSummary> {
    const payload = await this.playlistRequest<{ playlist?: unknown }>("playlist.rename", { scope, playlistId, name, mutationId: crypto.randomUUID() })
    return toPlaylistSummary(payload.playlist)
  }

  async deletePlaylist(scope: PlaylistScope, playlistId: string): Promise<void> {
    await this.playlistRequest("playlist.delete", { scope, playlistId, mutationId: crypto.randomUUID() })
  }

  async addPlaylistItems(scope: PlaylistScope, playlistId: string, items: MusicMetadata[]): Promise<{ addedCount: number; skippedCount: number }> {
    if (items.length === 0 || items.length > 200) throw new MusicPartyPlaylistError("PAYLOAD_INVALID")
    const payload = await this.playlistRequest<{ addedCount?: unknown; skippedCount?: unknown }>("playlist.add-items", { scope, playlistId, items, mutationId: crypto.randomUUID() })
    return { addedCount: typeof payload.addedCount === "number" ? payload.addedCount : 0, skippedCount: typeof payload.skippedCount === "number" ? payload.skippedCount : 0 }
  }

  async removePlaylistTracks(scope: PlaylistScope, playlistId: string, trackIds: string[]): Promise<number> {
    if (trackIds.length === 0 || trackIds.length > 200) throw new MusicPartyPlaylistError("PAYLOAD_INVALID")
    const payload = await this.playlistRequest<{ removedCount?: unknown }>("playlist.remove-items", { scope, playlistId, trackIds, mutationId: crypto.randomUUID() })
    return typeof payload.removedCount === "number" ? payload.removedCount : 0
  }

  async enqueuePlaylist(scope: PlaylistScope, playlistId: string): Promise<number> {
    const payload = await this.playlistRequest<{ count?: unknown }>("playlist.enqueue", { scope, playlistId, mutationId: crypto.randomUUID() })
    return typeof payload.count === "number" ? payload.count : 0
  }

  subscribe(listener: (event: DomainEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await sendDesktopRequest(this.options, path, init)
    if (!response.ok) {
      const code = response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : response.status === 502 ? "media-failed" : response.status === 426 ? "version-incompatible" : "http-error"
      const detail = await safeHttpErrorDetail(response)
      this.emit({ type: "error", code, message: detail ?? code })
      throw new MusicPartyHttpError(code, response.status, detail)
    }
    return response
  }

  /**
   * Revoke the session on the server, then always drop the local credentials. An
   * unreachable server must not leave a session cookie on this machine, and an already
   * expired session is not a failure worth a toast, so this bypasses the error events.
   */
  async logout(): Promise<void> {
    try { await sendDesktopRequest(this.options, "/api/account/logout", { method: "POST" }) } catch { /* the local clear below is what the user asked for */ }
    await this.clearSession()
  }

  async clearSession(): Promise<void> {
    await this.disconnect()
    const invoke = this.options.nativeInvoke ?? (await import("./desktop-runtime")).invoke
    await invoke<void>("clearMusicPartySession", { origin: this.options.origin })
    this.snapshot = null
    this.queue = []
    // The cached probe describes a session that no longer exists; keeping it would leave the
    // lobby offering 创建房间 with an account this machine cannot authenticate as (401).
    this.probeResult = null
  }

  private async openSocket(): Promise<void> {
    if (this.stopped) return
    if (!this.options.webSocketFactory) { if (!this.options.nativeInvoke) (this.options as MusicPartyAdapterOptions).nativeInvoke = (await import("./desktop-runtime")).invoke as MusicPartyInvoke; await this.openNative(); return }
    const factory = this.options.webSocketFactory ?? ((url: string) => new WebSocket(url))
    const url = new URL("/api/desktop/v1/ws", this.options.origin.replace(/^http/, "ws"))
    if (this.options.roomId) url.searchParams.set("roomId", this.options.roomId)
    const socket = factory(url.toString())
    const generation = ++this.nativeGeneration
    this.snapshot = null
    this.queue = []
    this.socket = socket
    this.welcomed = false
    clearTimeout(this.helloTimer)
    this.helloTimer = setTimeout(() => { if (this.socket === socket && !this.welcomed) socket.close() }, 5000)
    socket.onopen = () => { this.attempt = 0; socket.send(JSON.stringify({ type: "client.hello", payload: { apiVersion: MUSICPARTY_DESKTOP_API_VERSION, clientVersion: this.options.clientVersion ?? MUSICPARTY_MIN_CLIENT_VERSION } })) }
    socket.onmessage = (event) => { if (!this.stopped && this.socket === socket && generation === this.nativeGeneration) this.decode(event.data) }
    socket.onerror = () => this.emit({ type: "connection", status: "reconnecting", message: "网络连接异常" })
    socket.onclose = () => {
      if (this.stopped || this.socket !== socket) return
      ++this.nativeGeneration
      this.welcomed = false
      if (++this.attempt > DEFAULT_RETRY_POLICY.maxAttempts) { this.emit({ type: "connection", status: "failed", message: "无法连接 MusicParty 服务" }); return }
      this.emit({ type: "connection", status: "reconnecting" })
      this.reconnectTimer = setTimeout(() => void this.openSocket(), retryDelay(this.attempt))
    }
  }

  private decode(raw: unknown): void {
    try {
      const value = JSON.parse(String(raw)) as { type?: string; requestId?: string; roomId?: string; snapshot?: unknown; message?: string; payload?: unknown }
      if (value.roomId != null && value.roomId !== this.options.roomId) return
      if (value.type === "rooms.created") {
        try { this.roomCreate?.resolve(this.roomSummary(value.payload)) }
        catch { this.roomCreate?.reject(new MusicPartyRoomCreateError("invalid-response")) }
      }
      else if (value.type === "player.state") {
        const state = value.payload as PlayerStatePayload
        const scope = typeof state?.idempotencyScopeId === "string" && state.idempotencyScopeId.length > 0 && state.idempotencyScopeId.length <= 128
          && typeof state.idempotencyTtlMs === "number" && Number.isSafeInteger(state.idempotencyTtlMs) && state.idempotencyTtlMs > 0
          ? { id: state.idempotencyScopeId, ttlMs: state.idempotencyTtlMs } : null
        if (!state || ![state.stateVersion, state.queueVersion, state.playEpoch, state.serverTimestamp].every(Number.isFinite) || !Array.isArray(state.queue)) {
          this.controlScope = null
          throw new Error("invalid snapshot")
        }
        const decoded = decodeSharedPlayerState(value.payload)
        if (decoded) {
          if (this.controlIdempotency && this.controlScope?.id !== scope?.id) {
            this.controlPending?.finish("unknown")
            this.sharedState = null
            this.outstandingPings.clear()
          }
          this.controlScope = scope
          const projected = applyPlayerState(this.sharedState ?? emptySharedRoomState(this.options.roomId ?? ""), decoded, Date.now())
          if (projected) { this.controlScope = scope; this.sharedState = projected; this.emit({ type: "shared-room-state", state: projected }) }
        } else {
          this.controlScope = null
        }
        this.snapshot = { item: state.nowPlaying ? normalizeMusic(state.nowPlaying.music) : null, positionSeconds: (state.nowPlaying?.currentPosition ?? 0) / 1000, playing: !state.isPaused, revision: state.stateVersion, stateVersion: state.stateVersion, queueVersion: state.queueVersion, playEpoch: state.playEpoch, serverTimeMs: state.serverTimestamp }
        this.queue = state.queue.map(normalizeQueueEntry)
        this.emit({ type: "playback", snapshot: this.snapshot })
        this.emit({ type: "room", room: { id: this.options.roomId ?? "", name: this.options.roomId ?? "", memberCount: 0, playback: this.snapshot, queue: [...this.queue] } })
        this.emitQueue()
      }
      else if (value.type === "queue.patch") this.applyQueuePatch(value.payload as QueuePatchPayload)
      else if (value.type === "player.progress") {
        const progress = value.payload as { currentPosition: number; stateVersion: number; playEpoch: number; serverTimestamp: number }
        if (![progress.currentPosition, progress.stateVersion, progress.playEpoch, progress.serverTimestamp].every(Number.isFinite)) throw new Error("invalid progress")
        if (this.sharedState && progress.currentPosition >= 0 && Number.isSafeInteger(progress.stateVersion) && Number.isSafeInteger(progress.playEpoch)) {
          const projected = applyProgress(this.sharedState, progress, Date.now())
          if (projected) { this.sharedState = projected; this.emit({ type: "shared-room-state", state: projected }) }
        }
        if (!this.snapshot || progress.playEpoch !== this.snapshot.playEpoch || progress.stateVersion !== this.snapshot.stateVersion || progress.serverTimestamp < (this.snapshot.serverTimeMs ?? 0)) return
        this.snapshot = { ...this.snapshot, positionSeconds: progress.currentPosition / 1000, serverTimeMs: progress.serverTimestamp }
        this.emit({ type: "playback", snapshot: this.snapshot })
      }
      else if (value.type === "users.online") {
        const presence = value.payload as { users: Array<{ publicId: string; name: string }> }
        this.emit({ type: "members", members: presence.users.map(user => ({ id: user.publicId, name: user.name, online: true })) })
      }
      else if (value.type === "player.events") {
        const notice = value.payload as { code: string; severity: string; message: string }
        if (notice.code === "ROOM_CREATE_FAILED") this.roomCreate?.reject(new MusicPartyRoomCreateError("rejected"))
        this.emit({ type: "player-notice", code: notice.code, severity: notice.severity, message: notice.message })
        if (notice.code === "MEDIA_FAILED" || notice.code === "ERROR_LOAD") this.emit({ type: "error", code: "media-failed", message: notice.message })
      }
      else if (value.type === "server.hello") {
        const hello = value.payload as { apiVersion: string; minimumClientVersion?: string }
        if (hello.apiVersion !== MUSICPARTY_DESKTOP_API_VERSION || (hello.minimumClientVersion && compareVersions(this.options.clientVersion ?? MUSICPARTY_MIN_CLIENT_VERSION, hello.minimumClientVersion) < 0)) { clearTimeout(this.helloTimer); this.failVersion(hello) }
        else { this.welcomed = true; clearTimeout(this.helloTimer); this.emit({ type: "server-ready", apiVersion: hello.apiVersion, minimumClientVersion: hello.minimumClientVersion }); this.emit({ type: "connection", status: "ready" }); this.startClockSync(); this.scheduleSnapshotNudge() }
      }
      else if (value.type === "sync.pong") {
        const pong = value.payload as { pingId: string; clientSendTime: number; serverReceiveTime: number; serverSendTime: number }
        if (![pong.clientSendTime, pong.serverReceiveTime, pong.serverSendTime].every(Number.isFinite)) throw new Error("invalid pong")
        if (this.outstandingPings.delete(pong.pingId) && this.sharedState) {
          this.sharedState = addClockSample(this.sharedState, pong, Date.now())
          this.emit({ type: "shared-room-state", state: this.sharedState })
        }
        this.emit({ type: "clock-sync", pingId: pong.pingId, clientSendTime: pong.clientSendTime, serverReceiveTime: pong.serverReceiveTime, serverSendTime: pong.serverSendTime, receivedAt: Date.now() })
      }
      else if (value.type === "control.ack" && value.payload && typeof value.payload === "object") {
        const payload = value.payload as { outcome?: ControlOutcome; code?: unknown; committed?: { stateVersion?: unknown; queueVersion?: unknown; playEpoch?: unknown } }
        const pending = this.controlPending
        if (!pending || value.requestId !== pending.requestId || value.roomId !== pending.roomId || pending.generation !== this.nativeGeneration) return
        if (payload.outcome === "rejected") {
          const code = typeof payload.code === "string" && payload.code ? payload.code : "COMMAND_REJECTED"
          this.emit({ type: "denied", roomId: pending.roomId, requestId: pending.requestId, code, message: code })
          pending.finish("rejected")
        } else if ((payload.outcome === "applied" || payload.outcome === "noop") && payload.committed) {
          const { stateVersion, queueVersion, playEpoch } = payload.committed
          if (![stateVersion, queueVersion, playEpoch].every(version => typeof version === "number" && Number.isSafeInteger(version) && version >= 0)) return
          pending.ack = { outcome: payload.outcome, stateVersion: stateVersion as number, queueVersion: queueVersion as number, playEpoch: playEpoch as number }
          this.settleControl()
        }
      }
      else if (["enqueue.ack", "queue.mutation.ack", "queue.reorder.ack"].includes(value.type ?? "") && value.payload && typeof value.payload === "object") { const payload = value.payload as { mutationId?: string }; this.mutationWaiters.get(payload.mutationId ?? "")?.resolve(true); this.mutationWaiters.delete(payload.mutationId ?? ""); this.emit({ type: "queue", status: "accepted", mutationId: payload.mutationId ?? "" }) }
      else if (["enqueue.nack", "queue.mutation.nack", "queue.reorder.nack"].includes(value.type ?? "") && value.payload && typeof value.payload === "object") { const payload = value.payload as { mutationId?: string; reason?: string }; this.mutationWaiters.get(payload.mutationId ?? "")?.reject(new Error(payload.reason ?? "queue_rejected")); this.mutationWaiters.delete(payload.mutationId ?? ""); this.emit({ type: "queue", status: "rejected", mutationId: payload.mutationId ?? "", message: payload.reason }) }
      else if (value.type === "chat.message" && value.payload && typeof value.payload === "object") { const payload = value.payload as ChatMessagePayload; this.emit({ type: "chat", id: payload.id ?? crypto.randomUUID(), content: payload.content ?? "", author: chatAuthor(payload), createdAt: chatTimestamp(payload) }) }
      else if (value.type === "chat.history" && Array.isArray(value.payload)) for (const message of value.payload as ChatMessagePayload[]) this.emit({ type: "chat", id: message.id ?? crypto.randomUUID(), content: message.content ?? "", author: chatAuthor(message), createdAt: chatTimestamp(message) })
      else if ((value.type === "members.state" || value.type === "room.members") && Array.isArray(value.payload)) { this.emit({ type: "members", members: value.payload.map((member: { id?: string; publicId?: string; name?: string; online?: boolean }) => ({ id: member.id ?? member.publicId ?? "", name: member.name ?? "成员", online: member.online !== false })) }) }
      else if (value.type === "playlist.data" || value.type === "playlist.ack") this.settlePlaylist(value.requestId, { ok: true, payload: value.payload })
      else if (value.type === "history.page") {
        const payload = (value.payload && typeof value.payload === "object" ? value.payload : {}) as Record<string, unknown>
        const items = Array.isArray(payload.items) ? payload.items.map(toPlaybackHistoryItem).filter((item): item is PlaybackHistoryItem => item !== null) : []
        this.historyWaiter?.resolve({
          roomId: typeof payload.roomId === "string" ? payload.roomId : this.options.roomId ?? "",
          total: typeof payload.total === "number" ? payload.total : items.length,
          offset: typeof payload.offset === "number" ? payload.offset : 0,
          items,
        })
      }
      else if (value.type === "playlist.nack") {
        const reason = typeof (value.payload as { reason?: unknown } | null)?.reason === "string" ? (value.payload as { reason: string }).reason : "REJECTED"
        this.settlePlaylist(value.requestId, { ok: false, error: new MusicPartyPlaylistError(reason) })
      }
      else if (value.type === "server.incompatible" || value.type === "version.incompatible") this.failVersion()
      else if (value.type === "error") this.emit({ type: "error", code: "server_error", message: value.message ?? "MusicParty 服务错误" })
    } catch { this.emit({ type: "error", code: "invalid_event", message: "收到无法识别的服务事件" }) }
  }

  private failVersion(declared?: { apiVersion?: string; minimumClientVersion?: string }): void {
    this.stopped = true
    this.nativeActive = false
    void this.options.nativeInvoke?.("musicPartyWsDisconnect", {}).catch(() => undefined)
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.helloTimer)
    clearTimeout(this.snapshotNudge)
    this.stopClockSync()
    this.socket?.close()
    const detail = declared?.apiVersion ? `：服务端 API 为 ${declared.apiVersion}，客户端需要 ${MUSICPARTY_DESKTOP_API_VERSION}` : ""
    this.emit({ type: "error", code: "version-incompatible", message: `MusicParty 服务版本不兼容${detail}` })
    this.emit({ type: "connection", status: "failed", message: declared?.minimumClientVersion ? `服务端要求客户端最低版本 ${declared.minimumClientVersion}，当前 ${this.options.clientVersion ?? MUSICPARTY_MIN_CLIENT_VERSION}` : "请升级客户端或服务" })
  }

  private async openNative(): Promise<void> {
    const generation = ++this.nativeGeneration
    this.welcomed = false
    this.nativeActive = true
    try {
      const hello = await this.options.nativeInvoke!("musicPartyWsConnect", { input: { origin: this.options.origin, roomId: this.options.roomId ?? "", clientVersion: this.options.clientVersion ?? MUSICPARTY_MIN_CLIENT_VERSION } }) as { event: string }
      if (generation !== this.nativeGeneration || this.stopped) return
      this.decode(hello.event)
      if (!this.welcomed) return
      this.nativeActive = true
      const receive = async (): Promise<void> => {
        while (generation === this.nativeGeneration && !this.stopped) {
          try { const event = await this.options.nativeInvoke!("musicPartyWsReceive", {}) as { event: string }; if (generation === this.nativeGeneration) this.decode(event.event) }
          catch (error) { this.nativeFailure(generation, error); return }
        }
      }
      void receive().catch(() => undefined)
    } catch (error) { this.nativeFailure(generation, error) }
  }

  private nativeFailure(generation: number, error: unknown): void {
    if (generation !== this.nativeGeneration || this.stopped) return
    if (String(error).includes("version-incompatible")) { this.failVersion(); return }
    ++this.nativeGeneration
    this.nativeActive = false
    this.welcomed = false
    const token = this.nativeGeneration
    void this.options.nativeInvoke?.("musicPartyWsDisconnect", {}).catch(() => undefined).then(() => {
      if (token !== this.nativeGeneration || this.stopped) return
      if (++this.attempt > DEFAULT_RETRY_POLICY.maxAttempts) { this.emit({ type: "connection", status: "failed" }); return }
      this.emit({ type: "connection", status: "reconnecting" })
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = setTimeout(() => { if (token === this.nativeGeneration && !this.stopped) void this.openNative() }, retryDelay(this.attempt))
    })
  }

  private sendCommand(value: unknown): boolean {
    if (this.stopped || !this.welcomed) return false
    if (this.options.nativeInvoke && this.nativeActive) { const generation = this.nativeGeneration; void this.options.nativeInvoke("musicPartyWsSend", { event: JSON.stringify(value) }).catch(error => this.nativeFailure(generation, error)); return true }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.welcomed) return false
    try { this.socket.send(JSON.stringify(value)); return true } catch { return false }
  }

  private emitQueue(): void {
    this.emit({ type: "queue-state", roomId: this.options.roomId ?? "", items: [...this.queue], queueVersion: this.snapshot?.queueVersion ?? 0 })
  }

  private applyQueuePatch(patch: QueuePatchPayload): void {
    if (!this.snapshot || patch.queueVersion <= (this.snapshot.queueVersion ?? 0)) return
    if (patch.queueVersion !== (this.snapshot.queueVersion ?? 0) + 1) {
      this.requestResync()
      return
    }
    switch (patch.operation) {
      case "append": this.queue = [...this.queue, ...(patch.items ?? []).map(normalizeQueueEntry)]; break
      case "snapshot": this.queue = (patch.queue ?? []).map(normalizeQueueEntry); break
      case "clear": this.queue = []; break
      case "remove": this.queue = this.queue.filter(item => !(patch.queueIds ?? [patch.queueId]).includes(item.id)); break
      case "status": this.queue = this.queue.map(item => item.id === (patch.queueId ?? patch.item?.queueId) ? { ...item, status: patch.status ?? patch.item?.status } : item); break
      case "move": {
        const item = this.queue.find(entry => entry.id === patch.queueId)
        const remaining = this.queue.filter(entry => entry.id !== patch.queueId)
        const index = remaining.findIndex(entry => entry.id === patch.targetQueueId)
        if (!item || index < 0) throw new Error("invalid queue move")
        remaining.splice(index + (patch.position === "after" ? 1 : 0), 0, item)
        this.queue = remaining
        break
      }
      default: throw new Error("unknown queue patch")
    }
    this.snapshot = { ...this.snapshot, queueVersion: patch.queueVersion }
    if (this.sharedState && patch.queueVersion > this.sharedState.queueVersion) {
      this.sharedState = { ...this.sharedState, queueVersion: patch.queueVersion }
      this.emit({ type: "shared-room-state", state: this.sharedState })
    }
    this.emitQueue()
  }

  private emit(event: DomainEvent): void {
    if (event.type === "shared-room-state") this.settleControl()
    if (event.type === "server-ready") this.roomCreateUncertain = false
    if (event.type === "connection" && event.status !== "ready") {
      this.controlPending?.finish("unknown")
      this.roomCreate?.reject(new MusicPartyRoomCreateError("disconnected"))
      this.snapshot = null
      this.sharedState = null
      this.controlScope = null
      this.stopClockSync()
      for (const waiter of this.mutationWaiters.values()) waiter.reject(new Error("disconnected"))
      for (const settle of this.playlistWaiters.values()) settle({ ok: false, error: new MusicPartyPlaylistError("DISCONNECTED") })
      this.playlistWaiters.clear()
    }
    for (const listener of this.listeners) listener(event)
  }

  /** An ACK identifies our result; only an accepted projection proves convergence. */
  private settleControl(): void {
    const pending = this.controlPending, state = this.sharedState
    if (!pending?.ack || !state || pending.generation !== this.nativeGeneration || state.roomId !== pending.roomId) return
    if (state.stateVersion >= pending.ack.stateVersion && state.queueVersion >= pending.ack.queueVersion && state.playEpoch >= pending.ack.playEpoch) pending.finish(pending.ack.outcome)
  }

  /** D4 time base: ping every 5s while ready; three unanswered pings or a clock jump void the samples. */
  private startClockSync(): void {
    this.stopClockSync()
    this.schedulePing(5000)
  }

  private schedulePing(delayMs: number): void {
    clearTimeout(this.pingTimer)
    if (this.stopped || !this.welcomed) return
    const dueAtMs = Date.now() + delayMs
    this.pingTimer = setTimeout(() => this.sendClockPing(dueAtMs), delayMs)
  }

  private sendClockPing(dueAtMs: number): void {
    if (this.stopped || !this.welcomed) return
    if (Date.now() - dueAtMs > 5000 || this.outstandingPings.size >= 3) {
      this.outstandingPings.clear()
      if (this.sharedState?.clockSamples.length) {
        this.sharedState = { ...this.sharedState, clockSamples: [] }
        this.emit({ type: "shared-room-state", state: this.sharedState })
      }
    }
    const pingId = crypto.randomUUID()
    this.outstandingPings.set(pingId, Date.now())
    this.sendCommand({ type: "sync.ping", payload: { pingId, clientSendTime: Date.now() } })
    this.schedulePing(5000)
  }

  private stopClockSync(): void {
    clearTimeout(this.pingTimer)
    this.pingTimer = undefined
    this.outstandingPings.clear()
  }

  private requestResync(): void {
    const now = Date.now()
    if (now - this.lastResyncAtMs < 750) return
    this.lastResyncAtMs = now
    this.sendCommand({ type: "player.resync", roomId: this.options.roomId, payload: {} })
  }

  /**
   * The server pushes the initial snapshot only when its room runtime answers, so a welcome
   * can still leave the room blank. Ask once instead of waiting for a broadcast that an idle
   * room has no reason to send.
   */
  private scheduleSnapshotNudge(): void {
    clearTimeout(this.snapshotNudge)
    if (!this.options.roomId) return
    this.snapshotNudge = setTimeout(() => {
      this.snapshotNudge = undefined
      if (!this.stopped && this.welcomed && !this.snapshot) this.requestResync()
    }, this.options.firstSnapshotNudgeMs ?? FIRST_SNAPSHOT_NUDGE_MS)
  }
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number), b = right.split(".").map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

function normalizeMusic(music: MusicMetadata): MediaItem {
  return { id: music.id, title: music.name, artist: music.artists.join(", "), artworkUrl: music.coverUrl, durationSeconds: music.duration / 1000, kind: "audio", source: music.platform }
}

export class MusicPartyHttpError extends Error {
  constructor(readonly code: string, readonly status: number, readonly detail?: string) {
    super(detail ?? code)
    this.name = "MusicPartyHttpError"
  }
}

async function safeHttpErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const payload: unknown = await response.clone().json()
    if (!payload || typeof payload !== "object") return undefined
    const value = payload as Record<string, unknown>
    const message = typeof value.message === "string" ? value.message : typeof value.error === "object" && value.error && typeof (value.error as Record<string, unknown>).message === "string" ? (value.error as Record<string, unknown>).message as string : undefined
    if (!message || message.length > 240 || /(?:cookie|csrf|session|token|authorization|set-cookie)/i.test(message)) return undefined
    return message
  } catch { return undefined }
}



function normalizeQueueEntry(entry: { queueId: string; music: MusicMetadata; status?: string }): MediaItem {
  return { ...normalizeMusic(entry.music), id: entry.queueId, musicId: entry.music.id, status: entry.status }
}

function toPlaylistSummary(value: unknown): PlaylistSummary {
  const raw = value as Record<string, unknown> | null
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id || typeof raw.name !== "string"
    || typeof raw.trackCount !== "number" || !Number.isSafeInteger(raw.trackCount) || raw.trackCount < 0
    || (raw.systemKey !== null && typeof raw.systemKey !== "string")) throw new MusicPartyPlaylistError("INVALID_RESPONSE")
  return { id: raw.id, name: raw.name, systemKey: raw.systemKey as string | null, trackCount: raw.trackCount,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0, updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0 }
}

function toPlaylistTrack(value: unknown): PlaylistTrack {
  const raw = value as Record<string, unknown> | null
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id || typeof raw.playlistId !== "string") throw new MusicPartyPlaylistError("INVALID_RESPONSE")
  const music = raw.music as Partial<MusicMetadata> | null
  if (!music || typeof music.id !== "string" || typeof music.name !== "string" || !Array.isArray(music.artists)
    || typeof music.duration !== "number" || !Number.isFinite(music.duration) || typeof music.platform !== "string"
    || typeof music.coverUrl !== "string") throw new MusicPartyPlaylistError("INVALID_RESPONSE")
  return { id: raw.id, playlistId: raw.playlistId, music: music as MusicMetadata,
    sortOrder: typeof raw.sortOrder === "number" ? raw.sortOrder : 0, createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0 }
}

/** Decode the additive room projection without changing the native playback path. */
function decodeSharedPlayerState(value: unknown): PlayerStatePayload | null {
  if (!value || typeof value !== "object") return null
  const state = value as Record<string, unknown>
  if (![state.stateVersion, state.queueVersion, state.playEpoch].every(version => typeof version === "number" && Number.isSafeInteger(version) && version >= 0)
    || typeof state.serverTimestamp !== "number" || !Number.isFinite(state.serverTimestamp)
    || typeof state.isPaused !== "boolean" || !Array.isArray(state.queue)) return null
  const flags = ["isShuffle", "isPauseLocked", "isSkipLocked", "isShuffleLocked", "isLoading"] as const
  if (flags.some(key => typeof state[key] !== "boolean")) return null
  const raw = state.nowPlaying
  let nowPlaying: PlayerStatePayload["nowPlaying"] = null
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object") return null
    const current = raw as Record<string, unknown>
    const music = current.music as Partial<MusicMetadata> | null
    if (!music || typeof music !== "object" || typeof music.id !== "string" || typeof music.name !== "string"
      || !Array.isArray(music.artists) || !music.artists.every(artist => typeof artist === "string")
      || typeof music.duration !== "number" || !Number.isFinite(music.duration) || music.duration < 0
      || !["netease", "youtube", "bilibili"].includes(music.platform ?? "") || typeof music.coverUrl !== "string"
      || typeof current.currentPosition !== "number" || !Number.isFinite(current.currentPosition) || current.currentPosition < 0) return null
    if (["enqueuedById", "enqueuedByName"].some(key => current[key] !== null && typeof current[key] !== "string")
      || !Array.isArray(current.likedUserIds) || !current.likedUserIds.every(id => typeof id === "string")
      || typeof current.positionUpdatedAt !== "number" || !Number.isFinite(current.positionUpdatedAt)
      || (current.playEpoch !== undefined && current.playEpoch !== state.playEpoch)) return null
    nowPlaying = { music: music as MusicMetadata, currentPosition: current.currentPosition,
      enqueuedById: current.enqueuedById as string | null | undefined, enqueuedByName: current.enqueuedByName as string | null | undefined,
      likedUserIds: current.likedUserIds as string[] | undefined, positionUpdatedAt: current.positionUpdatedAt as number | undefined }
  }
  return { nowPlaying, queue: [], isPaused: state.isPaused, isShuffle: state.isShuffle === true,
    isPauseLocked: state.isPauseLocked === true, isSkipLocked: state.isSkipLocked === true,
    isShuffleLocked: state.isShuffleLocked === true, isLoading: state.isLoading === true,
    stateVersion: state.stateVersion as number, queueVersion: state.queueVersion as number,
    historyCursor: typeof state.historyCursor === "number" && Number.isSafeInteger(state.historyCursor) && state.historyCursor >= 0 ? state.historyCursor : undefined,
    playEpoch: state.playEpoch as number, serverTimestamp: state.serverTimestamp }
}
