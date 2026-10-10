import type { Server } from "socket.io";

export type MediaSource =
  | {
      kind: "openlist";
      mediaId: string;
      title: string;
      container: string;
      displayPath?: string;
    }
  | { kind: "http"; url: string; title?: string }
  | { kind: "hls"; url: string; title?: string }
  | { kind: "youtube"; videoId: string; title?: string };

/** Static adapter contract, not a probe of any browser or video's availability. */
export const YOUTUBE_PLAYBACK_CAPABILITIES = {
  engine: "youtube-iframe",
  playbackLocation: "browser",
  serverMediaProxy: false,
  requiresBrowserAccess: true,
  requiresPlaybackApiKey: false,
  availability: "client-observed",
  stateScope: "client-local",
  controls: ["play", "pause", "seek", "rate"],
  states: ["loading", "ready", "playing", "paused", "buffering", "ended", "error"],
  errors: {
    YOUTUBE_INVALID_VIDEO: { message: "YouTube 视频标识无效", iframeErrorCodes: [2] },
    YOUTUBE_PLAYBACK_FAILED: { message: "YouTube 播放失败", iframeErrorCodes: [5] },
    YOUTUBE_VIDEO_UNAVAILABLE: { message: "YouTube 视频不存在、已移除或为私密视频", iframeErrorCodes: [100] },
    YOUTUBE_EMBED_FORBIDDEN: { message: "该 YouTube 视频不允许嵌入播放", iframeErrorCodes: [101, 150] },
    YOUTUBE_CLIENT_IDENTITY_REQUIRED: { message: "YouTube 无法确认嵌入客户端身份", iframeErrorCodes: [153] },
    YOUTUBE_API_UNAVAILABLE: { message: "YouTube 播放器接口加载失败，请检查浏览器网络或代理", iframeErrorCodes: [] },
    YOUTUBE_CONTROL_UNAVAILABLE: { message: "YouTube 播放器控制暂不可用", iframeErrorCodes: [] },
    YOUTUBE_UNKNOWN_ERROR: { message: "YouTube 播放器发生未知错误", iframeErrorCodes: [] },
  },
  // IFrame API errors cannot reliably identify a region restriction or network outage.
  distinguishesRegionRestriction: false,
  distinguishesNetworkFailure: false,
} as const;

export type YouTubePlaybackCapabilities = typeof YOUTUBE_PLAYBACK_CAPABILITIES;
export type YouTubePlaybackErrorCode = keyof YouTubePlaybackCapabilities["errors"];
export type YouTubePlaybackState = YouTubePlaybackCapabilities["states"][number];

export type PlaylistItem = {
  id: string;
  media: MediaSource;
  addedByClientId: string;
  addedAtMs: number;
};

export type RoomSnapshot = {
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
};

export type ClientType = "browser" | "mpv" | "desktop";

export type RoomMember = {
  clientId: string;
  name: string;
  isOwner: boolean;
  clientType: ClientType;
};

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
  | "OWNER_TARGET_OFFLINE"
  | "HANDOFF_TICKET_INVALID"
  | "PROTOCOL_VERSION_MISMATCH"
  | "SESSION_GENERATION_STALE"
  | "CAPABILITY_UNAVAILABLE"
  | "AUTH_REQUIRED"
  | "AUTH_REJECTED"
  | "ROOM_PIN_REQUIRED"
  | "ROOM_PIN_REJECTED"
  | "GUEST_TOKEN_INVALID"
  | "GUEST_TOKEN_EXPIRED"
  | "GUEST_FORBIDDEN"
  | "GUEST_RATE_LIMITED"
  | "SUBTITLE_TOO_LARGE"
  | "SUBTITLE_FORMAT_UNSUPPORTED"
  | "SUBTITLE_NOT_FOUND"
  | "SUBTITLE_OWNER_ONLY"
  | "SUBTITLE_TRACKS_FULL";

export type ApiError = { code: ErrorCode | string; message: string };

export type CommandAck<T = undefined> =
  { ok: true; revision: number; data?: T } | { ok: false; error: ApiError };

export type CommandInput = { expectedRevision: number };

