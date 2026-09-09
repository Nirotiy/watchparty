export type ProductId = "watchparty" | "musicparty"

export type ConnectionStatus = "idle" | "connecting" | "ready" | "reconnecting" | "expired" | "failed"

export type MediaKind = "audio" | "video"

export interface MediaItem {
  id: string
  title: string
  artist?: string
  artworkUrl?: string
  durationSeconds?: number
  kind: MediaKind
  source: string
}

export interface PlaybackSnapshot {
  item: MediaItem | null
  positionSeconds: number
  playing: boolean
  revision: number
  serverTimeMs?: number
}

export interface RoomSummary {
  id: string
  name: string
  memberCount: number
  playback: PlaybackSnapshot
}

export type DomainEvent =
  | { type: "connection"; status: ConnectionStatus; message?: string }
  | { type: "playback"; snapshot: PlaybackSnapshot }
  | { type: "room"; room: RoomSummary }
  | { type: "error"; code: string; message: string }

