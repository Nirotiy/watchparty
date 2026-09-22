import { invoke, listen, type UnlistenFn } from "../../shared/desktop-runtime"

import type { CommandAck, DesktopCommand, DesktopUiState, MediaDirectoryPage } from "@/lib/contracts"

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
  nickname: string
  theme: "dark" | "light"
  windowMaterial: "auto" | "none"
  playerPreferences: PlayerPreferences
  credentialsConfigured: boolean
  playerPreferenceFailures: string[]
}

export interface DesktopRoomResult { roomId: string }

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
  nickname: string
  theme: "dark" | "light"
  windowMaterial?: "auto" | "none"
  playerPreferences: PlayerPreferences
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
      return "18083 是管理网页，Electron 后端使用 18082。请将端口改为 18082。"
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

export async function logoutMusicParty(origin: string | null): Promise<void> {
  const response = await musicPartyRequest(origin, "/api/account/logout")
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

export function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return fallback
}
