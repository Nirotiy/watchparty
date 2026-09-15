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
  status?: string
}

export interface PlaybackSnapshot {
  item: MediaItem | null
  positionSeconds: number
  playing: boolean
  revision: number
  stateVersion?: number
  queueVersion?: number
  playEpoch?: number
  serverTimeMs?: number
}

export interface RoomSummary {
  id: string
  name: string
  memberCount: number
  playback: PlaybackSnapshot
  queue?: MediaItem[]
}

export type DomainEvent =
  | { type: "queue-state"; roomId: string; items: MediaItem[]; queueVersion: number }
  | { type: "server-ready"; apiVersion: string; minimumClientVersion?: string }
  | { type: "clock-sync"; pingId: string; clientSendTime: number; serverReceiveTime: number; serverSendTime: number; receivedAt: number }
  | { type: "player-notice"; code: string; severity: string; message: string }
  | { type: "connection"; status: ConnectionStatus; message?: string }
  | { type: "playback"; snapshot: PlaybackSnapshot }
  | { type: "room"; room: RoomSummary }
  | { type: "error"; code: string; message: string }
  | { type: "queue"; status: "accepted" | "rejected"; mutationId: string; message?: string }
  | { type: "chat"; id: string; author: string; content: string; createdAt?: string }
  | { type: "members"; members: Array<{ id: string; name: string; online: boolean }> }
