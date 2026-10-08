"use client";

import React, { useState } from "react";
import { Check, Film, ListPlus, Play, Search, Tv, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MediaImage } from "@/components/media-image";
import { cn } from "@/lib/utils";
import type { MediaSource } from "@/lib/contracts";
import { tintedStyle, titleInitial, type WallCard, type WallDetail } from "@/lib/catalog-view";

/**
 * 标题墙（相位 3，裁决 B）：海报网格；右栏由调用方按选中的条目渲染（见 CatalogRail）。
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
            data-card-id={card.id}
            aria-pressed={card.id === selectedId}
            onClick={() => onSelect(card)}
            className={cn("group flex w-full min-w-0 flex-col gap-1.5 text-left", card.id === selectedId && "text-foreground")}
            title={`${card.title}${card.year ? ` · ${card.year}` : ""} · ${card.statusLabel}`}
          >
            <span
              className={cn(
                "relative grid aspect-[2/3] w-full place-items-center overflow-hidden rounded-lg border transition-colors",
                card.id === selectedId ? "border-ring" : "border-border group-hover:border-ring",
              )}
            >
              {card.posterUrl
                ? <WallPoster src={card.posterUrl} />
                : <TintedArt title={card.title} seed={card.title} />}
              {card.year ? (
                <span className="absolute left-1.5 top-1.5 rounded-[4px] border border-white/10 bg-black/70 px-1.5 text-xs leading-4 text-foreground/90">{card.year}</span>
              ) : null}
              {card.status !== "confirmed" ? (
                <span className={cn("absolute right-1.5 top-1.5 rounded-[4px] border border-white/10 bg-black/70 px-1.5 text-xs leading-4", badgeTone(card.status))}>{card.statusLabel}</span>
              ) : null}
            </span>
            {/* 兜底卡的名字写在图上，下面就不再重复标题。 */}
            {card.posterUrl ? <span className="truncate text-sm">{card.title}</span> : null}
            {/* 状态已经在徽标上；副标题只写后端给的集数摘要，没有就不占一行。 */}
            {card.subtitle ? <span className="truncate text-xs text-muted-foreground">{card.subtitle}</span> : null}
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
  return <MediaImage src={src} alt="" loading="lazy" className="size-full object-cover" fallback={<Film className="size-5 text-muted-foreground" aria-hidden="true" />} />;
}

function badgeTone(status: string): string {
  if (status === "candidate") return "text-warn"
  if (status === "rejected") return "text-destructive"
  return "text-muted-foreground"
}

/** 右侧详情栏：标题、原作名、集数、候选（确认/拒绝）、季/集。 */
/** Bangumi 简介可以很长：默认三行 + 展开/收起（与桌面壳同口径，2026-09-28）。 */
function RailOverview({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <p className={cn("text-sm leading-relaxed text-muted-foreground", !open && "line-clamp-3")}>{text}</p>
      <button type="button" className="mt-1 text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "收起" : "展开"}
      </button>
    </div>
  );
}

