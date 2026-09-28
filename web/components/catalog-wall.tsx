"use client";

import React, { useState } from "react";
import { Check, Film, ListPlus, Play, Search, Tv, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { MediaSource } from "@/lib/contracts";
import { tintedStyle, titleInitial, type WallCard, type WallDetail } from "@/lib/catalog-view";

/**
 * 标题墙（相位 3，裁决 B）：4 列海报墙；右栏由调用方按选中的条目渲染（见 CatalogRail）。
 * 与桌面壳同语义：年份在封面左上、状态徽标在右上、未匹配不进墙、候选就地确认/拒绝。
 */
export function CatalogWall({ cards, selectedId, onSelect }: {
  cards: WallCard[];
  selectedId: string | null;
  onSelect: (card: WallCard) => void;
}) {
  return (
    <ul className="grid content-start gap-4 sm:grid-cols-3 xl:grid-cols-4" aria-label="标题墙">
      {cards.map(card => (
        <li key={card.id} className="min-w-0">
          <button
            type="button"
            aria-pressed={card.id === selectedId}
            onClick={() => onSelect(card)}
            className={cn("group flex w-full min-w-0 flex-col gap-1.5 text-left", card.id === selectedId && "text-white")}
            title={`${card.title}${card.year ? ` · ${card.year}` : ""} · ${card.statusLabel}`}
          >
            <span
              className={cn(
                "relative grid aspect-[2/3] w-full place-items-center overflow-hidden rounded border bg-black",
                card.id === selectedId ? "border-sky-400 ring-2 ring-sky-500/60" : "border-border group-hover:border-sky-500/50",
              )}
            >
              {card.posterUrl
                ? <WallPoster src={card.posterUrl} />
                : <TintedArt title={card.title} seed={card.title} />}
              {card.year ? (
                <span className="absolute left-1.5 top-1.5 rounded-full border border-white/20 bg-black/60 px-1.5 text-[10px] leading-4 text-white">{card.year}</span>
              ) : null}
              {card.status !== "confirmed" ? (
                <span className={cn("absolute right-1.5 top-1.5 rounded-full border bg-black/60 px-1.5 text-[10px] leading-4", badgeTone(card.status))}>{card.statusLabel}</span>
              ) : null}
            </span>
            {/* 兜底卡的名字写在图上，下面就不再重复标题。 */}
            {card.posterUrl ? <span className="truncate text-[13px] font-semibold">{card.title}</span> : null}
            {/* 状态已经在徽标上；副标题只写后端给的集数摘要，没有就不占一行。 */}
            {card.subtitle ? <span className="truncate text-[11px] text-muted-foreground">{card.subtitle}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 没海报时的兜底：按标题取色的斜向渐变 + 右上泛光 + 首字，名字压在图上。 */
function TintedArt({ title, seed }: { title: string; seed: string }) {
  return (
    <span className="absolute inset-0" style={tintedStyle(seed)}>
      <span aria-hidden="true" className="absolute inset-0 grid place-items-center text-[52px] font-extrabold text-white/15" style={{ textShadow: "0 0 24px rgba(255,255,255,.25)" }}>
        {titleInitial(title)}
      </span>
      <span className="absolute inset-x-0 bottom-0 h-[62%] bg-gradient-to-t from-black/80 to-transparent" />
      <span className="absolute inset-x-2.5 bottom-2 line-clamp-3 text-[13px] font-semibold leading-tight text-white" style={{ textShadow: "0 1px 10px rgba(0,0,0,.6)" }}>
        {title}
      </span>
    </span>
  );
}

function WallPoster({ src }: { src: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <Film className="size-5 text-muted-foreground" aria-hidden="true" />
  return <img src={src} alt="" loading="lazy" className="size-full object-cover" onError={() => setFailed(true)} />
}

function badgeTone(status: string): string {
  if (status === "candidate") return "border-amber-700 text-amber-300"
  if (status === "rejected") return "border-rose-900 text-rose-300"
  return "border-border text-muted-foreground"
}

/** 右侧详情栏：标题、原作名、集数、候选（确认/拒绝）、季/集。 */
/** Bangumi 简介可以很长：默认三行 + 展开/收起（与桌面壳同口径，2026-09-28）。 */
function RailOverview({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <p className={cn("text-xs leading-relaxed text-muted-foreground", !open && "line-clamp-3")}>{text}</p>
      <button type="button" className="mt-1 text-xs text-sky-400 hover:underline" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "收起" : "展开"}
      </button>
    </div>
  );
}

export function CatalogRail({ detail, busy, onConfirm, onReject, onPlay, onAddToQueue }: {
  detail: WallDetail;
  busy: boolean;
  onConfirm: (candidateId: string) => void;
  onReject: (candidateId: string) => void;
  onPlay: (media: MediaSource) => void;
  onAddToQueue: (media: MediaSource) => void;
}) {
  const containerOf = (name: string) => (/\.([a-z0-9]{2,5})$/i.exec(name)?.[1] ?? "mp4").toLowerCase();
  return (
    <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-card p-3.5" aria-label="标题详情">
      <div className="flex flex-wrap items-center gap-2">
        <b className="min-w-0 break-words text-[15px]">{detail.title}</b>
        {detail.year ? <span className="rounded border border-border px-1.5 text-[11px] text-muted-foreground">{detail.year}</span> : null}
        <span className={cn("rounded-full border px-1.5 text-[10px] leading-4", badgeTone(detail.status))}>{detail.statusLabel}</span>
        {detail.source ? (
          <span
            className={cn("rounded-full border px-1.5 text-[10px] leading-4", detail.source.tone === "manual" ? "border-sky-500 bg-sky-500 text-black" : detail.source.tone === "auto" ? "border-emerald-900 text-emerald-300" : "border-border text-muted-foreground")}
            title="绑定来源：人工选定的不会被自动流程改写"
          >
            {detail.source.label}
          </span>
        ) : null}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {detail.originalTitle ? (<><dt>原作名</dt><dd className="min-w-0 break-words">{detail.originalTitle}</dd></>) : null}
        {detail.subtitle ? (<><dt>集数</dt><dd>{detail.subtitle}</dd></>) : null}
      </dl>
      {detail.overview ? <RailOverview text={detail.overview} /> : null}
      {detail.status === "candidate" ? <p className="text-xs text-amber-300">还在候选态：先确认标题再播放（文件与标题都可能被换掉）。</p> : null}

      {detail.single ? (
        <SingleChild detail={detail} onPlay={onPlay} onAddToQueue={onAddToQueue} containerOf={containerOf} />
      ) : (
        detail.seasons.map(season => (
          <section key={season.key} className="space-y-1.5">
            {season.title ? (
              <h4 className="flex items-center justify-between text-xs font-semibold">
                <span>{season.title}</span>
                <span className="text-muted-foreground">{season.children.length} 集</span>
              </h4>
            ) : null}
            <div className="space-y-1">
              {season.children.map(child => (
                <div key={child.mediaId} className="flex items-center gap-2 rounded border border-border/70 px-2 py-1 text-xs">
                  <b className="w-8 shrink-0 text-[11px]">{child.label}</b>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={child.name}>{child.name}</span>
                  {!child.playable ? (
                    <span className="shrink-0 rounded-full border border-border px-1.5 text-[10px] text-muted-foreground" title={child.note ?? undefined}>
                      {child.desktopOnly ? "桌面端 / MPV" : "不可播"}
                    </span>
                  ) : null}
                  <Button size="sm" variant="ghost" className="size-6 shrink-0 p-0" title={child.playable ? "播放这一集" : child.note ?? "浏览器无法播放这个文件"}
                    disabled={detail.status === "candidate" || !child.playable}
                    onClick={() => onPlay({ kind: "openlist", mediaId: child.mediaId, title: `${detail.title} ${child.label}`, container: containerOf(child.name) })}>
                    <Play className="size-3 fill-current" />
                  </Button>
                </div>
              ))}
            </div>
          </section>
        ))
      )}

      {detail.candidates.length > 0 ? (
        <div className="space-y-2 border-t border-border pt-2.5">
          <h4 className="text-xs font-semibold">候选（{detail.candidates.length}）</h4>
          {detail.candidates.map(candidate => (
            <div key={candidate.id} className="rounded border border-amber-900/70 bg-amber-950/20 p-2">
              <div className="flex items-center gap-2 text-xs">
                <Search className="size-3.5 shrink-0 text-muted-foreground" />
                <b className="min-w-0 truncate">{candidate.title}</b>
                {candidate.year ? <span className="text-muted-foreground">{candidate.year}</span> : null}
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-amber-300">{candidate.score.toFixed(2)}</span>
              </div>
              <div className="mt-1.5 flex gap-1.5">
                <Button size="sm" className="h-7 bg-sky-500 px-2 text-[11px] font-semibold text-black hover:bg-sky-400" disabled={busy}
                  onClick={() => onConfirm(candidate.id)}>
                  <Check className="size-3" />确认
                </Button>
                <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={busy} onClick={() => onReject(candidate.id)}>
                  <X className="size-3" />拒绝
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

function SingleChild({ detail, onPlay, onAddToQueue, containerOf }: {
  detail: WallDetail;
  onPlay: (media: MediaSource) => void;
  onAddToQueue: (media: MediaSource) => void;
  containerOf: (name: string) => string;
}) {
  const child = detail.seasons[0]?.children[0];
  const media: MediaSource | null = child
    ? { kind: "openlist", mediaId: child.mediaId, title: detail.title, container: containerOf(child.name) }
    : null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded border border-border/70 px-2 py-1 text-xs">
        <Tv className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={child?.name}>{child?.name ?? "（没有可播文件）"}</span>
        {child && !child.playable ? (
          <span className="shrink-0 rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">{child.desktopOnly ? "桌面端 / MPV" : "不可播"}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" className="h-7 bg-white px-2 text-[11px] font-semibold text-black hover:bg-primary/90"
          disabled={detail.status === "candidate" || !media || child?.playable === false}
          title={child && !child.playable ? child.note ?? undefined : "播放正片"}
          onClick={() => media && onPlay(media)}>
          <Play className="size-3 fill-black" />播放正片
        </Button>
        <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]"
          disabled={detail.status === "candidate" || !media || child?.playable === false}
          onClick={() => media && onAddToQueue(media)}>
          <ListPlus className="size-3" />入队
        </Button>
      </div>
    </div>
  );
}

/** 未匹配不进墙，只在墙下留一行出口（裁决 ③）。 */
export function UnmatchedLine({ count, hiddenFiles, showAllFiles, onShowFiles, onToggleFiles }: {
  count: number;
  hiddenFiles: number;
  showAllFiles: boolean;
  onShowFiles: () => void;
  onToggleFiles: () => void;
}) {
  return (
    <>
      {count > 0 ? (
        <p className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5 text-xs text-muted-foreground">
          未匹配的 <b className="text-white">{count}</b> 组不在标题墙里（不拿文件夹名冒充标题）：
          <Button variant="link" size="sm" className="h-6 px-1 text-[11px] text-sky-400" onClick={onShowFiles}>去文件视图看</Button>
        </p>
      ) : null}
      {hiddenFiles > 0 ? (
        <p className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5 text-xs text-muted-foreground">
          已隐藏 <b className="text-white">{hiddenFiles}</b> 个非视频文件（.nfo / 图片 / 字幕一类）
          <Button variant="link" size="sm" className="h-6 px-1 text-[11px] text-sky-400" onClick={onToggleFiles}>
            {showAllFiles ? "隐藏它们" : "显示全部"}
          </Button>
        </p>
      ) : null}
    </>
  );
}
