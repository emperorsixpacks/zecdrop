import type { CSSProperties } from "react";

/** Three rows that are only bars: what a list will look like once there is one, with the amounts
 * and names already kept back. Decoration only, so it is hidden from assistive technology and holds
 * no text. The bars wipe in one after another when Lively, and are simply there otherwise. */
export function GhostRows({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden className="divide-y divide-border border-y border-border" data-testid="ghost-rows">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-6 px-2 py-4">
          <span className="redacted bar-in block h-5 w-[44%]" style={{ "--i": i } as CSSProperties} />
          <span className="redacted bar-in block h-5 w-[22%]" style={{ "--i": i + 1 } as CSSProperties} />
        </div>
      ))}
    </div>
  );
}
