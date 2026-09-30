/**
 * WatchParty 前端 HTTP API 客户端适配层
 * 严格按照 UNIVERSAL_ALIGNMENT_SPEC.md 规范实现
 */

import { refreshCatalog, type CatalogAccepted, type CatalogScan } from "../../desktop-shell/shared/catalog-refresh";

import {
  CreateRoomRequest,
  CreateRoomResponse,
  RoomInfoResponse,
  RoomAccessRequest,
  RoomAccessResponse,
  CatalogDetail,
  CatalogPage,
  BangumiHit,
  CatalogApprovalIssue,
  CatalogApprovalLedgerRow,
  CatalogRollbackResult,
  DraftApplyResult,
  DraftCardDetail,
  DraftEditInput,
  DraftEditResult,
  DraftJudgeResult,
  DraftState,
  MediaCapabilities,
  MediaLibrary,
  MediaLibraryPage,
  ScrapeJob,
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
    // 错误体原样带上：批准门的 409 要读 structural / reason / keys（§10.1）。
    (error as Error & { data?: unknown }).data = errBody;
    throw error;
  }

  return res.json() as Promise<T>;
}

export const api = {
  approvalSecretStatus: (): Promise<{ configured: boolean; mask: string | null }> => request("/api/catalog-approval/settings"),
  setApprovalSecret: (secret: string): Promise<{ configured: boolean; mask: string | null }> => request("/api/catalog-approval/settings", { method: "POST", body: JSON.stringify({ secret }) }),
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

  // 7b.（相位 3）标题库：条目列表 / 详情 / 候选写入 / 刮削状态
  getCatalog: (libraryId: string, cursor?: string, q?: string): Promise<CatalogPage> => {
    const params = new URLSearchParams({ libraryId });
    if (cursor) params.set("cursor", cursor);
    if (q) params.set("q", q);
    return request<CatalogPage>(`/api/media/catalog?${params.toString()}`);
  },

  getCatalogItem: (id: string): Promise<CatalogDetail> =>
    request<CatalogDetail>(`/api/media/catalog/${encodeURIComponent(id)}`),

  confirmCatalogItem: (id: string, candidateId: string): Promise<CatalogDetail> =>
    request<CatalogDetail>(`/api/media/catalog/${encodeURIComponent(id)}/confirm`, {
      method: "POST",
      body: JSON.stringify({ candidateId }),
    }),

  rejectCatalogItem: (id: string, candidateId: string): Promise<CatalogDetail> =>
    request<CatalogDetail>(`/api/media/catalog/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      body: JSON.stringify({ candidateId }),
    }),

  // 草稿审阅（第 4 块）：读草稿 / 重新分类 / 分批判定 / 应用 / 只扫描。
  getDraft: (libraryId: string): Promise<DraftState> =>
    request<DraftState>(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/classify`),

  getDraftCard: (libraryId: string, itemKey: string): Promise<DraftCardDetail> =>
    request<DraftCardDetail>(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/classify?item=${encodeURIComponent(itemKey)}`),

  classifyDraft: (libraryId: string): Promise<DraftState> =>
    refreshCatalog(() => api.getDraft(libraryId),
      () => request<CatalogAccepted | { status: "done"; running: false }>(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/classify`, { method: "POST" }),
      (current, before) => current.classifiedAt !== null && current.classifiedAt !== before.classifiedAt),

  judgeDraft: (libraryId: string, max: number): Promise<DraftJudgeResult> =>
    request<DraftJudgeResult>(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/judge?max=${max}`, { method: "POST" }),

  applyDraft: (libraryId: string, force = false): Promise<DraftApplyResult> =>
    request<DraftApplyResult>(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/apply${force ? "?force=1" : ""}`, { method: "POST" }),

  // 草稿编辑（§9 的六个接口）：只写草稿、身份用 itemKey。
  editDraft: (libraryId: string, input: DraftEditInput): Promise<DraftEditResult> =>
    request<DraftEditResult>(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/draft/edit`, { method: "POST", body: JSON.stringify(input) }),

  confirmDraft: (libraryId: string, input: { itemKey: string; externalDb?: string; externalId?: string }): Promise<DraftEditResult> =>
    request<DraftEditResult>(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/draft/confirm`, { method: "POST", body: JSON.stringify(input) }),

  unconfirmDraft: (libraryId: string, input: { itemKey: string }): Promise<DraftEditResult> =>
    request<DraftEditResult>(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/draft/unconfirm`, { method: "POST", body: JSON.stringify(input) }),

  mergeDraft: (libraryId: string, input: { keepKey: string; dropKeys: string[] }): Promise<DraftEditResult> =>
    request<DraftEditResult>(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/draft/merge`, { method: "POST", body: JSON.stringify(input) }),

  splitDraft: (libraryId: string, input: { itemKey: string; keep: string[] }): Promise<DraftEditResult> =>
    request<DraftEditResult>(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/draft/split`, { method: "POST", body: JSON.stringify(input) }),

  keepDraftBinding: (libraryId: string, input: { itemKey: string; keepsBindingOnKey: string }): Promise<DraftEditResult> =>
    request<DraftEditResult>(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/draft/keep-binding`, { method: "POST", body: JSON.stringify(input) }),

  /**
   * 批准门（§10.1/§11.1）：签发 / 带凭证应用 / 撤回 / 台账。
   * 明文 token 只在这里回一次，调用方拿到就立刻用掉，不落盘、不显示。
   */
  catalogApproval: (libraryId: string, input: { approvedBy?: string; rollbackOf?: string } = {}, mode: "secret" | "loopback-admin" = "secret"): Promise<CatalogApprovalIssue> =>
    request<CatalogApprovalIssue>(mode === "loopback-admin"
      ? `/api/admin/media-libraries/${encodeURIComponent(libraryId)}/approval`
      : `/api/catalog-approval/libraries/${encodeURIComponent(libraryId)}/approval`, { method: "POST", body: JSON.stringify(input) }),

  catalogApplyApproved: (libraryId: string, input: { approvalToken: string; force?: boolean }): Promise<DraftApplyResult> =>
    request<DraftApplyResult>(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/apply-approved`, { method: "POST", body: JSON.stringify(input) }),

  catalogRollback: (libraryId: string, input: { rollbackOf: string; approvalToken: string }): Promise<CatalogRollbackResult> =>
    request<CatalogRollbackResult>(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/rollback`, { method: "POST", body: JSON.stringify(input) }),

  catalogApprovals: (libraryId: string): Promise<{ libraryId: string; items: CatalogApprovalLedgerRow[] }> =>
    request<{ libraryId: string; items: CatalogApprovalLedgerRow[] }>(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/approvals`),

  /** 人工挑条目（刮削提不出正确条目时的出口）——草稿换条目与正式卡换绑共用这个搜索端点。 */
  bangumiSearch: (q: string): Promise<{ items: BangumiHit[] }> =>
    request<{ items: BangumiHit[] }>(`/api/media/bangumi/search?q=${encodeURIComponent(q)}`),

  scanLibrary: (libraryId: string): Promise<CatalogScan> =>
    refreshCatalog(() => request<CatalogScan>(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/scan`),
      () => request<CatalogScan | CatalogAccepted>(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/scan`, { method: "POST" }),
      (current, before) => current.rev > before.rev),

  getScrapeStatus: (libraryId: string): Promise<ScrapeJob> =>
    request<ScrapeJob>(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/scrape`),

  startScrape: (libraryId: string): Promise<ScrapeJob> =>
    request<ScrapeJob>(`/api/admin/media-libraries/${encodeURIComponent(libraryId)}/scrape`, { method: "POST" }),

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
