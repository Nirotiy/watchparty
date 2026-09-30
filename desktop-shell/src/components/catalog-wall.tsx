import { useState } from "react"
import { ArrowLeftRegular, ChevronDownRegular, ChevronUpRegular } from "@fluentui/react-icons"

import { MaterialSymbol } from "@/components/material-symbol"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { BangumiHit } from "@/lib/ipc"
import { posterHue, titleInitial, UNCONFIRM_NOTICE, type WallCard, type WallChild, type WallDetail } from "@/lib/catalog-view"

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

export function CatalogRail({ detail, controlEnabled, queueEnabled, onPlay, onEnqueue, onConfirm, onReject, onUnconfirm, onSearchBangumi, onRebind, onClose, busy }: {
  detail: WallDetail
  controlEnabled: boolean
  queueEnabled: boolean
  onPlay: (mediaId: string, title: string, container: string) => void
  onEnqueue: (mediaId: string, title: string, container: string) => void
  onConfirm: (candidateId: string) => void
  onReject: (candidateId: string) => void
  /** 已确认的条目才给编辑：撤销确认 / 换绑一个 Bangumi 条目。 */
  onUnconfirm: () => void
  onSearchBangumi: (query: string) => Promise<BangumiHit[]>
  onRebind: (hit: BangumiHit) => void
  onClose: () => void
  busy: boolean
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const containerOf = (name: string) => (/.([a-z0-9]{2,5})$/i.exec(name)?.[1] ?? "mp4").toLowerCase()
  if (busy) {
    return (
      <section className="catalog-detail-page catalog-detail-loading" aria-label="标题详情" aria-busy="true">
        <div className="catalog-detail-loading-bar">
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="返回标题墙" title="返回标题墙">
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
        <DetailHero detail={detail} onClose={onClose} firstPlayable={child} controlEnabled={controlEnabled} onPlay={onPlay} containerOf={containerOf} />
          <div className="catalog-eps">
          <div className="catalog-ep">
            <b>正片</b>
            <span className="t" title={child?.title}>{child ? (child.hasEpisodeTitle ? child.title : `${detail.title} · ${child.title}`) : "（没有可播文件）"}</span>
          </div>
        </div>
        {detail.status === "candidate" ? <p className="catalog-note">还在候选态：先确认标题，再播放（文件与标题都可能被换掉）。</p> : null}
        <Button size="sm" variant="ghost" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(value => !value)}>更多 {advancedOpen ? <ChevronUpRegular /> : <ChevronDownRegular />}</Button>
        {advancedOpen ? <><CandidateList detail={detail} busy={busy} onConfirm={onConfirm} onReject={onReject} /><RebindPanel detail={detail} busy={busy} onUnconfirm={onUnconfirm} onSearchBangumi={onSearchBangumi} onRebind={onRebind} /></> : null}
      </section>
    )
  }
  const children = detail.seasons.flatMap(season => season.children)
  const firstPlayable = children.find(child => child.playable)
  return (
    <section className={cn("catalog-detail-page", children.length <= 16 && "catalog-detail-short")} aria-label="标题详情">
      <DetailHero detail={detail} onClose={onClose} firstPlayable={firstPlayable} controlEnabled={controlEnabled} onPlay={onPlay} containerOf={containerOf} />
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
                    <MaterialSymbol name="play-arrow" />
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!controlEnabled || !queueEnabled || detail.status === "candidate" || !child.playable} title="加入播放队列" onClick={() => onEnqueue(child.mediaId, `${detail.title} ${child.label}`, containerOf(child.name))}>
                    <MaterialSymbol name="add" />
                  </Button>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      <Button size="sm" variant="ghost" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(value => !value)}>更多 {advancedOpen ? <ChevronUpRegular /> : <ChevronDownRegular />}</Button>
      {advancedOpen ? <><CandidateList detail={detail} busy={busy} onConfirm={onConfirm} onReject={onReject} /><RebindPanel detail={detail} busy={busy} onUnconfirm={onUnconfirm} onSearchBangumi={onSearchBangumi} onRebind={onRebind} /></> : null}
    </section>
  )
}

