import * as React from "react"
import { cn } from "cn"
import { Popover as PopoverPrimitive } from "radix-ui"

// ZecDrop: hand-written on Radix. A small surface for the longer explanation that
// does not belong inline.
const Popover = PopoverPrimitive.Root
const PopoverTrigger = PopoverPrimitive.Trigger

function PopoverContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn(
          "z-50 w-[min(22rem,calc(100vw-1.5rem))] rounded-2xl border border-border bg-popover p-4 text-sm text-popover-foreground shadow-[0_24px_48px_-20px_color-mix(in_srgb,var(--foreground)_55%,transparent)]",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
