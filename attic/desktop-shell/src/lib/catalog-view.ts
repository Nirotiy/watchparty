import type { CatalogCandidate, CatalogCard, CatalogChild, CatalogDetail, CatalogPage, CatalogStatus } from "@/lib/ipc"
import type { MediaCompatibility } from "@/lib/contracts"
import { exclusionText } from "../../shared/catalog-exclusions.ts"

/**
 * View model for the title wall (phase 3). Pure on purpose: the React layer only renders,
 * and the unit test imports it without any transport dependencies.
 */
export interface WallCard {
  id: string
  title: string
  year: number | null
  /** Cover address, or null when the backend has no cached poster for this item. */
  posterUrl: string | null
  status: CatalogStatus
  statusLabel: string
  /** 集数摘要（后端给的中文串），null 时不显示。 */
  subtitle: string | null
  /** 待确认的条目不可播，卡片上给确认入口。 */
  needsReview: boolean
}

export interface WallChild {
  mediaId: string
  label: string
  title: string
  hasEpisodeTitle: boolean
  name: string
  /** 桌面端能不能播；缺 compatibility 的旧数据按可播处理。 */
  playable: boolean
  /** 不能播时的一句话（服务端的 desktopReason 优先）。 */
  note: string | null
}

export interface WallSeason {
  key: string
  title: string
  children: WallChild[]
}

export interface WallDetail {
  id: string
  title: string
  /** 绑定来源：人工选的一律受保护（自动流程不再改写）。 */
  source: { label: string; tone: "auto" | "manual" | "unknown" } | null
  year: number | null
  originalTitle: string | null
  overview: string | null
  status: CatalogStatus
  statusLabel: string
  posterUrl: string | null
  subtitle: string | null
  candidates: CatalogCandidate[]
  seasons: WallSeason[]
  /** 电影/单文件：children 只有一条，直接播它。 */
  single: boolean
}

export interface Wall {
  cards: WallCard[]
  hasMore: boolean
  nextCursor: string | null
}

const STATUS_LABEL: Record<CatalogStatus, string> = {
  confirmed: "已确认",
  candidate: "待确认",
  unmatched: "未匹配",
  rejected: "已拒绝",
}

export function catalogStatusLabel(status: CatalogStatus): string {
  return STATUS_LABEL[status] ?? status
}

/**
 * 没有海报的条目用「随机取色 + 首字」兜底（2026-09-26 mockup 的形态，产品负责人要求植入）：
 * 颜色由 id 决定，所以同一部片每次渲染、每台机器都是同一个色。
 */
export function posterHue(seed: string): number {
  let hash = 0
  for (const character of seed) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 360
  return hash
}

/** 卡上写的名字：图上已经写了，下面那行就不再重复。 */
export function titleInitial(title: string): string {
  return [...title.trim()][0] ?? "?"
}

export function wallCard(card: CatalogCard, resolvePoster: (itemId: string) => string | null): WallCard {
  return {
    id: card.id,
    title: card.title,
    year: card.year ?? null,
    posterUrl: card.posterUrl ? resolvePoster(card.id) : null,
    status: card.status,
    statusLabel: catalogStatusLabel(card.status),
    subtitle: card.subtitle ?? null,
    needsReview: card.status === "candidate",
  }
}

export function toWall(page: CatalogPage, resolvePoster: (itemId: string) => string | null): Wall {
  return {
    cards: (page.items ?? []).map(card => wallCard(card, resolvePoster)),
    hasMore: Boolean(page.hasMore),
    nextCursor: page.nextCursor ?? null,
  }
}

/**
 * 与 media-library-view 的 desktopPlayable 同一条规则：缺字段的旧数据放行，其余只认 supported。
 * 这里就地写一遍是为了让本文件零运行时依赖，单测可以直接 transpile 后 import。
 */
function desktopPlayable(compatibility?: MediaCompatibility | null): boolean {
  return compatibility?.desktop == null || compatibility.desktop === "supported"
}

/** `E01` when the backend gave an episode number; otherwise no number is invented. */
function childLabel(child: CatalogChild): string {
  if (typeof child.episode === "number") return `E${String(child.episode).padStart(2, "0")}`
  return "—"
}

function childTitle(child: CatalogChild): string {
  const title = child.episodeTitle?.trim()
  if (title) return title
  if (typeof child.episode === "number") return `第 ${child.episode} 集`
  return "集数未标"
}

/**
 * 分节按 `relDir`（文件真正所在的子目录）——番剧的 episode 几乎全是 null，猜集号是错的。
 * 标题：这一段里季号一致就用「第 N 季」，否则用目录名的末段；整卡只有一个目录时不显示节标题。
 */
