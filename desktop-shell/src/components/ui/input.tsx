import * as React from "react"

import { cn } from "@/lib/utils"

/** WinUI 3 TextBox: 32px tall, 4px radius, ControlFillTransparent + bottom-strong stroke. */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "min-h-8 w-full min-w-0 rounded-sm border border-input bg-[var(--fill-control)] px-3 py-[5px] text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-disabled)] focus-visible:border-[var(--stroke-strong)] winui-focus disabled:bg-transparent disabled:text-[var(--text-disabled)]",
        className,
      )}
      {...props}
    />
  )
}

export { Input }
