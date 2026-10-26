import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

// ZecDrop: restyled for web/DESIGN.md. The primary button is ink (the marker in the dark set); every
// size is at least 44px tall, so it is a comfortable touch target.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-transparent font-semibold whitespace-nowrap transition-[background-color,color,transform] select-none active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // The one action that matters on a screen.
        default: "lift bg-primary text-primary-foreground hover:brightness-95 dark:hover:brightness-110",
        // A strong, quiet alternative: an ink outline that fills on hover.
        outline: "border-foreground bg-transparent text-foreground hover:bg-foreground hover:text-background",
        secondary: "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_srgb,var(--secondary),var(--foreground)_8%)]",
        ghost: "text-foreground hover:bg-secondary",
        destructive: "border-destructive text-destructive hover:bg-destructive hover:text-background",
        link: "h-auto min-h-11 px-1 text-link underline underline-offset-4 hover:bg-secondary",
      },
      size: {
        default: "h-11 px-5 text-base",
        sm: "h-11 px-4 text-sm",
        xs: "h-11 px-3 text-sm",
        lg: "h-14 px-7 text-xl",
        icon: "size-11",
        "icon-xs": "size-11",
        "icon-sm": "size-11",
        "icon-lg": "size-14",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
