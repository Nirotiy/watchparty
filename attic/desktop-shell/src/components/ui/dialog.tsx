import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * 统一对话框（M2-2 用户选定 B 版）：radix Dialog 行为层（portal / 焦点陷阱 / Esc / 关闭回焦），
 * 外观默认 560 宽圆角 8；`size="compact"` 420 紧凑确认；`danger` 红描边；遮罩统一 62% 无模糊。
 * 标题语义用 aria-label 承担；布局（标题/正文/页脚）由调用方按现有排版写。
 */
export function Dialog({ open, onOpenChange, label, size = "default", danger = false, className, overlayClassName, children }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  label: string
  size?: "default" | "compact"
  danger?: boolean
  className?: string
  overlayClassName?: string
  children: React.ReactNode
}) {
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlayClassName ?? "winui-dialog-scrim"} />
      <DialogPrimitive.Content
        aria-label={label}
        data-size={size}
        data-danger={danger ? "" : undefined}
        className={cn("winui-dialog", className)}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>
}
