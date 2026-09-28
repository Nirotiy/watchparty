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
export type ClientType = "browser" | "mpv" | "desktop";

export interface RoomMember {
  clientId: string;
  name: string;
  isOwner: boolean;
  clientType: ClientType;
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
  | "OWNER_TARGET_OFFLINE"
  | "SESSION_GENERATION_STALE";

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

// 9. 媒体库（多源 phase 1）：库、能力位与目录页
export type MediaLibraryKind = "anime" | "movie" | "tv" | "other";

export type MediaLibraryHealth =
  | "ok"
  | "unreachable"
  | "auth_failed"
  | "root_missing"
  | "not_configured";

export interface MediaLibrary {
  id: string;
  name: string;
  kind: MediaLibraryKind;
  sourceId: string;
  sourceName: string;
  health: MediaLibraryHealth;
}

export interface MediaCapabilities {
  libraries: boolean;
  artwork: boolean;
  catalog: boolean;
  mediaAdmin: boolean;
}

export type CompatibilityStatus = "supported" | "maybe" | "unsupported";

export interface MediaCompatibility {
  browser: CompatibilityStatus;
  desktop: CompatibilityStatus;
  browserReason?: string;
  desktopReason?: string;
}

export interface MediaLibraryItem {
  id: string;
  name: string;
  type: "file" | "dir";
  size?: number;
  extension?: string;
  compatibility: MediaCompatibility;
  /** 库根下的相对路径：只用来导航与显示，永远不塞进播放源。 */
  relativePath?: string;
  posterId?: string;
}

export interface MediaBreadcrumb {
  name: string;
  path: string;
}

export interface MediaLibraryPage {
  libraryId: string;
  currentPath: string;
  breadcrumbs: MediaBreadcrumb[];
  hasMore: boolean;
  nextCursor?: string;
  items: MediaLibraryItem[];
  /** 本目录自己的封面（目录里有 poster.jpg 时才有） */
  posterId?: string;
}

// 10.（相位 3）标题库：目录条目与候选
export type CatalogStatus = "unmatched" | "candidate" | "confirmed" | "rejected";

export interface CatalogCard {
  id: string;
  title: string;
  year: number | null;
  kind: MediaLibraryKind;
  status: CatalogStatus;
  /** 有值表示后端缓存过海报；地址由客户端按 id 拼成 /api/media/posters/<id>。 */
  posterUrl: string | null;
  subtitle: string | null;
}

export interface CatalogChild {
  mediaId: string;
  name: string;
  season: number | null;
  episode: number | null;
  /** 文件真正所在的子目录（相对库根）：番剧的 episode 几乎全是 null，分节只能靠它。 */
  relDir?: string;
  /** 后端从文件名算出来的可播性；旧后端没有这个字段（缺字段 = 放行）。 */
  compatibility?: MediaCompatibility;
}

export interface CatalogCandidate {
  id: string;
  title: string;
  year: number | null;
  score: number;
}

export interface CatalogDetail extends CatalogCard {
  /** 正式卡的身份键：与草稿行靠它对齐（§9）。 */
  itemKey?: string;
  originalTitle: string | null;
  overview: string | null;
  candidates: CatalogCandidate[];
  children: CatalogChild[];
  /** 绑定来源：manual/rebind 是人选的，自动流程不再改写。 */
  confirmedBy?: "auto" | "manual" | "rebind" | "unknown" | null;
}

export interface CatalogPage {
  items: CatalogCard[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface ScrapeJob {
  libraryId: string;
  status: "running" | "done" | "failed";
  total: number;
  scanned: number;
  matched: number;
  lastError: string | null;
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

// 12. MPV 交接票据（POST /api/rooms/:roomId/handoff，spec 9.2）
export interface HandoffTicketResponse {
  ticket: string;
  ticketExpiresAt: number;
  target?: "mpv" | "desktop";
}

// 13. 草稿审阅与应用（第 4 块，2026-09-28）：scan → classify → judge → apply。
// 前三段只写 catalog_draft，正式卡一行不动；apply 是唯一落库动作。形状见
// watchparty/temp-html/library-catalog-draft-ui-handoff.md §2/§3。
export interface DraftCandidate {
  externalDb: string;
  externalId: string;
  title: string;
  originalTitle: string | null;
  year: number | null;
  score: number;
}

/** 草稿卡下的一个文件（只出现在 `?item=` 子请求里）。 */
export interface DraftChild {
  mediaId: string;
  name: string;
  season: number | null;
  episode: number | null;
  relativePath: string;
}

export interface DraftItem {
  itemKey: string;
  query: string;
  rawName: string;
  subtitle: string | null;
  files: number;
  rev: number;
  status: CatalogStatus;
  lookupState: "pending" | "done" | "error";
  title: string | null;
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  externalDb: string | null;
  externalId: string | null;
  confirmedBy: "auto" | "manual" | "rebind" | "unknown" | null;
  posterUrl: string | null;
  /** 列表投影不再带 candidates（后端 2026-09-28 把候选挪进 ?item=）；这两个扁平字段给表格排序用。 */
  candidateCount: number;
  topScore: number | null;
  /**
   * 这一张草稿当前**承接**谁的下发键位（§9 keep-binding）：null = 没有承接关系，
   * 非空时值就是承接方的 itemKey。apply 确认框下拉的当前值读它；
   * diff 里的 `keepsBindingOnKey` 是 apply 预览的推算结果，平时一致、改完未刷新时会分叉。
   */
  carriesKey: string | null;
}

/** 展开单张：GET .../classify?item=<itemKey>（列表投影不含 children）。 */
export interface DraftCardDetail {
  libraryId: string;
  card: DraftItem;
  children: DraftChild[];
  /** 候选跟 children 一起从 ?item= 返回。 */
  candidates: DraftCandidate[];
}

/** 409 的响应体带数据（§8.3）。 */
export interface DraftErrorData {
  pending?: number;
  draftCards?: number;
  draftRev?: number;
  scanRev?: number;
}

/** 阈值由服务端下发（§8.5）。 */
export interface DraftThresholds {
  autoScore: number;
  autoGap: number;
  candidateScore: number;
  variantCap: number;
}

export interface DraftDiffItem {
  id: string;
  itemKey: string;
  title?: string;
  query?: string;
  files?: number | { from: number; to: number };
  fromKey?: string;
  /** 劈卡：这张新卡从哪张正式卡接走文件、接走几个（权威字段，2026-09-28 §8.3）。 */
  splitFromKey?: string | null;
  fromFiles?: number;
}

/** changed 的形状与 confirmedDrift 不同：from/to 各自带 title 与 subtitle。 */
export interface DraftChangedItem {
  id: string;
  itemKey: string;
  from: { title: string; subtitle: string | null };
  to: { title: string; subtitle: string | null };
  /** 这张卡的文件被哪些草稿卡接走了（劈卡；空数组=没劈）。 */
  splitIntoKeys: string[];
  /** 应用后人的绑定跟着哪一份草稿走（含自己）。 */
  keepsBindingOnKey: string;
}

/** 已确认卡漂移：subtitle 可能不变而 files 变，两个都要展示。 */
export interface DraftDriftItem {
  id: string;
  itemKey: string;
  title: string;
  subtitle: { from: string | null; to: string | null };
  files: { from: number; to: number };
  /** 这张卡的文件被哪些草稿卡接走了（劈卡；空数组=没劈）。 */
  splitIntoKeys: string[];
  /** 应用后人的绑定跟着哪一份草稿走（含自己；人合并过的卡重分类会拆成几份）。 */
  keepsBindingOnKey: string;
}

export interface DraftDiff {
  added: DraftDiffItem[];
  dropped: DraftDiffItem[];
  moved: DraftDiffItem[];
  changed: DraftChangedItem[];
  confirmedDrift: DraftDriftItem[];
  unchanged: number;
  autoConfirmed: number;
  draftCards: number;
  formalCards: number;
}

export interface DraftState {
  libraryId: string;
  cards: number;
  files: number;
  pending: number;
  classifiedAt: string | null;
  thresholds: DraftThresholds | null;
  scan: { files: number; enumeratedAt: string | null; rev: number } | null;
  draft: DraftItem[];
  diff: DraftDiff | null;
}

export interface DraftJudgeResult {
  libraryId: string;
  kind: string;
  judged: number;
  confirmed: number;
  pending: number;
  /** 本批判定过的 itemKey（表格只刷这几行）。 */
  items: string[];
  diff: DraftDiff | null;
}

export interface DraftApplyResult {
  libraryId: string;
  cards: number;
  created: number;
  updated: number;
  skipped: number;
  deferred: number;
  posters: number;
  /** 本次按 keep-binding 搬走了几张绑定（§9）。 */
  transferred?: number;
}

// 14. 草稿编辑（§9 的六个接口）
export type DraftEditReason =
  | "no-candidate"
  | "unknown-candidate"
  | "nothing-to-split"
  | "bad-carrier"
  | "bad-keep-list"
  | "unknown-media";

/** `GET /api/media/bangumi/search?q=` 的一条命中（草稿换条目与正式卡换绑共用）。 */
export interface BangumiHit {
  externalDb: "bangumi" | "tmdb";
  externalId: string;
  title: string;
  originalTitle?: string | null;
  year?: number | null;
  episodes?: number | null;
  imageUrl?: string | null;
}

/** 统一返回：与 classify 的摘要同形（card 是列表投影那一行）。 */
export interface DraftEditResult {
  libraryId: string;
  card: DraftItem;
  cards: number;
  files: number;
  pending: number;
  diff: DraftDiff;
  /** 仅 split：新建出来的草稿键。 */
  createdKeys?: string[];
}

export interface DraftEditInput {
  itemKey: string;
  title?: string;
  originalTitle?: string | null;
  year?: number | null;
  overview?: string | null;
  posterUrl?: string | null;
  externalDb?: "bangumi" | "tmdb" | null;
  externalId?: string | null;
}
