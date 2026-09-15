import type { ProductId } from "./domain"

export const LOCAL_SCHEMA_VERSION = 1 as const

export interface LocalServiceProfile {
  id: string
  product: ProductId
  origin: string
  label: string
}

export interface LocalSettingsV1 {
  schemaVersion: typeof LOCAL_SCHEMA_VERSION
  services: LocalServiceProfile[]
  activeServiceId?: string
  theme: "dark" | "light"
  playback?: Record<string, { roomId: string; mediaId?: string; positionSeconds: number }>
}

export function createDefaultLocalSettings(): LocalSettingsV1 {
  return { schemaVersion: LOCAL_SCHEMA_VERSION, services: [], theme: "dark", playback: {} }
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

export function removeService(settings: LocalSettingsV1, serviceId: string): LocalSettingsV1 {
  const services = settings.services.filter((service) => service.id !== serviceId)
  return { ...settings, services, activeServiceId: settings.activeServiceId === serviceId ? services[0]?.id : settings.activeServiceId }
}

export function savePlaybackCache(settings: LocalSettingsV1, product: ProductId, roomId: string, mediaId: string | undefined, positionSeconds: number): LocalSettingsV1 {
  return { ...settings, playback: { ...(settings.playback ?? {}), [product]: { roomId, mediaId, positionSeconds: Math.max(0, positionSeconds) } } }
}
