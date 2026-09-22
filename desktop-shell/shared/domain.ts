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
  /** Underlying track id for queue rows, whose `id` is the queue row id. */
  musicId?: string
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

export interface ClockSample { rttMs: number; offsetMs: number; takenAtLocalMs: number }

/** Read-only room projection. PlaybackSnapshot remains the native player's input. */
export interface SharedRoomState {
  roomId: string
  item: MediaItem | null
  durationMs: number
  paused: boolean
  shuffle: boolean
  loading: boolean
  pauseLocked: boolean
  skipLocked: boolean
  shuffleLocked: boolean
  enqueuedById: string | null
  enqueuedByName: string | null
  likedUserIds: string[]
  positionUpdatedAt: number | null
  stateVersion: number
  queueVersion: number
  /** Entries still available behind the current track; null means the server did not report it. */
  historyCursor: number | null
  playEpoch: number
  positionAnchorMs: number
  anchorServerMs: number
  anchorLocalMs: number
  clockSamples: ClockSample[]
}

export type SharedCommandKind = "play" | "pause" | "seek" | "next" | "previous" | "shuffle" | "like"

export interface RoomSummary {
  id: string
  name: string
  memberCount: number
  playback: PlaybackSnapshot
  queue?: MediaItem[]
}

export type DomainEvent =
  | { type: "shared-room-state"; state: SharedRoomState }
  | { type: "command-pending"; roomId: string; requestId: string; kind: SharedCommandKind; pending: boolean }
  | { type: "denied"; roomId: string; requestId: string; code: string; message: string }
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
