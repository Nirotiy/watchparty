import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

import type { CommandAck, DesktopCommand, DesktopUiState, MediaDirectoryPage } from "@/lib/contracts"

export interface DesktopSettingsStatus {
  backendOrigin: string | null
  nickname: string
  theme: "dark" | "light"
  playerPreferences: { hardwareDecoding: string; cacheProfile: string }
  credentialsConfigured: boolean
}

export interface DesktopRoomResult { roomId: string }

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
  playerPreferences: { hardwareDecoding: string; cacheProfile: string }
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
