import spriteUrl from "@/assets/material-symbols.svg"
import { cn } from "@/lib/utils"

export type MaterialSymbolName =
  | "add"
  | "check"
  | "close"
  | "dark-mode"
  | "expand-less"
  | "expand-more"
  | "folder"
  | "fullscreen"
  | "fullscreen-exit"
  | "group"
  | "home"
  | "library"
  | "light-mode"
  | "lock"
  | "logout"
  | "monitor"
  | "movie"
  | "music-note"
  | "pause"
  | "play-arrow"
  | "queue"
  | "search"
  | "settings"
  | "shield"
  | "skip-next"
  | "skip-previous"
  | "speed"
  | "subtitles"
  | "sync"
  | "visibility-off"
  | "volume-up"

/** Renders one locally bundled Material Symbols Outlined glyph from the desktop sprite. */
export function MaterialSymbol({ name, className }: { name: MaterialSymbolName; className?: string }) {
  return (
    <svg aria-hidden="true" className={cn("size-5 fill-current", className)} focusable="false">
      <use href={`${spriteUrl}#ms-${name}`} />
    </svg>
  )
}
