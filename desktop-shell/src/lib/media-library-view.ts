import type { MediaCompatibility, MediaDirectoryItem, MediaDirectoryPage } from "@/lib/contracts"
import type { MediaLibraryItem, MediaLibraryPage } from "@/lib/ipc"

/**
 * View model shared by the folder browser (phase 1) and the title wall (phase 3):
 * one card shape, two data sources. Keep this layer pure so it is unit-testable —
 * the React view above it only renders.
 */
export interface MediaCard {
  id: string
  title: string
  subtitle: string
  imageUrl: string | null
  badge: string | null
  kind: "dir" | "file"
  /** Path under the library root; safe to display, never played. */
  relativePath: string
  /** Raw extension, used as the container hint when playing. */
  extension: string
  playable: boolean
  /** Why play/enqueue are blocked; null when playable. */
  note: string | null
  /** 两端都不支持的普通文件（.nfo/.jpg/.ass…）：默认不进文件视图。 */
  nonMedia: boolean
}

export interface MediaCrumb { name: string; path: string }

export interface MediaView {
  currentPath: string
  crumbs: MediaCrumb[]
  hasMore: boolean
  nextCursor: string | null
  cards: MediaCard[]
  /** Cover of the directory itself (phase 2); null when the folder has no poster file. */
  posterUrl: string | null
}

const KIND_LABEL: Record<string, string> = { anime: "番剧", movie: "电影", tv: "剧集", other: "其他" }

export function libraryKindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind
}

/**
 * Can the desktop client play this? A missing `compatibility` is legacy data and stays
 * playable; a value that is present but not `supported` blocks play — which also covers
 * an enum this client does not know yet (the backend is changing those values).
 */
export function desktopPlayable(compatibility?: MediaCompatibility | null): boolean {
  return compatibility?.desktop == null || compatibility.desktop === "supported"
}

/** Directories are opened, never played, so they are always actionable. */
export function toCard(
  item: Pick<MediaLibraryItem, "id" | "name" | "type" | "extension" | "relativePath" | "compatibility" | "posterId">,
  resolveArtwork?: (posterId: string) => string | null,
): MediaCard {
  const isDir = item.type === "dir"
  const playable = isDir || desktopPlayable(item.compatibility)
  return {
    id: item.id,
    title: item.name,
    subtitle: isDir ? "文件夹" : item.extension ? item.extension.toUpperCase() : "",
    imageUrl: item.posterId && resolveArtwork ? resolveArtwork(item.posterId) : null,
    badge: playable ? null : "桌面端不可播",
    kind: item.type,
    relativePath: item.relativePath ?? "",
    extension: item.extension ?? "",
    playable,
    note: playable ? null : item.compatibility?.desktopReason?.trim() || "桌面端无法播放这个文件（浏览器可能可以）",
    // 两端都 unsupported 才是"不是视频"；maybe（需转码的封装）仍然留在列表里。
    nonMedia: !isDir && item.compatibility?.desktop === "unsupported" && item.compatibility?.browser === "unsupported",
  }
}

/** 文件视图默认藏掉非视频文件，可一键显示（用户的 2026-09-26 裁决）。 */
export function visibleCards(cards: MediaCard[], showAll: boolean): MediaCard[] {
  return showAll ? cards : cards.filter(card => !card.nonMedia)
}

export function hiddenCardCount(cards: MediaCard[]): number {
  return cards.filter(card => card.nonMedia).length
}

/** The new library route: breadcrumbs already carry their own paths. */
export function toView(page: MediaLibraryPage, resolveArtwork?: (posterId: string) => string | null): MediaView {
  return {
    currentPath: page.currentPath,
    crumbs: (page.breadcrumbs ?? []).map(crumb => ({ name: crumb.name, path: crumb.path })),
    hasMore: Boolean(page.hasMore),
    nextCursor: page.nextCursor ?? null,
    cards: (page.items ?? []).map(item => toCard(item, resolveArtwork)),
    posterUrl: page.posterId && resolveArtwork ? resolveArtwork(page.posterId) : null,
  }
}

/**
 * The legacy `root=` route answers with names only, so the path is rebuilt by joining
 * them. This adapter disappears with the route (one week after both clients ship).
 */
export function legacyView(page: MediaDirectoryPage, fallbackPath: string): MediaView {
  const names = page.breadcrumbs ?? []
  return {
    currentPath: page.currentPath || fallbackPath,
    // 旧路由只给名字，路径按名字拼（与 media-library-navigation 的 breadcrumbPath 同一算法，
    // 这里就地写一遍是为了让本文件零运行时依赖，单测可以直接 transpile 后 import）。
    crumbs: names.map((name, index) => ({ name, path: `/${names.slice(0, index + 1).join("/")}` })),
    hasMore: Boolean(page.hasMore),
    nextCursor: page.nextCursor ?? null,
    cards: (page.items ?? []).map((item: MediaDirectoryItem) => toCard({
      id: item.id,
      name: item.name,
      type: item.type,
      extension: item.extension ?? null,
      relativePath: item.displayPath ?? "",
      compatibility: item.compatibility,
    })),
    // 旧路由没有封面字段。
    posterUrl: null,
  }
}

const LIBRARY_HEALTH_LABEL: Record<string, string> = {
  ok: "可用",
  unreachable: "连不上",
  auth_failed: "鉴权失败",
  root_missing: "路径不存在",
  not_configured: "未配置",
}

export function healthLabel(health: string): string {
  return LIBRARY_HEALTH_LABEL[health] ?? health
}

/** Chinese copy for the codes the media routes emit (frozen list, handoff §2 F4). */
const ERROR_TEXT: Record<string, string> = {
  OPENLIST_UNAVAILABLE: "源站暂时不可用，稍后重试",
  SOURCE_UNREACHABLE: "连不上这个源，检查地址或网络后重试",
  SOURCE_AUTH_FAILED: "源站拒绝了凭据，检查用户名与密码",
  SOURCE_NOT_CONFIGURED: "这个源还没配置好",
  LIBRARY_ROOT_NOT_FOUND: "这个库的路径在源站上不存在",
  MEDIA_NOT_FOUND: "文件已经不在了，刷新一下",
  MEDIA_UNSUPPORTED: "这个文件两端都放不了",
  MEDIA_ID_KEY_EPHEMERAL: "媒体 ID 密钥是临时的，服务端配置固定密钥后才能保存源",
  INVALID_REQUEST: "有点字段不合法：检查名称、地址与库路径（路径要以 / 开头）",
  CATALOG_UNAVAILABLE: "标题库还没准备好",
  MATCH_NOT_FOUND: "没有匹配结果",
  ADMIN_FORBIDDEN: "只有本机或管理员能修改媒体源",
  MEDIA_ROUTE_DENIED: "客户端不允许访问这个媒体接口",
  AUTH_REJECTED: "站点鉴权失败，请检查已保存的站点凭据",
  AUTH_REQUIRED: "服务需要站点鉴权",
  NETWORK_ERROR: "网络暂时不可用",
  CONNECTION_REFUSED: "服务未启动或端口不对",
  DNS_FAILED: "无法解析服务地址",
  TLS_TRUST_REQUIRED: "服务证书不受信任，请确认来源信任",
}

/** Map a code to Chinese; fall back to the caller's sentence when the code is unknown. */
export function mediaErrorText(error: unknown, fallback: string): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : ""
  return ERROR_TEXT[code] ?? fallback
}
