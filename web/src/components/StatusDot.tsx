import { phaseLabel, phaseSentence, type PhaseState } from "@/lib/phase";
import { cn } from "@/lib/utils";

const DOT: Record<PhaseState["phase"], string> = {
  draft: "border-2 border-input",
  awaiting_funding: "border-2 border-foreground",
  funded: "bg-foreground",
  sending: "bg-primary ring-2 ring-foreground",
  settled: "bg-verified",
  failed: "bg-problem",
};

/** Just the dot, for a place where the words are already said. */
export function PhaseDot({ phase, className }: { phase: PhaseState; className?: string }) {
  return (
    <span aria-hidden className={cn("size-3 shrink-0 rounded-full", DOT[phase.phase], phase.phase === "sending" && "motion-safe:animate-pulse", className)} />
  );
}

/** A campaign's phase as a dot and a word. The dot's shape and fill carry the
 * state as well as its colour, and the word always comes with it. */
export function StatusDot({ phase, className }: { phase: PhaseState; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-base", className)} title={phaseSentence(phase)}>
      <PhaseDot phase={phase} />
      {phaseLabel(phase.phase)}
    </span>
  );
}
