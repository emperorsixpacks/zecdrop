import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type StepState = "done" | "active" | "next" | "failed";

export interface TimelineStep {
  key: string;
  label: string;
  state: StepState;
  /** What is happening now, or what went wrong. */
  detail?: ReactNode;
}

const SAID: Record<StepState, string> = { done: "done", active: "in progress", next: "not yet", failed: "failed" };

/** A vertical run of steps, each said in words as well as drawn: the marker is a
 * picture, the state is text. The step in progress is the "current" one. */
export function Timeline({ steps, label }: { steps: readonly TimelineStep[]; label: string }) {
  return (
    <ol aria-label={label} className="space-y-0">
      {steps.map((step, index) => (
        <li
          key={step.key}
          aria-current={step.state === "active" ? "step" : undefined}
          data-state={step.state}
          className="relative flex gap-4 pb-5 last:pb-0"
        >
          {index < steps.length - 1 && (
            <span aria-hidden className={cn("absolute top-8 bottom-0 left-[0.8125rem] w-0.5", step.state === "done" ? "bg-foreground" : "bg-border")} />
          )}
          <span
            aria-hidden
            className={cn(
              "z-10 flex size-7 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold",
              step.state === "done" && "border-foreground bg-foreground text-background",
              step.state === "active" && "border-foreground bg-primary text-primary-foreground motion-safe:animate-pulse",
              step.state === "failed" && "border-problem bg-problem text-background",
              step.state === "next" && "border-input bg-background text-muted-foreground",
            )}
          >
            {step.state === "done" ? "✓" : step.state === "failed" ? "!" : ""}
          </span>
          <div className="min-w-0 pt-0.5">
            <p className={cn("text-lg leading-snug", step.state === "active" || step.state === "failed" ? "font-bold" : "font-medium", step.state === "next" && "text-muted-foreground")}>
              {step.label} <span className="sr-only">({SAID[step.state]})</span>
            </p>
            {step.detail !== undefined && step.state !== "next" && (
              <p className={cn("text-base", step.state === "failed" ? "text-problem" : "text-muted-foreground")}>{step.detail}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
