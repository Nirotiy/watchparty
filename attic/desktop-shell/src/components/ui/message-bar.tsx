import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * WinUI 3 InfoBar: 4px radius, semantic background fills, no decorative color bar.
 * Version A design: pure background tint + matching text color, no left border.
 */
const messageBarVariants = cva(
  "flex items-start gap-2.5 rounded-sm px-3 py-2.5 text-sm",
  {
    variants: {
      variant: {
        info: "bg-[rgba(76,194,255,.12)] text-[#4cc2ff]",
        success: "bg-[rgba(108,203,91,.12)] text-[#6ccb5b]",
        error: "bg-[rgba(255,153,164,.12)] text-[#ff99a4]",
        warning: "bg-[rgba(252,225,0,.12)] text-[#fce100]",
      },
    },
    defaultVariants: {
      variant: "info",
    },
  },
)

function MessageBar({
  className,
  variant,
  children,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof messageBarVariants>) {
  return (
    <div
      role="status"
      className={cn(messageBarVariants({ variant, className }))}
      {...props}
    >
      {children}
    </div>
  )
}

export { MessageBar, messageBarVariants }
