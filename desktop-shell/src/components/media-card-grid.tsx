import { useState } from "react"

import { MaterialSymbol } from "@/components/material-symbol"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { MediaCard } from "@/lib/media-library-view"

/**
 * The one grid both data sources feed: the folder browser today, the catalog wall in
 * phase 3. Cards carry a title, a subtitle, an optional image (null until the image
 * proxy exists) and an optional badge; directories open, files play (or say why not).
 */
export function MediaCardGrid({ cards, onOpen, onPlay, onEnqueue, controlEnabled, queueEnabled }: {
  cards: MediaCard[]
  onOpen: (card: MediaCard) => void
  onPlay: (card: MediaCard) => void
  onEnqueue: (card: MediaCard) => void
  controlEnabled: boolean
  queueEnabled: boolean
}) {
  return (
    <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-label="媒体列表">
      {cards.map(card => (
        <MediaCardTile key={card.id} card={card} onOpen={onOpen} onPlay={onPlay} onEnqueue={onEnqueue} controlEnabled={controlEnabled} queueEnabled={queueEnabled} />
      ))}
    </ul>
  )
}

/**
 * Cover of the directory you are inside (phase 2). The backend only exposes a poster
 * for the current directory — not for each subfolder card — so this band is where a
 * folder's own `poster.jpg` shows up in the Files view.
 */
export function MediaFolderBanner({ imageUrl, title }: { imageUrl: string; title: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    <div className="media-folder-banner">
      <img src={imageUrl} alt="" onError={() => setFailed(true)} />
      <span className="media-folder-banner-name">{title}</span>
    </div>
  )
}

function MediaCardTile({ card, onOpen, onPlay, onEnqueue, controlEnabled, queueEnabled }: {
  card: MediaCard
  onOpen: (card: MediaCard) => void
  onPlay: (card: MediaCard) => void
  onEnqueue: (card: MediaCard) => void
  controlEnabled: boolean
  queueEnabled: boolean
}) {
  // 图挂了（404/格式不对）就退回图标，不把破图留在卡片上。
  const [imageFailed, setImageFailed] = useState(false)
  const showImage = Boolean(card.imageUrl) && !imageFailed
  return (
    <li className="min-w-0">
      <article className="media-card">
        <button
          type="button"
          className="media-card-open"
          title={card.relativePath || card.title}
          disabled={card.kind === "file" && !card.playable}
          onClick={() => card.kind === "dir" ? onOpen(card) : onPlay(card)}
        >
          <span className="media-card-art" aria-hidden="true">
            {showImage
              ? <img src={card.imageUrl!} alt="" loading="lazy" onError={() => setImageFailed(true)} />
              : <MaterialSymbol name={card.kind === "dir" ? "folder" : "movie"} className="size-6" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-[var(--text-primary)]">{card.title}</span>
            <span className="block truncate text-xs text-muted-foreground">{card.subtitle}</span>
          </span>
          {card.badge ? <span className={cn("media-card-badge", !card.playable && "blocked")}>{card.badge}</span> : null}
        </button>
        {card.kind === "file" ? (
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={!card.playable || !controlEnabled} title={card.note ?? "立即播放"} onClick={() => onPlay(card)}>
              <MaterialSymbol name="play-arrow" />播放
            </Button>
            <Button variant="outline" size="sm" disabled={!card.playable || !queueEnabled || !controlEnabled} title={card.note ?? "加入播放队列"} onClick={() => onEnqueue(card)}>
              <MaterialSymbol name="add" />入队
            </Button>
          </div>
        ) : null}
      </article>
    </li>
  )
}
