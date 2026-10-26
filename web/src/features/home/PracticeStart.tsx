import { QueryClientContext } from "@tanstack/react-query";
import { useContext, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { startPractice, type SimulationLoader } from "@/lib/practice-mode";
import { cn } from "@/lib/utils";

/** The button that turns practice mode on and opens the first screen of a payout: the simulation is fetched when it is
 * pressed, from the page's own origin, and nothing is fetched before. If it cannot be fetched nothing has changed, and
 * the person is told. */
export function PracticeStart({
  label,
  variant = "outline",
  size = "lg",
  load,
}: {
  label: string;
  variant?: "default" | "outline";
  size?: "default" | "lg";
  load?: SimulationLoader;
}) {
  const navigate = useNavigate();
  // Read from the context, not asked for: there is no client where this is drawn on its own (a test), and then there is nothing to clear.
  const queryClient = useContext(QueryClientContext);
  const [state, setState] = useState<"idle" | "starting" | "failed">("idle");

  async function start() {
    setState("starting");
    try {
      await startPractice(load);
      // The simulation's answers are the only ones a practice screen may show: what the screens held of a real operator's
      // (its payouts, its health) is not shown under the banner, and is asked for afresh when practice mode is left.
      queryClient?.clear();
      void navigate("/new");
    } catch {
      setState("failed");
    }
  }

  return (
    <>
      <Button
        size={size}
        variant={variant}
        aria-disabled={state === "starting"}
        // The label may be long ("Try it yourself in practice mode") and a phone may be 320px wide: where it does not fit on one line it wraps
        // inside the button, which grows to hold it. On one line it is the size it always was (the height is a minimum, not a height).
        className={cn(
          "h-auto max-w-full py-2.5 text-center leading-snug whitespace-normal aria-disabled:pointer-events-none aria-disabled:opacity-45",
          size === "lg" ? "min-h-14" : "min-h-11",
        )}
        onClick={() => void start()}
      >
        {state === "starting" ? "Starting practice mode…" : label}
      </Button>
      {state === "failed" && (
        <p role="alert" className="basis-full text-base font-medium text-problem">
          Practice mode could not start. Reload the page and try again.
        </p>
      )}
    </>
  );
}
