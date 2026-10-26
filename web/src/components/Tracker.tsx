import { Link } from "react-router";

import { cn } from "@/lib/utils";

export interface TrackerStage {
  key: string;
  label: string;
  /** Where a finished stage can be revisited; absent when it cannot (the campaign already exists). */
  to?: string;
}

interface TrackerProps {
  stages: readonly TrackerStage[];
  /** The index of the stage the person is on. */
  current: number;
}

/** The three stages of a payout, as a slim line: Payouts, Check, Send. The only
 * numbered thing on the screen, because it is a real sequence. */
export function Tracker({ stages, current }: TrackerProps) {
  return (
    <nav aria-label="Progress">
      <ol className="flex items-center gap-2 sm:gap-3">
        {stages.map((stage, index) => {
          const state = index < current ? "done" : index === current ? "current" : "next";
          const body = (
            <>
              <span
                aria-hidden
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold",
                  state === "current" && "border-foreground bg-primary text-primary-foreground",
                  state === "done" && "border-foreground bg-foreground text-background",
                  state === "next" && "border-input text-muted-foreground",
                )}
              >
                {state === "done" ? "✓" : index + 1}
              </span>
              <span className={cn("text-base", state === "current" ? "font-bold" : state === "done" ? "font-medium" : "text-muted-foreground")}>
                {stage.label}
              </span>
              {state === "done" && <span className="sr-only">(done)</span>}
            </>
          );
          return (
            <li key={stage.key} className="flex flex-1 items-center gap-2 sm:gap-3 last:flex-none">
              {state === "done" && stage.to !== undefined ? (
                <Link to={stage.to} className="flex min-h-11 items-center gap-2">
                  {body}
                </Link>
              ) : (
                <span aria-current={state === "current" ? "step" : undefined} className="flex min-h-11 items-center gap-2">
                  {body}
                </span>
              )}
              {index < stages.length - 1 && <span aria-hidden className={cn("h-0.5 flex-1", index < current ? "bg-foreground" : "bg-border")} />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
