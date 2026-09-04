export type ConnectionState = "connecting" | "ready" | "backoff" | "expired" | "failed"
export type ClientType = "browser" | "mpv" | "desktop"

export type MediaSource =
  | { kind: "openlist"; mediaId: string; title: string; container: string; displayPath?: string | null }
  | { kind: "http" | "hls"; url: string; title?: string | null }
  | { kind: "youtube"; videoId: string; title?: string | null }

export interface PlaylistItem {
  id: string
  media: MediaSource
  addedByClientId: string
  addedAtMs: number
}

export interface RoomSnapshot {
  revision: number
  source: MediaSource | null
  currentPlaylistItemId?: string | null
  positionSeconds: number
  serverTimeMs: number
  paused: boolean
  playbackRate: number
  loop: boolean
  locked: boolean
  ownerClientId: string
  playlist: PlaylistItem[]
}

export interface RoomMember {
  clientId: string
  name: string
  isOwner: boolean
  clientType: ClientType
}

export interface Track {
  id: number
  label: string
  kind: string
  language?: string | null
  codec?: string | null
  selected: boolean
}

export interface PlayerState {
  time: number
  duration: number
  buffering: boolean
  loaded: boolean
  paused: boolean
  rate: number
  volume: number
  audioTracks: Track[]
  subtitleTracks: Track[]
}

export interface NativeCapabilityReport {
  libmpvReady: boolean
  vo?: string | null
  hwdecConfigured?: string | null
  hwdec?: string | null
  videoCodec?: string | null
  videoProfile?: string | null
  audioCodec?: string | null
  pixelFormat?: string | null
  width?: number | null
  height?: number | null
  hdr?: boolean | null
}

export interface UiError {
  code: string
  message: string
}

export interface DesktopUiState {
  connection: ConnectionState
  /** The room the native session actually joined; the single source of truth for the UI. */
  roomId?: string | null
  room: RoomSnapshot | null
  members: RoomMember[]
  canControlSharedPlayback: boolean
  /** Whether this client owns the room. */
  isOwner?: boolean
  player: PlayerState
  playerWindowVisible: boolean
  capability: NativeCapabilityReport
  error: UiError | null
}

export type DesktopCommand =
  | { type: "play" | "pause" | "resync" }
  | { type: "seek"; positionSeconds: number }
  | { type: "rate"; rate: number }
  | { type: "volume"; volume: number }
  | { type: "selectAudioTrack"; trackId: number }
  | { type: "selectSubtitleTrack"; trackId: number | null }
  | { type: "playerVisibility"; visible: boolean }
  | { type: "fullscreen"; enabled: boolean }
  | { type: "playlistPlay"; itemId: string }
  | { type: "playlistNext"; expectedCurrentPlaylistItemId: string | null }

export interface CommandAck {
  ok: boolean
  revision: number
  error?: UiError | null
}
