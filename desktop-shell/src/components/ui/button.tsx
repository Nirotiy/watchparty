import * as React from "react"
import { Slot } from "radix-ui"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * WinUI 3 button set: Default (subtle fill + ControlStrokeColorDefault),
 * Accent (AccentFillColorDefault) and Subtle (transparent + SubtleFillColor).
 * Heights follow the 32px control ramp; 24px is the compact icon variant.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-sm border text-sm font-normal outline-none transition-[background-color,border-color,color] duration-200 ease-[cubic-bezier(.1,1,.25,1)] disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:size-4 winui-focus",
  {
    variants: {
      variant: {
        default: "border-input bg-[var(--fill-control)] text-[var(--text-primary)] hover:bg-[var(--fill-control-secondary)] active:bg-[var(--fill-control)] active:text-[var(--text-secondary)] disabled:border-input disabled:bg-[var(--fill-control-disabled)] disabled:text-[var(--text-disabled)]",
        accent: "border-transparent bg-[var(--accent)] text-[var(--fg-on-accent)] hover:bg-[var(--accent-hover)] active:bg-[var(--accent-press)] disabled:bg-[var(--fill-control-disabled)] disabled:text-[var(--text-disabled)]",
        outline: "border-input bg-[var(--fill-control)] text-[var(--text-primary)] hover:bg-[var(--fill-control-secondary)] active:bg-[var(--fill-control)] active:text-[var(--text-secondary)] disabled:border-input disabled:bg-[var(--fill-control-disabled)] disabled:text-[var(--text-disabled)]",
        ghost: "border-transparent bg-transparent text-[var(--text-primary)] hover:bg-[var(--fill-subtle-hover)] active:bg-[var(--fill-subtle-press)] active:text-[var(--text-secondary)] disabled:bg-transparent disabled:text-[var(--text-disabled)]",
      },
      size: {
        default: "min-h-8 px-3 py-[5px]",
        sm: "min-h-6 px-2 py-[2px] text-xs",
        icon: "size-8 p-0",
        "icon-sm": "size-6 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Component = asChild ? Slot.Root : "button"
  return <Component data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

export { Button, buttonVariants }
