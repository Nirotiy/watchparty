import { MaterialSymbol } from "@/components/material-symbol"
import { Button } from "@/components/ui/button"

export interface MediaLibraryItem {
  id: string
  title: string
  meta: string
}

export interface MediaLibraryViewProps {
  /**
   * 需要 desktop 会话新增 IPC：listMedia(root, path, cursor) / searchMedia(q)
   * （REST /api/media/list 与 /api/media/search 的封装）。
   * items 为空数组且 loading=false → 空态；undefined → 加载骨架。
   */
  items: MediaLibraryItem[] | null
  loading: boolean
  onPick: (item: MediaLibraryItem) => void
  onBack: () => void
}

export function MediaLibraryView({ items, loading, onPick, onBack }: MediaLibraryViewProps) {
  const skeleton = items === null

  return (
    <section className="mx-auto h-full w-full max-w-6xl overflow-auto px-5 py-5" aria-labelledby="library-title">
      <div className="mb-4 flex items-center gap-3">
        <p id="library-title" className="text-sm font-semibold">媒体库</p>
        <span className="rounded border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground">Anime / Film / TV Shows</span>
        <span className="ml-auto">
          <Button variant="outline" size="sm" onClick={onBack}>返回房间</Button>
        </span>
      </div>

      {skeleton || loading ? (
        <div className="c-grid" aria-busy="true">
          {Array.from({ length: 10 }, (_, index) => (
            <div key={index} className="tile">
              <div className="th" />
              <div className="tt">&nbsp;</div>
              <div className="tm">&nbsp;</div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="grid place-items-center gap-2 py-24 text-center text-xs text-muted-foreground">
          <MaterialSymbol name="library" className="size-7 text-muted-foreground/50" />
          <p>媒体库为空，或后端尚未暴露 OpenList 目录。</p>
        </div>
      ) : (
        <div className="c-grid">
          {items.map((item) => (
            <button key={item.id} type="button" className="tile text-left" onClick={() => onPick(item)}>
              <div className="th" />
              <div className="tt">{item.title}</div>
              <div className="tm">{item.meta}</div>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
