/**
 * WatchParty 前端核心契约与数据模型定义 (Domain Contracts)
 * 严格遵照 UNIVERSAL_ALIGNMENT_SPEC.md v1.0.0-FINAL
 */

// 1. 媒体源定义
export type MediaSource =
  | {
      kind: "openlist";
      mediaId: string;
      title: string;
      container: string;
      displayPath?: string;
    }
  | {
      kind: "http";
      url: string;
      title?: string;
    }
  | {
      kind: "hls";
      url: string;
      title?: string;
    }
  | {
      kind: "youtube";
      videoId: string;
      title?: string;
    };

// 2. 播放列表条目
export interface PlaylistItem {
  id: string;
  media: MediaSource;
  addedByClientId: string;
  addedAtMs: number;
}

// 3. 房间权威快照
export interface RoomSnapshot {
  revision: number;
  source: MediaSource | null;
  currentPlaylistItemId?: string;
  positionSeconds: number;
  serverTimeMs: number;
  paused: boolean;
  playbackRate: number;
  loop: boolean;
  locked: boolean;
  ownerClientId: string;
  playlist: PlaylistItem[];
}

// 4. 在线成员与身份
export interface RoomMember {
  clientId: string;
  name: string;
  isOwner: boolean;
  isSelf?: boolean;
}

// 5. 错误类型
export type ErrorCode =
  | "INVALID_REQUEST"
  | "ROOM_NOT_FOUND"
  | "INVALID_PIN"
  | "RATE_LIMITED"
  | "ACCESS_TOKEN_INVALID"
  | "OWNER_TOKEN_INVALID"
  | "FORBIDDEN"
  | "OPENLIST_UNAVAILABLE"
  | "MEDIA_NOT_FOUND"
  | "MEDIA_UNSUPPORTED"
  | "PLAYLIST_FULL"
  | "REVISION_CONFLICT"
  | "OWNER_TARGET_OFFLINE";

export interface ApiError {
  code: ErrorCode | string;
  message: string;
}

// 6. 房间基本信息（探针）
export interface RoomInfoResponse {
  roomId: string;
  isProtected: boolean;
  onlineCount: number;
}

// 7. 创建房间请求与响应
export interface CreateRoomRequest {
  clientId: string;
  nickname: string;
  pin?: string;
  initialMedia?: MediaSource;
}

export interface CreateRoomResponse {
  roomId: string;
  accessToken: string;
  ownerToken: string;
}

// 8. 房间 PIN / 免密获取 Token
export interface RoomAccessRequest {
  clientId: string;
  nickname: string;
  pin?: string;
}

export interface RoomAccessResponse {
  accessToken: string;
}

// 9. OpenList 媒体项与目录结构
export type AllowedOpenListRoot = "Anime" | "Film" | "TV Shows";

export type CompatibilityStatus = "supported" | "maybe" | "unsupported";

export interface MediaCompatibility {
  browser: CompatibilityStatus;
  desktop: CompatibilityStatus;
  browserReason?: string;
  desktopReason?: string;
}

export interface OpenListItem {
  id: string;
  name: string;
  type: "file" | "dir";
  size?: number;
  extension?: string;
  duration?: number;
  compatibility: MediaCompatibility;
  displayPath?: string;
}

export interface OpenListDirectory {
  root: AllowedOpenListRoot;
  currentPath: string;
  breadcrumbs: string[];
  hasMore: boolean;
  nextCursor?: string;
  items: OpenListItem[];
}

// 10. 字幕定义
export interface SubtitleTrack {
  id: string;
  label: string;
  format: "ass" | "ssa" | "srt" | "vtt";
  mediaId: string;
  language?: string;
  offsetSeconds?: number;
}

// 11. Command Ack 规范
export type CommandAck<T = undefined> =
  | { ok: true; revision: number; data?: T }
  | { ok: false; error: { code: string; message: string } };