export function CatalogRail({ detail, busy, onConfirm, onReject, onPlay, onAddToQueue, onPlayDesktop, roomless = false }: {
  detail: WallDetail;
  busy: boolean;
  onConfirm: (candidateId: string) => void;
  onReject: (candidateId: string) => void;
  onPlay: (media: MediaSource) => void;
  onAddToQueue: (media: MediaSource) => void;
  /** 桌面可播、浏览器不可播时的出口；与 Files 视图共用同一行为。 */
  onPlayDesktop?: (media: MediaSource) => void;
  /** 房外只读浏览：写操作（确认/拒绝/入队）与桌面出口置灰，主行动＝用此片开房。 */
  roomless?: boolean;
}) {
  const containerOf = (name: string) => (/\.([a-z0-9]{2,5})$/i.exec(name)?.[1] ?? "mp4").toLowerCase();
  return (
    <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-card p-3.5" aria-label="标题详情">
      <div className="flex flex-wrap items-center gap-1.5">
        <b className="min-w-0 break-words text-lg font-medium">{detail.title}</b>
        {detail.year ? <span className="rounded-[4px] bg-elevated px-1.5 text-xs text-foreground/70">{detail.year}</span> : null}
        <span className={cn("rounded-[4px] bg-elevated px-1.5 text-xs", badgeTone(detail.status))}>{detail.statusLabel}</span>
        {detail.source ? (
          <span
            className={cn("rounded-[4px] bg-elevated px-1.5 text-xs", detail.source.tone === "manual" ? "text-info" : detail.source.tone === "auto" ? "text-ok" : "text-muted-foreground")}
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

      {detail.single ? (
        <SingleChild detail={detail} onPlay={onPlay} onAddToQueue={onAddToQueue} onPlayDesktop={onPlayDesktop} containerOf={containerOf} roomless={roomless} />
      ) : (
        detail.seasons.map(season => (
          <section key={season.key} className="space-y-1.5">
            {season.title ? (
              <h4 className="flex items-center justify-between text-xs font-medium">
                <span>{season.title}</span>
                <span className="text-muted-foreground">{season.children.length} 集</span>
              </h4>
            ) : null}
            <div className="space-y-1">
              {season.children.map(child => (
                <div key={child.mediaId} className="flex items-center gap-2 rounded-sm border border-border px-2 py-1 text-xs">
                  <b className="w-8 shrink-0 font-mono text-xs font-normal text-muted-foreground">{child.label}</b>
                  <span className="min-w-0 flex-1 truncate text-foreground/80" title={child.name}>{child.name}</span>
                  {!child.playable ? (
                    <span className={cn("shrink-0 rounded-[4px] px-1.5 text-xs", child.desktopOnly ? "bg-info-soft text-info" : "bg-elevated text-muted-foreground")} title={child.note ?? undefined}>
                      {child.desktopOnly ? "桌面端 / MPV" : "不可播"}
                    </span>
                  ) : null}
                  {!child.playable && child.desktopOnly && onPlayDesktop ? (
                    <Button size="sm" variant="ghost" className="size-6 shrink-0 p-0 text-info hover:text-info" title="桌面端播放"
                      disabled={detail.status === "candidate"}
                      onClick={() => onPlayDesktop?.({ kind: "openlist", mediaId: child.mediaId, title: `${detail.title} ${child.label}`, container: containerOf(child.name) })}>
                      <Tv className="size-3" />
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" className="size-6 shrink-0 p-0 text-muted-foreground hover:text-foreground" title={child.playable ? "播放这一集" : child.note ?? "浏览器无法播放这个文件"}
                      disabled={detail.status === "candidate" || !child.playable}
                      onClick={() => onPlay({ kind: "openlist", mediaId: child.mediaId, title: `${detail.title} ${child.label}`, container: containerOf(child.name) })}>
                      <Play className="size-3" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))
      )}

      {detail.candidates.length > 0 ? (
        <div className="space-y-2 border-t border-border pt-2.5">
          <h4 className="text-xs font-medium">候选（{detail.candidates.length}）</h4>
          {detail.candidates.map(candidate => (
            <div key={candidate.id} className="rounded-md border border-border bg-background p-2">
              <div className="flex items-center gap-2 text-sm">
                <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <b className="min-w-0 truncate font-medium">{candidate.title}</b>
                {candidate.year ? <span className="text-xs text-muted-foreground">{candidate.year}</span> : null}
                <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-warn">{candidate.score.toFixed(2)}</span>
              </div>
              <div className="mt-1.5 flex gap-1.5">
                <Button size="sm" className="h-7 px-2 text-xs" disabled={busy || roomless}
                  onClick={() => onConfirm(candidate.id)}>
                  <Check className="size-3" />确认
                </Button>
                <Button size="sm" variant="secondary" className="h-7 px-2 text-xs" disabled={busy || roomless} onClick={() => onReject(candidate.id)}>
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

function SingleChild({ detail, onPlay, onAddToQueue, onPlayDesktop, containerOf, roomless = false }: {
  detail: WallDetail;
  onPlay: (media: MediaSource) => void;
  onAddToQueue: (media: MediaSource) => void;
  onPlayDesktop?: (media: MediaSource) => void;
  containerOf: (name: string) => string;
  roomless?: boolean;
}) {
  const child = detail.seasons[0]?.children[0];
  const media: MediaSource | null = child
    ? { kind: "openlist", mediaId: child.mediaId, title: detail.title, container: containerOf(child.name) }
    : null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded-sm border border-border px-2 py-1 text-xs">
        <Tv className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-foreground/80" title={child?.name}>{child?.name ?? "（没有可播文件）"}</span>
        {child && !child.playable ? (
          <span className={cn("shrink-0 rounded-[4px] px-1.5 text-xs", child.desktopOnly ? "bg-info-soft text-info" : "bg-elevated text-muted-foreground")}>{child.desktopOnly ? "桌面端 / MPV" : "不可播"}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" className="h-7 px-2 text-xs"
          disabled={detail.status === "candidate" || !media || child?.playable === false}
          title={roomless ? "用此片开房" : child && !child.playable ? child.note ?? undefined : "播放正片"}
          onClick={() => media && onPlay(media)}>
          <Play className="size-3" />{roomless ? "用此片开房" : "播放正片"}
        </Button>
        <Button size="sm" variant="secondary" className="h-7 px-2 text-xs"
          disabled={detail.status === "candidate" || !media || child?.playable === false || roomless}
          onClick={() => media && onAddToQueue(media)}>
          <ListPlus className="size-3" />入队
        </Button>
        {child?.desktopOnly && (onPlayDesktop || roomless) ? (
          <Button size="sm" variant="secondary"
            className="h-7 px-2 text-xs text-info"
            disabled={detail.status === "candidate" || roomless}
            title={child.note ?? undefined}
            onClick={() => { if (media && onPlayDesktop) onPlayDesktop(media); }}>
            <Tv className="size-3" />桌面端播放
          </Button>
        ) : null}
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
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          未匹配的 <b className="text-foreground">{count}</b> 组不在标题墙里
          <button type="button" className="text-foreground/80 transition-colors hover:text-foreground hover:underline" onClick={onShowFiles}>去文件视图看</button>
        </p>
      ) : null}
      {hiddenFiles > 0 ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          已隐藏 <b className="text-foreground">{hiddenFiles}</b> 个非视频文件
          <button type="button" className="text-foreground/80 transition-colors hover:text-foreground hover:underline" onClick={onToggleFiles}>
            {showAllFiles ? "隐藏它们" : "显示全部"}
          </button>
        </p>
      ) : null}
    </>
  );
}
