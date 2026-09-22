export const MUSICPARTY_DESKTOP_API_VERSION = "2026-01" as const
export const MUSICPARTY_MIN_CLIENT_VERSION = "0.2.0" as const

export interface DesktopHelloPayload {
  apiVersion: typeof MUSICPARTY_DESKTOP_API_VERSION
  clientVersion: string
}

export interface InviteRedeemResponse {
  roomId: string
  apiVersion: string
  minimumClientVersion?: string
}

export interface MediaResolveResponse {
  url: string
  expiresAt: number | null
  contentType: string | null
  resolvedAt: number
  music: MusicMetadata
}

export interface MusicMetadata {
  id: string
  name: string
  artists: string[]
  duration: number
  platform: "netease" | "youtube" | "bilibili"
  coverUrl: string
}

export interface QueueEntry { queueId: string; music: MusicMetadata; status?: string }
export interface NowPlayingPayload {
  music: MusicMetadata
  currentPosition: number
  enqueuedById?: string | null
  enqueuedByName?: string | null
  likedUserIds?: string[]
  likeMarkers?: number[]
  playEpoch?: number
  positionUpdatedAt?: number
}
export interface PlayerStatePayload {
  idempotencyScopeId?: string
  idempotencyTtlMs?: number
  nowPlaying?: NowPlayingPayload | null
  queue: QueueEntry[]
  isPaused: boolean
  isShuffle: boolean
  isPauseLocked: boolean
  isSkipLocked: boolean
  isShuffleLocked: boolean
  isLoading: boolean
  stateVersion: number
  queueVersion: number
  historyCursor?: number
  playEpoch: number
  serverTimestamp: number
}
export interface PlayerProgressPayload { currentPosition: number; stateVersion: number; playEpoch: number; serverTimestamp: number }
export interface SyncPongPayload { pingId: string; clientSendTime: number; serverReceiveTime: number; serverSendTime: number }
export interface QueuePatchPayload {
  operation: "append" | "remove" | "move" | "snapshot" | "status" | "clear"
  queueVersion: number
  items?: QueueEntry[]
  queue?: QueueEntry[]
  item?: Partial<QueueEntry>
  queueId?: string
  queueIds?: string[]
  targetQueueId?: string
  position?: string
  status?: string
}
