import type { CatalogCandidate, CatalogCard, CatalogChild, CatalogDetail, CatalogPage, CatalogStatus } from "@/lib/contracts"
import { exclusionText } from "../../desktop-shell/shared/catalog-exclusions"

/**
 * 标题墙的视图模型。与桌面壳那份（`desktop-shell/src/lib/catalog-view.ts`）同语义、不同文件：
 * 计划里明确不做共享包，两端各持一份，形状随服务端契约。
 */
export interface WallCard {
  id: string
  title: string
  year: number | null
  posterUrl: string | null
  status: CatalogStatus
  statusLabel: string
  subtitle: string | null
  needsReview: boolean
}

export interface WallChild {
  mediaId: string
  label: string
  name: string
  /** 浏览器能不能播；缺 compatibility 的旧数据按可播处理。 */
  playable: boolean
  /** 桌面端能播、浏览器不能：给"去桌面端"的提示，而不是一句"不可播"。 */
  desktopOnly: boolean
  /** 不能播时的一句话（服务端的 browserReason 优先）。 */
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
  /** 绑定来源：人工选的一律受保护。 */
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
 * 颜色由标题决定，所以同一部片每次渲染、每台机器都是同一个色。
 */
export function posterHue(seed: string): number {
  let hash = 0
  for (const character of seed) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 360
  return hash
}

/** 图上已经写了名字，下面那行就不再重复标题。 */
export function titleInitial(title: string): string {
  return [...title.trim()][0] ?? "?"
}

/** 兜底卡的底色：暗→亮的斜向渐变 + 右上角一团泛光。 */
export function tintedStyle(seed: string): { background: string } {
  const hue = posterHue(seed)
  return {
    background: `radial-gradient(120% 90% at 78% 12%, hsl(${hue} 85% 62% / 0.55), transparent 62%), linear-gradient(155deg, hsl(${hue} 45% 14%) 0%, hsl(${hue} 50% 26%) 55%, hsl(${hue} 60% 52%) 100%)`,
  }
}

/** 海报走同源路由；后端只给「有没有缓存」这个信号，地址由客户端按条目 id 拼。 */
export function catalogPoster(itemId: string): string {
  return `/api/media/posters/${encodeURIComponent(itemId)}`
}

export function wallCard(card: CatalogCard): WallCard {
  return {
    id: card.id,
    title: card.title,
    year: card.year ?? null,
    posterUrl: card.posterUrl ? catalogPoster(card.id) : null,
    status: card.status,
    statusLabel: catalogStatusLabel(card.status),
    subtitle: card.subtitle ?? null,
    needsReview: card.status === "candidate",
  }
}

export function toWall(page: CatalogPage): Wall {
  return {
    cards: (page.items ?? []).map(wallCard),
    hasMore: Boolean(page.hasMore),
    nextCursor: page.nextCursor ?? null,
  }
}

/** 有集号就给 E01，没有就不编（后端 nullable 的 episode 就是"不知道"）。 */
function childLabel(child: CatalogChild): string {
  return typeof child.episode === "number" ? `E${String(child.episode).padStart(2, "0")}` : "—"
}

/**
 * 分节按 `relDir`（文件真正所在的子目录）——番剧的 episode 几乎全是 null，猜集号是错的。
 * 标题：这一段里季号一致就用「第 N 季」，否则用目录名末段；整卡只有一个目录时不显示节标题。
 */
export function groupSeasons(children: CatalogChild[]): WallSeason[] {
  const groups = new Map<string, WallChild[]>()
  const seasons = new Map<string, Set<number>>()
  for (const child of children) {
    const key = (child.relDir ?? "").replace(/\/+$/, "") || "unknown"
    const playable = child.compatibility == null || child.compatibility.browser === "supported"
    const desktopOnly = !playable && child.compatibility?.desktop === "supported"
    groups.set(key, [...(groups.get(key) ?? []), {
      mediaId: child.mediaId,
      label: childLabel(child),
      name: child.name,
      playable,
      desktopOnly,
      note: playable ? null : child.compatibility?.browserReason?.trim() || "浏览器无法播放这个文件（桌面端可以）",
    }])
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

export function toDetail(detail: CatalogDetail): WallDetail {
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
    posterUrl: detail.posterUrl ? catalogPoster(detail.id) : null,
    subtitle: detail.subtitle ?? null,
    candidates: detail.candidates ?? [],
    seasons: groupSeasons(children),
    single: children.length === 1,
  }
}

export function scrapeSummary(job: { status: string; total: number; scanned: number; matched: number; lastError: string | null; reviewRequired?: boolean }): string {
  if (job.status === "running") return `正在刮削：已扫 ${job.scanned} / ${job.total}，命中 ${job.matched}`
  if (job.status === "failed") return `刮削失败：${job.lastError ?? "未知原因"}`
  if (job.reviewRequired) return exclusionText.review
  return `标题库已更新：${job.total} 组，命中 ${job.matched}`
}

/** 不是视频的普通文件（两端都不支持）默认不显示；需要时一键放出来。 */
export function isNonMedia(item: { type: string; compatibility: { browser: string; desktop: string } }): boolean {
  return item.type === "file" && item.compatibility.browser === "unsupported" && item.compatibility.desktop === "unsupported"
}
