import { cn } from "@/lib/utils"

/**
 * WinUI ProgressRing（M2-3）：约 90° 短弧 + 线性旋转（1s），reduced-motion 下停转成静态弧。
 * 仅作视觉加载指示，语义由旁侧文案/role=status 承担，故 aria-hidden。
 */
export function ProgressRing({ size = 20, className }: { size?: 16 | 20 | 24 | 32; className?: string }) {
  return <span aria-hidden="true" data-slot="progress-ring" data-size={size} className={cn("winui-ring", className)}>
    <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.5" /></svg>
  </span>
}
