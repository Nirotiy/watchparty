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
}

export function createDefaultLocalSettings(): LocalSettingsV1 {
  return { schemaVersion: LOCAL_SCHEMA_VERSION, services: [], theme: "dark" }
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
    }
  }
  return createDefaultLocalSettings()
}

