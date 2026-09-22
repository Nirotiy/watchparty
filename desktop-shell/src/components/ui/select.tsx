import * as React from "react"
import { Select as SelectPrimitive } from "radix-ui"

import { MaterialSymbol } from "@/components/material-symbol"
import { cn } from "@/lib/utils"

const Select = SelectPrimitive.Root
const SelectValue = SelectPrimitive.Value

/** WinUI 3 ComboBox: 32px, 4px radius, chevron in TextFillColorSecondary. */
function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "flex min-h-8 w-full items-center justify-between gap-2 rounded-sm border border-input bg-[var(--fill-control)] px-3 text-sm text-[var(--text-primary)] outline-none transition-colors focus-visible:border-[var(--stroke-strong)] winui-focus hover:bg-[var(--fill-control-secondary)] data-[disabled]:pointer-events-none data-[disabled]:bg-transparent data-[disabled]:text-[var(--text-disabled)] [&>span]:truncate",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <MaterialSymbol name="expand-more" className="size-3 text-[var(--text-secondary)]" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

/** Flyout = overlay surface: OverlayCornerRadius 8, CardBackground + 1px card stroke, Shadow8. */
function SelectContent({ className, children, position = "popper", ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        className={cn(
          "z-50 max-h-80 min-w-36 overflow-hidden rounded-lg border border-[var(--stroke-card)] bg-[var(--fill-menu)] p-1 text-[var(--text-primary)] shadow-[var(--f2-shadow8)]",
          position === "popper" && "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-7 items-center justify-center text-[var(--text-secondary)]">
          <MaterialSymbol name="expand-less" className="size-4" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-0">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-7 items-center justify-center text-[var(--text-secondary)]">
          <MaterialSymbol name="expand-more" className="size-4" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

/** Item list rows are 32px; the checked row carries WinUI's 3px accent indicator. */
function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex min-h-8 w-full cursor-pointer select-none items-center rounded-sm py-1 pr-8 pl-2.5 text-sm outline-none data-[highlighted]:bg-[var(--menu-item-hover)] data-[state=checked]:bg-[var(--fill-selected)] data-[state=checked]:before:absolute data-[state=checked]:before:left-0 data-[state=checked]:before:top-1.5 data-[state=checked]:before:h-[calc(100%-12px)] data-[state=checked]:before:w-[3px] data-[state=checked]:before:rounded-full data-[state=checked]:before:bg-[var(--accent)] data-[disabled]:pointer-events-none data-[disabled]:text-[var(--text-disabled)]",
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-4 items-center justify-center text-[var(--text-secondary)]">
        <SelectPrimitive.ItemIndicator><MaterialSymbol name="check" className="size-4" /></SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue }
