import * as React from "react"
import { Slider as SliderPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

interface SliderProps extends React.ComponentProps<typeof SliderPrimitive.Root> {
  /** `compact` matches WinUI's smaller volume slider (14px thumb on a 2px rail). */
  size?: "default" | "compact"
}

/**
 * WinUI 3 Slider. Geometry is defined by `.winui-slider*` in index.css because the
 * two-layer thumb (opaque ring + solid accent dot) and the 4→5px hover rail cannot
 * be expressed with utilities alone.
 */
function Slider({ className, defaultValue, value, min = 0, max = 100, size = "default", ...props }: SliderProps) {
  const values = React.useMemo(
    () => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min]),
    [defaultValue, max, min, value],
  )

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      data-size={size}
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn("winui-slider w-full", className)}
      {...props}
    >
      <SliderPrimitive.Track className="winui-slider-track">
        <SliderPrimitive.Range className="winui-slider-range" />
      </SliderPrimitive.Track>
      {values.map((_, index) => (
        <SliderPrimitive.Thumb key={index} className="winui-slider-thumb" />
      ))}
    </SliderPrimitive.Root>
  )
}

export { Slider }
