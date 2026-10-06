import * as React from "react"

import { cn } from "@/lib/utils"

/** M2-3 键盘导航纯函数（供单测）：返回下一个应聚焦的 tab 下标；不认识的键返回 null。 */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null
  const index = Math.min(Math.max(current, 0), count - 1)
  if (key === "ArrowLeft") return (index - 1 + count) % count
  if (key === "ArrowRight") return (index + 1) % count
  if (key === "Home") return 0
  if (key === "End") return count - 1
  return null
}

const TabBarContext = React.createContext<{
  value: string
  onValueChange: (value: string) => void
  panelId: string
  tabId: (value: string) => string
} | null>(null)

/**
 * WinUI 下划线 Tab（M2-3 统一件，形态 A）：roving tabindex + ←/→/Home/End 自动激活，
 * aria-selected 由 value 推导，tab 与 panel 用显式 id 关联（idPrefix / panelId）。
 */
export function TabBar({ value, onValueChange, panelId, idPrefix, label, className, children }: {
  value: string
  onValueChange: (value: string) => void
  panelId: string
  idPrefix: string
  label: string
  className?: string
  children: React.ReactNode
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
    const next = nextTabIndex(event.key, tabs.findIndex(tab => tab.getAttribute("aria-selected") === "true"), tabs.length)
    if (next === null) return
    event.preventDefault()
    const target = tabs[next]
    target.focus()
    const nextValue = target.dataset.tabValue
    if (nextValue !== undefined && nextValue !== value) onValueChange(nextValue)
  }
  const context = React.useMemo(
    () => ({ value, onValueChange, panelId, tabId: (item: string) => `${idPrefix}-${item}` }),
    [value, onValueChange, panelId, idPrefix],
  )
  return <div ref={ref} role="tablist" aria-label={label} className={className} onKeyDown={onKeyDown}>
    <TabBarContext.Provider value={context}>{children}</TabBarContext.Provider>
  </div>
}

export function TabBarItem({ value, icon, children, className }: {
  value: string
  icon?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  const context = React.useContext(TabBarContext)
  if (!context) throw new Error("TabBarItem 必须在 TabBar 内使用")
  const active = context.value === value
  return <button
    type="button"
    role="tab"
    id={context.tabId(value)}
    data-tab-value={value}
    aria-selected={active}
    aria-controls={context.panelId}
    tabIndex={active ? 0 : -1}
    onClick={() => { if (!active) context.onValueChange(value) }}
    className={cn(
      "winui-focus relative inline-flex min-h-8 cursor-pointer items-center gap-2 whitespace-nowrap rounded-sm px-3 text-sm",
      active
        ? "font-semibold text-[var(--text-primary)] after:absolute after:bottom-0 after:left-3 after:h-[3px] after:w-[calc(100%-24px)] after:rounded-full after:bg-[var(--accent)]"
        : "text-[var(--text-secondary)] hover:bg-[var(--fill-subtle-hover)] hover:text-[var(--text-primary)]",
      className,
    )}
  >
    {icon}{children}
  </button>
}
