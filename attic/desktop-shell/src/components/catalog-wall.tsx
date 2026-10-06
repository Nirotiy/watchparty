import { useState } from "react"
import { AddRegular, ArrowLeftRegular, FolderRegular, PlayRegular } from "@fluentui/react-icons"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { posterHue, titleInitial, type WallCard, type WallDetail } from "@/lib/catalog-view"

/**
 * The title wall from the 2026-09-26 mockup (option B): posters on the left, the selected
 * title's rail on the right. Cards without a cached poster stay word-only, so a library
 * that has not been scraped for art still reads.
 */
export function CatalogWall({ cards, selectedId, onSelect }: {
  cards: WallCard[]
  selectedId: string | null
  onSelect: (card: WallCard) => void
}) {
  return (
    <ul className="catalog-wall" aria-label="标题墙">
      {cards.map(card => (
        <li key={card.id} className="min-w-0">
          <button
            type="button"
            className={cn("catalog-card", card.id === selectedId && "on")}
            aria-pressed={card.id === selectedId}
            title={`${card.title}${card.year ? ` · ${card.year}` : ""} · ${card.statusLabel}`}
            onClick={() => onSelect(card)}
          >
            <span className="catalog-art">
              <CatalogArt imageUrl={card.posterUrl} title={card.title} />
              {card.year ? <span className="catalog-badge year">{card.year}</span> : null}
              {card.status !== "confirmed" ? (
                <span className={cn("catalog-badge", "status", card.status)}>{card.statusLabel}</span>
              ) : null}
            </span>
            {/* 兜底卡把名字写在图上（见 CatalogArt），下面就不再重复标题。 */}
            {card.posterUrl ? <span className="catalog-title">{card.title}</span> : null}
            {/* 状态已经在徽标上；副标题只写后端给的集数摘要，没有就不占一行。 */}
            {card.subtitle ? <span className="catalog-sub">{card.subtitle}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Poster, or the tinted initial-card that keeps the grid readable when nothing was cached. */
function CatalogArt({ imageUrl, title }: { imageUrl: string | null; title: string }) {
  const [failed, setFailed] = useState(false)
  if (imageUrl && !failed) {
    return <img className="catalog-art-img" src={imageUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
  }
  const hue = posterHue(title)
  return (
    <span
      className="catalog-art-tinted"
      style={{
        background: `radial-gradient(120% 90% at 78% 12%, hsl(${hue} 85% 62% / 0.55), transparent 62%), linear-gradient(155deg, hsl(${hue} 45% 14%) 0%, hsl(${hue} 50% 26%) 55%, hsl(${hue} 60% 52%) 100%)`,
      }}
    >
      <span className="catalog-art-glyph" aria-hidden="true">{titleInitial(title)}</span>
      <span className="catalog-art-name">{title}</span>
    </span>
  )
}

export function CatalogRail({ detail, controlEnabled, queueEnabled, onPlay, onEnqueue, onClose, busy }: {
  detail: WallDetail
  controlEnabled: boolean
  queueEnabled: boolean
  onPlay: (mediaId: string, title: string, container: string) => void
  onEnqueue: (mediaId: string, title: string, container: string) => void
  onClose: () => void
  busy: boolean
}) {
  const containerOf = (name: string) => (/.([a-z0-9]{2,5})$/i.exec(name)?.[1] ?? "mp4").toLowerCase()
  if (busy) {
    return (
      <section className="catalog-detail-page catalog-detail-loading" aria-label="标题详情" aria-busy="true">
        <div className="catalog-detail-loading-bar">
          <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="返回标题墙" title="返回标题墙">
            <ArrowLeftRegular />
          </Button>
          <span>正在读取作品详情…</span>
        </div>
        <div className="catalog-detail-loading-body">
          <div className="catalog-detail-loading-poster" aria-hidden="true" />
          <div className="catalog-detail-loading-lines" aria-hidden="true"><i /><i /><i /><i /></div>
        </div>
      </section>
    )
  }
  if (detail.single) {
    const child = detail.seasons[0]?.children[0]
    return (
      <section className="catalog-detail-page" aria-label="标题详情">
        <DetailHero detail={detail} onClose={onClose} />
          <div className="catalog-eps">
          <div className="catalog-ep">
            <b>正片</b>
            <span className="t" title={child?.title}>{child ? (child.hasEpisodeTitle ? child.title : `${detail.title} · ${child.title}`) : "（没有可播文件）"}</span>
          </div>
        </div>
        {child ? (
          <Button size="default" className="catalog-detail-play" disabled={!controlEnabled || detail.status === "candidate" || !child.playable} title={!child.playable ? child.note ?? "桌面端无法播放这个文件" : undefined} onClick={() => onPlay(child.mediaId, detail.title, containerOf(child.name))}>
            <PlayRegular />播放正片
          </Button>
        ) : null}
        {detail.status === "candidate" ? <p className="catalog-note">还在候选态：先确认标题，再播放（文件与标题都可能被换掉）。</p> : null}
      </section>
    )
  }
  const children = detail.seasons.flatMap(season => season.children)
  const firstPlayable = children.find(child => child.playable)
  return (
    <section className={cn("catalog-detail-page", children.length <= 16 && "catalog-detail-short")} aria-label="标题详情">
      <DetailHero detail={detail} onClose={onClose} />
      {detail.status === "candidate" ? <p className="catalog-note">还在候选态：确认标题后整季可播。</p> : null}
      <div className="catalog-seasons">
        {detail.seasons.map(season => (
          <section key={season.key}>
            <h4>{season.title || "选集"}<span className="muted">{season.children.length} 集</span></h4>
            <div className="catalog-eps">
              {season.children.map(child => (
                <div className="catalog-ep" key={child.mediaId}>
                  <b>{child.label}</b>
                  <span className="t" title={child.hasEpisodeTitle ? child.title : `${detail.title} · ${child.title}`}>{child.hasEpisodeTitle ? child.title : `${detail.title} · ${child.title}`}</span>
                  {!child.playable ? <span className="catalog-ep-blocked" title={child.note ?? undefined}>不可播</span> : null}
                  <Button size="sm" variant="ghost" disabled={!controlEnabled || detail.status === "candidate" || !child.playable} title={child.playable ? "播放这一集" : child.note ?? "桌面端无法播放这个文件"} onClick={() => onPlay(child.mediaId, `${detail.title} ${child.label}`, containerOf(child.name))}>
                    <PlayRegular />
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!queueEnabled || detail.status === "candidate" || !child.playable} title="加入播放队列" onClick={() => onEnqueue(child.mediaId, `${detail.title} ${child.label}`, containerOf(child.name))}>
                    <AddRegular />
                  </Button>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      {firstPlayable ? (
        <Button size="default" className="catalog-detail-play" disabled={!controlEnabled || detail.status === "candidate" || !firstPlayable.playable} title={!firstPlayable.playable ? firstPlayable.note ?? "桌面端无法播放这个文件" : undefined} onClick={() => onPlay(firstPlayable.mediaId, `${detail.title} ${firstPlayable.label}`, containerOf(firstPlayable.name))}>
          <PlayRegular />播放第一集
        </Button>
      ) : null}
    </section>
  )
}

/** 详情题头（方案 A，2026-10-03 用户选定）：海报回 2:3 原生比例，不再拉升当底图。 */
function DetailHero({ detail, onClose }: { detail: WallDetail; onClose: () => void }) {
  return (
    <>
      {/* 只留箭头：文字交给 title/aria-label，形状与加载态那颗同款（icon-sm ghost）。 */}
      <Button size="icon-sm" variant="ghost" className="catalog-detail-back" onClick={onClose} aria-label="返回标题墙" title="返回标题墙">
        <ArrowLeftRegular />
      </Button>
      <div className={cn("catalog-detail-head", detail.posterUrl && "has-poster")}>
        {detail.posterUrl ? <img className="catalog-detail-poster" src={detail.posterUrl} alt="" loading="lazy" /> : null}
        <div className="catalog-detail-head-copy"><RailHead detail={detail} /></div>
      </div>
    </>
  )
}

function RailHead({ detail }: { detail: WallDetail }) {
  // Bangumi 简介可以很长：默认三行 + 展开/收起（用户裁决 2026-09-28）。
  const [overviewOpen, setOverviewOpen] = useState(false)
  const overview = detail.overview?.trim() ?? ""
  return (
    <header className="catalog-rail-head">
      <div className="catalog-rail-title"><b>{detail.title}</b></div>
      {/* 徽标不压标题：单独一行跟在标题下面（卡面那套绝对定位只属于墙上的卡）。 */}
      <div className="catalog-rail-meta">
        {detail.year ? <span className="pill-dim">{detail.year}</span> : null}
        <span className={cn("catalog-badge status", detail.status)}>{detail.statusLabel}</span>
        {detail.source ? <span className={cn("catalog-source", detail.source.tone)} title="绑定来源：人工选定的不会被自动流程改写">{detail.source.label}</span> : null}
      </div>
      <dl className="catalog-kv">
        {detail.originalTitle ? (<><dt>原作名</dt><dd>{detail.originalTitle}</dd></>) : null}
        {detail.subtitle ? (<><dt>集数</dt><dd>{detail.subtitle}</dd></>) : null}
      </dl>
      {overview ? (
        <div className="catalog-rail-overview">
          <p className={cn("catalog-overview", !overviewOpen && "clamped")}>{overview}</p>
          <button type="button" className="catalog-overview-toggle" aria-expanded={overviewOpen} onClick={() => setOverviewOpen(open => !open)}>
            {overviewOpen ? "收起" : "展开"}
          </button>
        </div>
      ) : null}
    </header>
  )
}

/** 未匹配条目不在墙里，只在墙下留一行出口；这是裁决 ③。 */
export function UnmatchedLine({ count, onShowFiles }: { count: number; onShowFiles: () => void }) {
  if (count <= 0) return null
  return (
    <p className="catalog-unmatched">
      未匹配的 <b>{count}</b> 组不在标题墙里（不拿文件夹名冒充标题）：
      <Button size="sm" variant="ghost" onClick={onShowFiles}><FolderRegular />去 Files 看</Button>
    </p>
  )
}