function DetailHero({ detail, onClose, firstPlayable, controlEnabled, onPlay, containerOf }: {
  detail: WallDetail
  onClose: () => void
  firstPlayable?: WallChild
  controlEnabled: boolean
  onPlay: (mediaId: string, title: string, container: string) => void
  containerOf: (name: string) => string
}) {
  return (
    <div className="catalog-detail-hero" style={detail.posterUrl ? { backgroundImage: `url(${detail.posterUrl})` } : undefined}>
      <div className="catalog-detail-hero-shade" />
      <div className="catalog-detail-hero-layout">
        <div className="catalog-detail-hero-content">
          <Button size="sm" variant="ghost" className="catalog-detail-back" onClick={onClose} aria-label="返回标题墙" title="返回标题墙">
            <ArrowLeftRegular />返回标题墙
          </Button>
          <RailHead detail={detail} />
        </div>
        {firstPlayable ? (
          <Button
            size="default"
            className="catalog-hero-play"
            disabled={!controlEnabled || detail.status === "candidate" || !firstPlayable.playable}
            title={!firstPlayable.playable ? firstPlayable.note ?? "桌面端无法播放这个文件" : undefined}
            onClick={() => onPlay(firstPlayable.mediaId, detail.single ? detail.title : `${detail.title} ${firstPlayable.label}`, containerOf(firstPlayable.name))}
          >
            <MaterialSymbol name="play-arrow" />{detail.single ? "播放正片" : "播放第一集"}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 人工修绑定的出口（后端 2026-09-27 的编辑 API）：
 * 直接搜 Bangumi 挑一个条目绑上去（走 rebind）——刮削提不出正确条目的"死口"就靠它；
 * 已确认的条目额外给「撤销确认」回到待判定。merge/split 是批量操作，这版不做 UI（用 API 走）。
 */
function RebindPanel({ detail, busy, onUnconfirm, onSearchBangumi, onRebind }: {
  detail: WallDetail
  busy: boolean
  onUnconfirm: () => void
  onSearchBangumi: (query: string) => Promise<BangumiHit[]>
  onRebind: (hit: BangumiHit) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(detail.title)
  const [hits, setHits] = useState<BangumiHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [message, setMessage] = useState("")
  // 两步确认：撤销会让卡立刻离开标题墙（粘住的落点在审阅页「待人工」），先提醒再动手。
  // 用 id 记而不是布尔，切换卡片时自动复位，不需要 effect（本仓禁 effect 里 setState）。
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const confirming = confirmingId === detail.id
  // 没有文件就没什么可绑的。
  if (detail.seasons.every(season => season.children.length === 0)) return null
  async function search() {
    const text = query.trim()
    if (text.length < 2) { setMessage("至少两个字"); return }
    setSearching(true); setMessage("")
    try {
      const found = await onSearchBangumi(text)
      setHits(found)
      setMessage(found.length ? "" : "没有匹配条目，换个关键词试试")
    } catch {
      setMessage("搜索失败，稍后重试")
    } finally { setSearching(false) }
  }
  return (
    <div className="catalog-edit">
      <div className="catalog-edit-row">
        {detail.status === "confirmed" ? (
          confirming ? (
            <>
              <Button size="sm" variant="accent" disabled={busy} onClick={() => { setConfirmingId(null); onUnconfirm() }}>确认撤销</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmingId(null)}>取消</Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmingId(detail.id)}>撤销确认</Button>
          )
        ) : null}
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => { setOpen(value => !value); setMessage("") }}>换绑条目…</Button>
      </div>
      {detail.status === "confirmed" && confirming ? <p className="catalog-edit-note" role="status">{UNCONFIRM_NOTICE}</p> : null}
      {open ? (
        <div className="catalog-rebind">
          <div className="catalog-rebind-search">
            <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜 Bangumi 条目" aria-label="搜索 Bangumi 条目" className="h-8 text-xs" onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void search() } }} />
            <Button size="sm" variant="outline" disabled={searching || busy} onClick={() => void search()}>{searching ? "搜索中…" : "搜索"}</Button>
          </div>
          {message ? <p className="catalog-edit-note">{message}</p> : null}
          {hits?.map(hit => (
            <div className="catalog-hit" key={hit.externalId}>
              <b>{hit.title}</b>
              {hit.year ? <span className="muted">{hit.year}</span> : null}
              {hit.episodes ? <span className="muted">{hit.episodes} 集</span> : null}
              <Button size="sm" variant="accent" disabled={busy} onClick={() => onRebind(hit)}>绑定</Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
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

function CandidateList({ detail, busy, onConfirm, onReject }: {
  detail: WallDetail
  busy: boolean
  onConfirm: (candidateId: string) => void
  onReject: (candidateId: string) => void
}) {
  if (detail.candidates.length === 0) return null
  return (
    <div className="catalog-candidates">
      <h4>候选（{detail.candidates.length}）</h4>
      {detail.candidates.map(candidate => (
        <div className="catalog-candidate" key={candidate.id}>
          <div className="l1">
            <MaterialSymbol name="search" className="size-3.5 text-muted-foreground" />
            <b>{candidate.title}</b>
            {candidate.year ? <span className="muted">{candidate.year}</span> : null}
            <span className="score">{candidate.score.toFixed(2)}</span>
          </div>
          <div className="acts">
            <Button size="sm" variant="accent" disabled={busy} onClick={() => onConfirm(candidate.id)}>
              <MaterialSymbol name="check" />确认
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onReject(candidate.id)}>
              <MaterialSymbol name="close" />拒绝
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

/** 未匹配条目不在墙里，只在墙下留一行出口；这是裁决 ③。 */
export function UnmatchedLine({ count, onShowFiles }: { count: number; onShowFiles: () => void }) {
  if (count <= 0) return null
  return (
    <p className="catalog-unmatched">
      未匹配的 <b>{count}</b> 组不在标题墙里（不拿文件夹名冒充标题）：
      <Button size="sm" variant="ghost" onClick={onShowFiles}><MaterialSymbol name="folder" />去 Files 看</Button>
    </p>
  )
}
