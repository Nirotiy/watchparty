import type { ProductId } from "./domain"

export const LOCAL_SCHEMA_VERSION = 1 as const

export interface LocalServiceProfile {
  id: string
  product: ProductId
  origin: string
  label: string
}

/** 本机在 Linkle 房间里的身份。用户在启动时指定（名字 + 机器可分辨的 id）；
    没指定时回落服务端账号，见 linkleIdentity()。 */
export interface LinkleMemberIdentity {
  id: string
  name: string
}

export interface LocalSettingsV1 {
  schemaVersion: typeof LOCAL_SCHEMA_VERSION
  services: LocalServiceProfile[]
  activeServiceId?: string
  theme: "dark" | "light"
  playback?: Record<string, { roomId: string; mediaId?: string; positionSeconds: number }>
  linkleMember?: LinkleMemberIdentity
}

export function createDefaultLocalSettings(): LocalSettingsV1 {
  return { schemaVersion: LOCAL_SCHEMA_VERSION, services: [], theme: "dark", playback: {} }
}

/** 本地身份优先，其次服务端账号；两者都没有就没有身份（界面不猜测）。 */
export function linkleIdentity(local: LinkleMemberIdentity | null, account: { publicId: string; displayName: string } | null): { id: string; name: string; source: "local" | "server" } | null {
  if (local && local.id.trim() && local.name.trim()) return { id: local.id.trim(), name: local.name.trim(), source: "local" }
  if (account && account.publicId) return { id: account.publicId, name: (account.displayName || account.publicId).trim(), source: "server" }
  return null
}

/** 读本机设置里的身份；坏值一律当没设置。 */
export function linkleMemberOf(settings: LocalSettingsV1): LinkleMemberIdentity | null {
  const member = settings.linkleMember
  if (!member || typeof member !== "object") return null
  const { id, name } = member as Partial<LinkleMemberIdentity>
  if (typeof id !== "string" || typeof name !== "string") return null
  return id.trim() && name.trim() ? { id, name } : null
}

/** 首次建号时报给服务端的名字（用户 2026-09-25 定：自定义 ID 写进服务端，之后以服务端为准）。
    本机 ID 优先，其次本机昵称，最后才是「桌面用户」。改名不在这条路上——那要等 WS `user.rename`。 */
export function linkleDisplayName(member: LinkleMemberIdentity | null | undefined, nickname?: string | null, fallback = "桌面用户"): string {
  const local = member && member.id.trim() && member.name.trim() ? member.name.trim() : ""
  const host = typeof nickname === "string" ? nickname.trim() : ""
  return local || host || fallback
}

export function migrateLocalSettings(input: unknown): LocalSettingsV1 {
  if (!input || typeof input !== "object") return createDefaultLocalSettings()
  const value = input as Partial<LocalSettingsV1>
  if (value.schemaVersion === LOCAL_SCHEMA_VERSION && Array.isArray(value.services)) {
    return {
      schemaVersion: LOCAL_SCHEMA_VERSION,
      services: value.services.filter((service): service is LocalServiceProfile => Boolean(service && typeof service === "object" && typeof service.id === "string" && typeof service.origin === "string" && (service.product === "watchparty" || service.product === "musicparty"))),
      activeServiceId: typeof value.activeServiceId === "string" ? value.activeServiceId : undefined,
      theme: value.theme === "light" ? "light" : "dark",
      playback: value.playback && typeof value.playback === "object" ? value.playback : {},
      linkleMember: linkleMemberOf({ linkleMember: value.linkleMember } as LocalSettingsV1) ?? undefined,
    }
  }
  return createDefaultLocalSettings()
}

export function upsertService(settings: LocalSettingsV1, service: LocalServiceProfile): LocalSettingsV1 {
  const services = settings.services.some((item) => item.id === service.id)
    ? settings.services.map((item) => item.id === service.id ? service : item)
    : [...settings.services, service]
  return { ...settings, services, activeServiceId: settings.activeServiceId ?? service.id }
}

export function serviceForProduct(settings: LocalSettingsV1, product: ProductId): LocalServiceProfile | undefined {
  return settings.services.find((service) => service.product === product && service.id === settings.activeServiceId)
    ?? settings.services.find((service) => service.product === product)
}

/**
 * Desktop servers hold a session cookie, so plaintext http is only acceptable on the
 * loopback demo box. The main-process policy enforces the same rule; this copy exists
 * so the user sees a usable sentence instead of a generic connection failure.
 */
export function musicPartyOriginError(input: string): string | undefined {
  let url: URL
  try { url = new URL(input.trim()) } catch { return "服务地址无效" }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) return "服务地址必须是完整的 http/https 来源"
  if (url.protocol === "http:" && !/^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/i.test(url.hostname)) return "非本机服务地址必须使用 https"
  return undefined
}

/** Saves one origin without replacing other services or their native credentials. */
export function saveMusicPartyService(settings: LocalSettingsV1, input: string): LocalSettingsV1 {
  const invalid = musicPartyOriginError(input)
  if (invalid) throw new Error(invalid)
  const url = new URL(input.trim())
  const origin = url.origin
  const existing = settings.services.find(service => service.product === 'musicparty' && service.origin === origin)
  const id = existing?.id ?? `musicparty:${origin}`
  return { ...upsertService(settings, { id, product: 'musicparty', origin, label: existing?.label ?? 'Linkle' }), activeServiceId: id }
}

export function removeService(settings: LocalSettingsV1, serviceId: string): LocalSettingsV1 {
  const services = settings.services.filter((service) => service.id !== serviceId)
  return { ...settings, services, activeServiceId: settings.activeServiceId === serviceId ? services[0]?.id : settings.activeServiceId }
}

export function savePlaybackCache(settings: LocalSettingsV1, product: ProductId, roomId: string, mediaId: string | undefined, positionSeconds: number): LocalSettingsV1 {
  return { ...settings, playback: { ...(settings.playback ?? {}), [product]: { roomId, mediaId, positionSeconds: Math.max(0, positionSeconds) } } }
}
