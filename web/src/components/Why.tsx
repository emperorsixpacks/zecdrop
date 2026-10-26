import type { ReactNode } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** A small "?" that opens the longer explanation, so the page itself can stay
 * short. The button is 44px square for fingers; the glyph is small. With `text`
 * the button says that word instead ("Why?"), as a link-like control. With
 * `inline` it sits at the end of a sentence without stretching that line. */
export function Why({ label, text, children, inline = false }: { label: string; text?: string; children: ReactNode; inline?: boolean }) {
  return (
    <Popover>
      {text === undefined ? (
        <PopoverTrigger
          data-slot="why-trigger"
          aria-label={label}
          className={cn(
            "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground",
            inline && "-my-3 align-middle",
          )}
        >
          <span aria-hidden className="flex size-5 items-center justify-center rounded-full border border-current text-xs font-bold">
            ?
          </span>
        </PopoverTrigger>
      ) : (
        <PopoverTrigger
          data-slot="why-trigger"
          aria-label={label}
          className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-base font-semibold underline underline-offset-4 hover:bg-secondary"
        >
          {text}
        </PopoverTrigger>
      )}
      <PopoverContent>{children}</PopoverContent>
    </Popover>
  );
}
