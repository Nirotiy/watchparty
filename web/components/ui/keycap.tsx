import * as React from "react";

import { cn } from "@/lib/utils";

/** 键盘键帽提示（DESIGN.md §5）：最小号 12px、4px 圆角、键面浅渐变（随主题）。 */
function Keycap({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="keycap"
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-[4px] border border-border bg-[linear-gradient(180deg,var(--key-bg-1),var(--key-bg-2))] px-1.5 text-xs font-normal text-foreground/80",
        className,
      )}
      {...props}
    />
  );
}

export { Keycap };