export function groupSeasons(children: CatalogChild[]): WallSeason[] {
  const groups = new Map<string, WallChild[]>()
  const seasons = new Map<string, Set<number>>()
  for (const child of children) {
    const dir = (child.relDir ?? "").replace(/\/+$/, "")
    const key = dir || "unknown"
    const bucket = groups.get(key) ?? []
    const playable = desktopPlayable(child.compatibility)
      bucket.push({
        mediaId: child.mediaId,
        label: childLabel(child),
        title: childTitle(child),
        hasEpisodeTitle: Boolean(child.episodeTitle?.trim()),
      name: child.name,
      playable,
      note: playable ? null : child.compatibility?.desktopReason?.trim() || "桌面端无法播放这个文件",
    })
    groups.set(key, bucket)
    if (typeof child.season === "number") {
      const set = seasons.get(key) ?? new Set<number>()
      set.add(child.season)
      seasons.set(key, set)
    }
  }
  const single = groups.size === 1
  return [...groups.entries()].map(([key, items]) => {
    const seen = seasons.get(key)
    const seasonNumber = seen?.size === 1 ? [...seen][0] : null
    const dirName = key === "unknown" ? null : key.split("/").filter(Boolean).pop() ?? null
    return {
      key,
      // 单目录的卡不再重复一遍标题（卡名已经写着作品名）。
      title: single ? "" : seasonNumber !== null ? `第 ${seasonNumber} 季` : dirName ?? "未分目录",
      children: items,
    }
  })
}

const CONFIRMED_BY_LABEL: Record<string, { label: string; tone: "auto" | "manual" | "unknown" }> = {
  auto: { label: "机器匹配", tone: "auto" },
  manual: { label: "人工确认", tone: "manual" },
  rebind: { label: "人工指定", tone: "manual" },
  unknown: { label: "来源未知", tone: "unknown" },
}

export function confirmedBySource(confirmedBy: string | null | undefined): WallDetail["source"] {
  if (!confirmedBy) return null
  return CONFIRMED_BY_LABEL[confirmedBy] ?? null
}

export function toDetail(detail: CatalogDetail, resolvePoster: (itemId: string) => string | null): WallDetail {
  const children = detail.children ?? []
  return {
    id: detail.id,
    title: detail.title,
    source: confirmedBySource(detail.confirmedBy),
    year: detail.year ?? null,
    originalTitle: detail.originalTitle ?? null,
    overview: detail.overview ?? null,
    status: detail.status,
    statusLabel: catalogStatusLabel(detail.status),
    posterUrl: detail.posterUrl ? resolvePoster(detail.id) : null,
    subtitle: detail.subtitle ?? null,
    candidates: detail.candidates ?? [],
    seasons: groupSeasons(children),
    single: children.length === 1,
  }
}

const ERROR_TEXT: Record<string, string> = {
  MEDIA_ROUTE_DENIED: "客户端不允许访问这个媒体接口",
  MEDIA_NOT_FOUND: "这个条目已经不在了，刷新一下",
  INVALID_REQUEST: "请求不合法（缺 libraryId 或条目 id）",
  OPENLIST_UNAVAILABLE: "源站暂时不可用，稍后重试",
  CATALOG_UNAVAILABLE: "标题库还没准备好",
  ADMIN_FORBIDDEN: "只有本机或管理员能触发刮削",
}

/** 码→中文；后端已经给中文句子时（subtitle 一类）不经过这里。 */
export function catalogErrorText(error: unknown, fallback: string): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : ""
  return ERROR_TEXT[code] ?? fallback
}

export function scrapeSummary(job: { status: string; total: number; scanned: number; matched: number; lastError: string | null; reviewRequired?: boolean }): string {
  if (job.status === "running") return `正在刮削：已扫 ${job.scanned} / ${job.total}，命中 ${job.matched}`
  if (job.status === "failed") return `刮削失败：${job.lastError ?? "未知原因"}`
  if (job.reviewRequired) return exclusionText.review
  return `标题库已更新：${job.total} 组，命中 ${job.matched}`
}

/**
 * 「撤销确认」现在粘得住（后端 74cb3af2：同一事务里连草稿那份判定一起降级，落点=审阅页「待人工」），
 * 但卡会立刻离开标题墙。入口按用户拍的"只加提醒、不加新面"，所以这句放进两步确认里。
 */
export const UNCONFIRM_NOTICE = "撤销后这张卡会离开标题墙；可在审阅页「待人工」重新确认或换绑。"
