import { useEffect, useId, useRef, type ReactNode } from "react"

import { cn } from "cn"

// ZecDrop: a sheet for the one question that must be answered before something that
// cannot be undone. It is the browser's own <dialog>, opened as a modal: the page
// behind it goes inert, Tab stays inside, Escape closes it, and focus returns to the
// button that opened it. It rises from the bottom of a phone and sits in the middle of
// a desktop.
//
// Why not a library's dialog: the usual one locks scrolling by adding a <style>
// element to the page, and the operator's Content-Security-Policy ('self' only, no
// inline styles) refuses that. The browser's own modal needs no such element.

interface SheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  className?: string
}

function Sheet({ open, onOpenChange, title, description, children, className }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    if (open && !dialog.open) {
      dialog.showModal()
      // Focus starts on the safe answer when the sheet names one (data-autofocus), else its first button.
      ;(dialog.querySelector<HTMLElement>("[data-autofocus]") ?? dialog.querySelector<HTMLElement>("button"))?.focus()
    }
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      data-slot="sheet"
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      // The browser closes it on Escape by itself; say so to the page too, and for browsers that do not.
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault()
          onOpenChange(false)
        }
      }}
      onCancel={(event) => {
        event.preventDefault()
        onOpenChange(false)
      }}
      // A `close` event arrives some milliseconds after the sheet closed. If the sheet was opened again in between (Escape,
      // then Enter on the button that opens it), the late event is about the closing before and must not close this opening.
      onClose={(event) => {
        if (!event.currentTarget.open) onOpenChange(false)
      }}
      // A click on the dim area is a click on the <dialog> itself: the sheet's own box fills the rest.
      onClick={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false)
      }}
      className={cn(
        "fixed inset-x-0 top-auto bottom-0 m-0 w-full max-w-none border border-foreground bg-background p-0 text-foreground backdrop:bg-foreground/50 sm:inset-0 sm:m-auto sm:h-fit sm:w-[min(32rem,calc(100vw-2rem))] sm:rounded-lg",
        "rounded-t-lg",
        className,
      )}
    >
      <div className="space-y-5 p-6">
        <h2 id={titleId} className="text-[1.75rem] leading-tight font-bold tracking-[-0.02em]">
          {title}
        </h2>
        {description !== undefined && (
          <p id={descriptionId} className="text-base">
            {description}
          </p>
        )}
        {children}
      </div>
    </dialog>
  )
}

export { Sheet }
