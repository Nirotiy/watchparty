/**
 * WatchParty 前端 HTTP API 客户端适配层
 * 严格按照 UNIVERSAL_ALIGNMENT_SPEC.md 规范实现
 */

import {
  CreateRoomRequest,
  CreateRoomResponse,
  RoomInfoResponse,
  RoomAccessRequest,
  RoomAccessResponse,
  MediaCapabilities,
  MediaLibrary,
  MediaLibraryPage,
  SubtitleTrack,
  HandoffTicketResponse,
} from "./contracts";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    let errBody: { code?: string; message?: string } = {};
    try {
      errBody = await res.json();
    } catch {
      errBody = {
        code: "HTTP_ERROR",
        message: `HTTP ${res.status}: ${res.statusText}`,
      };
    }
    const error = new Error(errBody.message || "请求失败");
    (error as Error & { code?: string; status?: number }).code = errBody.code;
    (error as Error & { code?: string; status?: number }).status = res.status;
    throw error;
  }

  return res.json() as Promise<T>;
}

export const api = {
  // 1. 创建房间 (带 clientId 与可选 pin)
  createRoom: (req: CreateRoomRequest): Promise<CreateRoomResponse> =>
    request<CreateRoomResponse>("/api/rooms", {
      method: "POST",
      body: JSON.stringify(req),
    }),

  // 2. 检查房间是否存在及门禁状态 (200 OK 或 404 ROOM_NOT_FOUND)
  getRoomInfo: (roomId: string): Promise<RoomInfoResponse> =>
    request<RoomInfoResponse>(`/api/rooms/${encodeURIComponent(roomId)}`),

  // 3. 房间准入并获取 accessToken (免密或输入 PIN)
  accessRoom: (
    roomId: string,
    req: RoomAccessRequest,
  ): Promise<RoomAccessResponse> =>
    request<RoomAccessResponse>(
      `/api/rooms/${encodeURIComponent(roomId)}/access`,
      {
        method: "POST",
        body: JSON.stringify(req),
      },
    ),

  // 4. 媒体库能力位（`libraries` 为真才走 libraryId 路由）
  getMediaCapabilities: (): Promise<MediaCapabilities> =>
    request<MediaCapabilities>("/api/media/capabilities"),

  // 5. 库列表：顺序按服务端返回，客户端不排序
  getMediaLibraries: (): Promise<MediaLibrary[]> =>
    request<{ libraries: MediaLibrary[] }>("/api/media/libraries").then(
      (res) => res.libraries ?? [],
    ),

  // 6. 库内目录列表（分页模式，单页上限 100 项）
  getMediaList: (
    libraryId: string,
    path = "/",
    cursor?: string,
  ): Promise<MediaLibraryPage> => {
    const params = new URLSearchParams({ libraryId, path });
    if (cursor) params.set("cursor", cursor);
    return request<MediaLibraryPage>(`/api/media/list?${params.toString()}`);
  },

  // 7. 库内文件名搜索（分页模式；cursor 是服务端给的十进制偏移，原样回传）
  searchMedia: (
    query: string,
    libraryId: string,
    cursor?: string,
  ): Promise<MediaLibraryPage> => {
    const params = new URLSearchParams({ q: query, libraryId });
    if (cursor) params.set("cursor", cursor);
    return request<MediaLibraryPage>(`/api/media/search?${params.toString()}`);
  },

  // 8. 解析临时 HTTPS 播放直链 (需 accessToken)
  resolveMedia: (
    roomId: string,
    mediaId: string,
    accessToken: string,
  ): Promise<{
    url: string;
    expiresAt?: number;
    requiresCustomHeaders?: boolean;
  }> =>
    request<{
      url: string;
      expiresAt?: number;
      requiresCustomHeaders?: boolean;
    }>(`/api/rooms/${encodeURIComponent(roomId)}/media/resolve`, {
      method: "POST",
      headers: {
        "X-WatchParty-Token": accessToken,
      },
      body: JSON.stringify({ mediaId }),
    }),

  // 9. 获取字幕文本内容 (需 accessToken)
  getSubtitleContent: async (
    roomId: string,
    mediaId: string,
    accessToken: string,
  ): Promise<string> => {
    const res = await fetch(
      `/api/rooms/${encodeURIComponent(roomId)}/media/subtitle?mediaId=${encodeURIComponent(mediaId)}`,
      {
        headers: {
          "X-WatchParty-Token": accessToken,
        },
      },
    );
    if (!res.ok) {
      throw new Error(`无法获取字幕: HTTP ${res.status}`);
    }
    return res.text();
  },

  // 10. Discover subtitle files associated with a media item.
  getSubtitleTracks: (
    roomId: string,
    mediaId: string,
    accessToken: string,
  ): Promise<SubtitleTrack[]> =>
    request<SubtitleTrack[]>(
      `/api/rooms/${encodeURIComponent(roomId)}/media/subtitles?mediaId=${encodeURIComponent(mediaId)}`,
      { headers: { "X-WatchParty-Token": accessToken } },
    ),

  // 11. 签发一次性 native 交接票据（5 分钟 TTL；交接码不进 URL）
  issueHandoffTicket: (
    roomId: string,
    accessToken: string,
    target: "mpv" | "desktop" = "mpv",
  ): Promise<HandoffTicketResponse> =>
    request<HandoffTicketResponse>(
      `/api/rooms/${encodeURIComponent(roomId)}/handoff`,
      {
        method: "POST",
        headers: { "X-WatchParty-Token": accessToken },
        body: JSON.stringify({ target }),
      },
    ),
};
