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

export type RoomMember = {
  clientId: string;
  name: string;
  isOwner: boolean;
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
  | "OWNER_TARGET_OFFLINE";

export type ApiError = { code: ErrorCode | string; message: string };

export type CommandAck<T = undefined> =
  | { ok: true; revision: number; data?: T }
  | { ok: false; error: ApiError };

export type CommandInput = { expectedRevision: number };

export interface ClientToServerEvents {
  "CMD:name": (payload: { name: string }, ack: (result: CommandAck) => void) => void;
  "CMD:clockSync": (
    payload: { clientSentAtMs: number },
    ack: (result: CommandAck<{ serverTimeMs: number }>) => void,
  ) => void;
  "CMD:play": (payload: CommandInput, ack: (result: CommandAck) => void) => void;
  "CMD:pause": (payload: CommandInput, ack: (result: CommandAck) => void) => void;
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
  "CMD:playlistNext": (payload: CommandInput, ack: (result: CommandAck) => void) => void;
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
};

export type CoreServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_REQUEST: "请求参数无效",
  ROOM_NOT_FOUND: "房间不存在或已解散",
  INVALID_PIN: "PIN 码错误",
  RATE_LIMITED: "PIN 尝试次数过多，请稍后重试",
  ACCESS_TOKEN_INVALID: "访问凭据已失效",
  OWNER_TOKEN_INVALID: "房主凭据已失效",
  FORBIDDEN: "当前房间锁定，只有房主可以执行此操作",
  OPENLIST_UNAVAILABLE: "OpenList 媒体服务暂时不可用",
  MEDIA_NOT_FOUND: "媒体不存在或已下架",
  MEDIA_UNSUPPORTED: "该媒体格式不受支持",
  PLAYLIST_FULL: "播放列表已达到 200 项上限",
  REVISION_CONFLICT: "房间状态已更新，请重新同步后重试",
  OWNER_TARGET_OFFLINE: "目标成员当前不在线",
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
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
