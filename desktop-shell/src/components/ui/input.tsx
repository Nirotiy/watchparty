import * as React from "react"

import { cn } from "@/lib/utils"

/** WinUI 3 TextBox: 32px tall, 4px radius, ControlFill + bottom-strong stroke, accent focus underline. */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "min-h-8 w-full min-w-0 rounded-sm border border-input border-b-2 border-b-[rgba(140,140,140,.5)] bg-[var(--fill-control)] px-3 py-[5px] text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-disabled)] focus-visible:border-b-[var(--accent)] aria-invalid:border-b-[#ff99a4] winui-focus disabled:bg-transparent disabled:text-[var(--text-disabled)]",
        className,
      )}
      {...props}
    />
  )
}

export { Input }
