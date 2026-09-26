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

/** 专辑（后端 §14.1 冻结契约，`GET /api/desktop/v1/albums/{platform}` 的 items）。
    字段实测：artistName, coverUrl, id, name, platform, trackCount。 */
export interface MusicAlbum {
  id: string
  name: string
  artistName: string
  coverUrl: string
  platform: string
  trackCount: number
}
export interface AlbumPage {
  items: MusicAlbum[]
  /** >0 是整场总数；===0 表示该平台不提供总数（继续用满页启发式）。 */
  total: number
  offset: number
  limit: number
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

/** 房间播放历史（后端 handoff §13 冻结契约）：`history.list {offset?, limit?}` → `history.page`。
    排序 `played_at desc, id desc`；limit 缺省 50 / 封顶 200；翻过末尾返回空数组（不是 null）。 */
export interface PlaybackHistoryItem {
  id: string
  music: MusicMetadata
  enqueuerPublicId: string | null
  enqueuerName: string | null
  playedAt: number
}
export interface HistoryPage {
  roomId: string
  total: number
  offset: number
  items: PlaybackHistoryItem[]
}
