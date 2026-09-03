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
  AllowedOpenListRoot,
  OpenListDirectory,
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

  // 4. 获取 OpenList 根目录列表 (仅依赖 Caddy Basic Auth，无需房间 Token)
  getMediaRoots: (): Promise<AllowedOpenListRoot[]> =>
    request<AllowedOpenListRoot[]>("/api/media/roots"),

  // 5. 获取 OpenList 目录列表 (分页模式，单页上限 100 项)
  getMediaList: (
    root: AllowedOpenListRoot,
    path = "/",
    cursor?: string,
  ): Promise<OpenListDirectory> => {
    const params = new URLSearchParams({ root, path });
    if (cursor) params.set("cursor", cursor);
    return request<OpenListDirectory>(`/api/media/list?${params.toString()}`);
  },

  // 6. 全局搜索媒体 (分页模式)
  searchMedia: (
    query: string,
    root?: AllowedOpenListRoot,
    cursor?: string,
  ): Promise<OpenListDirectory> => {
    const params = new URLSearchParams({ q: query });
    if (root) params.set("root", root);
    if (cursor) params.set("cursor", cursor);
    return request<OpenListDirectory>(`/api/media/search?${params.toString()}`);
  },

  // 7. 解析临时 HTTPS 播放直链 (需 accessToken)
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
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ mediaId }),
    }),

  // 8. 获取字幕文本内容 (需 accessToken)
  getSubtitleContent: async (
    roomId: string,
    mediaId: string,
    accessToken: string,
  ): Promise<string> => {
    const res = await fetch(
      `/api/rooms/${encodeURIComponent(roomId)}/media/subtitle?mediaId=${encodeURIComponent(mediaId)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );
    if (!res.ok) {
      throw new Error(`无法获取字幕: HTTP ${res.status}`);
    }
    return res.text();
  },

  // 9. Discover subtitle files associated with a media item.
  getSubtitleTracks: (
    roomId: string,
    mediaId: string,
    accessToken: string,
  ): Promise<SubtitleTrack[]> =>
    request<SubtitleTrack[]>(
      `/api/rooms/${encodeURIComponent(roomId)}/media/subtitles?mediaId=${encodeURIComponent(mediaId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    ),

  // 10. 签发一次性 MPV 交接票据（120s TTL，spec 9.2；页面只展示交接码，不进 URL）
  issueHandoffTicket: (
    roomId: string,
    accessToken: string,
    target: "mpv" | "desktop" = "mpv",
  ): Promise<HandoffTicketResponse> =>
    request<HandoffTicketResponse>(
      `/api/rooms/${encodeURIComponent(roomId)}/handoff`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ target }),
      },
    ),
};
