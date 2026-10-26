import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

// ZecDrop: a notice is a block with a thick rule on its left, not a tinted box.
const alertVariants = cva(
  "group/alert relative grid w-full gap-1 border-l-4 py-1 pl-4 text-left text-base has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18",
  {
    variants: {
      variant: {
        default: "border-foreground text-card-foreground",
        destructive: "border-problem text-card-foreground",
        info: "border-foreground/40 text-card-foreground",
        warning: "border-l-[6px] border-double border-foreground text-card-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant,
  role,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      // `alert` is assertive and interrupts screen readers, so only the destructive
      // variant gets it by default; the rest are polite `status`.
      role={role ?? (variant === "destructive" ? "alert" : "status")}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("font-semibold [&_a]:underline [&_a]:underline-offset-3", className)}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-base text-muted-foreground [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-3",
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("absolute top-2 right-2", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
