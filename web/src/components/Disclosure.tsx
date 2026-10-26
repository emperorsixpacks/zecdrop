import { Collapsible } from "radix-ui";
import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

interface DisclosureProps {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Controlled: the caller says whether it is open (e.g. to open it from a button elsewhere). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  "data-testid"?: string;
}

/** A closed-by-default row: the summary is the whole row's button, a plus or
 * minus on the right says which way it goes. For options and detail that most
 * people never need, so they cost no space until asked for. */
export function Disclosure({ summary, children, defaultOpen = false, open: controlled, onOpenChange, className, "data-testid": testId }: DisclosureProps) {
  const [inner, setInner] = useState(defaultOpen);
  const open = controlled ?? inner;
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={(next) => {
        setInner(next);
        onOpenChange?.(next);
      }}
      className={cn("border-t border-border", className)}
      {...(testId === undefined ? {} : { "data-testid": testId })}
    >
      <Collapsible.Trigger className="flex min-h-12 w-full items-center justify-between gap-4 py-2 text-left text-base font-semibold">
        <span>{summary}</span>
        <span aria-hidden className={cn("mono text-2xl leading-none text-muted-foreground transition-transform duration-300", open && "rotate-45")}>
          +
        </span>
      </Collapsible.Trigger>
      {/* The panel is a one-cell grid whose row grows from nothing to its height (index.css), so it opens and
       * closes without a jump. The padding and the matching negative margin keep a focus ring from being clipped. */}
      <Collapsible.Content className="accordion-panel">
        <div className="accordion-inner -m-2 p-2">
          <div className="pb-5">{children}</div>
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
