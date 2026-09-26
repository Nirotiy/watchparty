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
 * (`/artwork/:mediaId` → sidecar → backend with site credentials), so a card can use a
 * plain `<img>` under the renderer's `img-src 'self'` rule.
 */
export function artworkUrl(posterId: string): string {
  return `${window.location.origin}/artwork/${encodeURIComponent(posterId)}`
}

/** Raised for any non-2xx media answer. `code` is the server's own code when the body carries one. */
export class MediaRequestError extends Error {
  constructor(readonly code: string, readonly status: number) {
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
  if (reply.status < 200 || reply.status >= 300) throw new MediaRequestError(mediaErrorCode(parsed, reply.status), reply.status)
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
