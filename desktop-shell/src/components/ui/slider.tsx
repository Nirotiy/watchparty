import * as React from "react"
import { Slider as SliderPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

interface SliderProps extends React.ComponentProps<typeof SliderPrimitive.Root> {
  size?: "default" | "compact"
  /**
   * `seek` 是进度条形态（M2-2 用户选定 B 版）：无可见拇指，整条可拖；
   * 鼠标悬停时在指针处浮出抓点，给了 `formatHover` 再带上时间气泡。
   * 无拇指的键盘可达性靠一个不可见 Thumb（opacity 0）承担，焦点环画在轨道上。
   */
  variant?: "default" | "seek"
  formatHover?: (value: number) => string
}

/**
 * WinUI 3 Slider（B 版几何 = 6px 胶囊轨 / hover 8px / 16px 圆环拇指）。
 * 几何由 `.winui-slider*` 在 index.css 定义；双环拇指与悬停浮层无法只用 utility 表达。
 */
function Slider({ className, defaultValue, value, min = 0, max = 100, size = "default", variant = "default", formatHover, onPointerMove, onPointerLeave, ...props }: SliderProps) {
  const values = React.useMemo(
    () => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min]),
    [defaultValue, max, min, value],
  )
  const [hover, setHover] = React.useState<{ percent: number; text: string | null } | null>(null)

  const handlePointerMove = variant === "seek" ? (event: React.PointerEvent<HTMLDivElement>) => {
    onPointerMove?.(event)
    if (event.pointerType !== "mouse") return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0
    setHover({ percent: ratio * 100, text: formatHover ? formatHover(min + ratio * (max - min)) : null })
  } : onPointerMove
  const handlePointerLeave = variant === "seek" ? (event: React.PointerEvent<HTMLDivElement>) => {
    onPointerLeave?.(event)
    setHover(null)
  } : onPointerLeave

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      data-size={size}
      data-variant={variant}
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      className={cn("winui-slider w-full", className)}
      {...props}
    >
      <SliderPrimitive.Track className="winui-slider-track">
        <SliderPrimitive.Range className="winui-slider-range" />
      </SliderPrimitive.Track>
      {values.map((_, index) => (
        <SliderPrimitive.Thumb key={index} className="winui-slider-thumb" />
      ))}
      {variant === "seek" && hover ? (
        <span aria-hidden="true" className="winui-slider-hover" style={{ left: `${hover.percent}%` }}>
          {hover.text ? <span className="winui-slider-hover-bubble">{hover.text}</span> : null}
          <span className="winui-slider-hover-dot" />
        </span>
      ) : null}
    </SliderPrimitive.Root>
  )
}

export { Slider }
