import * as React from "react"

import { Button } from "@/components/ui/button"

/** 复制按钮：点击把 value 写进剪贴板，短暂显示「已复制」后复位（不弹 toast）。 */
export function CopyButton({ value, label = "复制", className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => clearTimeout(timer.current), [])
  return <Button
    type="button"
    variant="outline"
    size="sm"
    className={className}
    onClick={() => {
      void navigator.clipboard?.writeText(value).then(() => {
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1600)
      }).catch(() => undefined)
    }}
  >{copied ? "已复制" : label}</Button>
}