export interface ClientToServerEvents {
  "CMD:name": (
    payload: { name: string },
    ack: (result: CommandAck) => void,
  ) => void;
  "CMD:clockSync": (
    payload: { clientSentAtMs: number },
    ack: (result: CommandAck<{ serverTimeMs: number }>) => void,
  ) => void;
  "CMD:play": (
    payload: CommandInput,
    ack: (result: CommandAck) => void,
  ) => void;
  "CMD:pause": (
    payload: CommandInput,
    ack: (result: CommandAck) => void,
  ) => void;
  "CMD:seek": (
    payload: CommandInput & { positionSeconds: number },
    ack: (result: CommandAck) => void,
  ) => void;
  "CMD:rate": (
    payload: CommandInput & { rate: number },
    ack: (result: CommandAck) => void,
  ) => void;
  "CMD:loop": (
    payload: CommandInput & { loop: boolean },
    ack: (result: CommandAck) => void,
  ) => void;
  "CMD:lock": (
    payload: CommandInput & { locked: boolean },
    ack: (result: CommandAck) => void,
  ) => void;
  "CMD:mediaSet": (
    payload: CommandInput & { media: MediaSource },
    ack: (result: CommandAck) => void,
  ) => void;
  "CMD:playlistAdd": (
    payload: CommandInput & { media: MediaSource },
    ack: (result: CommandAck) => void,
  ) => void;
  "CMD:playlistRemove": (
    payload: CommandInput & { itemId: string },
    ack: (result: CommandAck) => void,
  ) => void;
  "CMD:playlistMove": (
    payload: CommandInput & { itemId: string; targetIndex: number },
    ack: (result: CommandAck) => void,
  ) => void;
  "CMD:playlistPlay": (
    payload: CommandInput & { itemId: string },
    ack: (result: CommandAck) => void,
  ) => void;
  "CMD:playlistNext": (
    payload: CommandInput,
    ack: (result: CommandAck) => void,
  ) => void;
  "CMD:playlistAutoNext": (
    payload: CommandInput & { expectedCurrentPlaylistItemId?: string },
    ack: (result: CommandAck) => void,
  ) => void;
  "CMD:transferOwner": (
    payload: CommandInput & { targetClientId: string },
    ack: (result: CommandAck) => void,
  ) => void;
}

export interface ServerToClientEvents {
  "REC:snapshot": (snapshot: RoomSnapshot) => void;
  "REC:members": (members: RoomMember[]) => void;
  "REC:ownerToken": (ownerToken: string) => void;
  "REC:error": (error: ApiError) => void;
}

export type InterServerEvents = Record<string, never>;
export type SocketData = {
  roomId: string;
  clientId: string;
  accessToken: string;
  ownerToken?: string;
  nickname: string;
  /** Protocol version sent by the client during handshake (spec 9.1). */
  clientProtocol?: number;
};

export type CoreServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export const PROTOCOL_VERSION = 2 as const;
export const DESKTOP_SERVICE_VERSION = "0.1.0" as const;

export const DESKTOP_CAPABILITIES = {
  createRoom: true,
  joinRoom: true,
  restoreSession: true,
  mediaSearch: true,
  mediaQueue: true,
  handoffCode: true,
  readiness: true,
} as const;

export type DesktopCapabilities = typeof DESKTOP_CAPABILITIES;

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_REQUEST: "请求参数无效",
  ROOM_NOT_FOUND: "房间不存在或已解散",
  INVALID_PIN: "PIN 码错误",
  RATE_LIMITED: "PIN 尝试次数过多，请稍后重试",
  ACCESS_TOKEN_INVALID: "访问凭据已失效",
  OWNER_TOKEN_INVALID: "房主凭据已失效",
  FORBIDDEN: "只有房主可以执行此操作",
  OPENLIST_UNAVAILABLE: "OpenList 媒体服务暂时不可用",
  MEDIA_NOT_FOUND: "媒体不存在或已下架",
  MEDIA_UNSUPPORTED: "该媒体格式不受支持",
  PLAYLIST_FULL: "播放列表已达到 200 项上限",
  REVISION_CONFLICT: "房间状态已更新，请重新同步后重试",
  OWNER_TARGET_OFFLINE: "目标成员当前不在线",
  HANDOFF_TICKET_INVALID: "交接票据无效、已使用或已过期，请重新发射",
  PROTOCOL_VERSION_MISMATCH: "客户端协议版本不兼容，请升级客户端",
  SESSION_GENERATION_STALE: "桌面会话已被新的连接取代，请重新声明会话",
  CAPABILITY_UNAVAILABLE: "当前服务不支持所需的桌面能力",
  AUTH_REQUIRED: "需要房间鉴权",
  AUTH_REJECTED: "房间鉴权失败",
  ROOM_PIN_REQUIRED: "加入该房间需要 PIN 码",
  ROOM_PIN_REJECTED: "PIN 码错误",
  GUEST_TOKEN_INVALID: "游客凭据无效，请重新获取",
  GUEST_TOKEN_EXPIRED: "游客凭据已过期，请重新获取",
  GUEST_FORBIDDEN: "游客凭据只能只读浏览媒体库",
  GUEST_RATE_LIMITED: "游客凭据获取过于频繁，请稍后重试",
  SUBTITLE_TOO_LARGE: "字幕内容超过 512KB 上限",
  SUBTITLE_FORMAT_UNSUPPORTED: "只支持 srt / vtt / ass / ssa 文本字幕",
  SUBTITLE_NOT_FOUND: "字幕不存在或已被删除",
  SUBTITLE_OWNER_ONLY: "只有房主可以删除字幕",
  SUBTITLE_TRACKS_FULL: "该媒体的上传字幕已达上限，请先删除不再需要的",
};

export function errorResult(code: ErrorCode): { ok: false; error: ApiError } {
  return { ok: false, error: { code, message: ERROR_MESSAGES[code] } };
}

export function okResult(revision: number): CommandAck {
  return { ok: true, revision };
}

export function isValidUUID(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
