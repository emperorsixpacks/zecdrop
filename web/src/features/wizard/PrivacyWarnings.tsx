import { useId } from "react";
import { Link } from "react-router";

import { warningMessage, type PrivacyWarning } from "@/api/warnings";
import { Why } from "@/components/Why";

interface PrivacyWarningsProps {
  /** The core's warnings for the current plan, already validated by
   * parsePrivacyWarnings. The type carries only a code and a count or batch
   * index, so there is no way to hand this component a recipient's address,
   * amount or memo. */
  warnings: readonly PrivacyWarning[];
}

function summary(count: number): string {
  if (count === 0) return "No privacy warnings.";
  return count === 1 ? "1 privacy warning." : `${String(count)} privacy warnings.`;
}

/** The short form of a warning, in plain words. The core's own sentence is the one
 * behind "Why?", word for word. */
function chipText(warning: PrivacyWarning): string {
  switch (warning.code) {
    case "singleton_campaign":
      return "Only 1 person: the total is their amount";
    case "small_campaign":
      return `Only ${String(warning.recipients)} people: amounts are easy to guess`;
    case "two_recipient_batch":
      return `Batch ${String(warning.batchIndex)}: two people can guess each other's amount`;
    case "uniform_batch":
      return `Batch ${String(warning.batchIndex)}: equal amounts are easy to see`;
  }
}

const chip = "inline-flex min-h-11 items-center gap-1 rounded-full border border-foreground pr-1 pl-4 text-base";

/** Privacy warnings as short chips, each with a "Why?" that opens the full sentence.
 *
 * Accessibility: the heading names the region and the count; a visually hidden
 * status line announces changes when the plan is edited; every chip is text, so
 * nothing relies on colour. */
export function PrivacyWarnings({ warnings }: PrivacyWarningsProps) {
  const headingId = useId();
  const count = warnings.length;

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-xl font-bold tracking-tight">
        Privacy warnings{count > 0 ? ` (${String(count)})` : ""}
      </h2>
      <p role="status" className="sr-only">
        {summary(count)}
      </p>

      {count === 0 ? (
        <ul className="flex flex-wrap gap-2">
          <li className={chip}>
            No privacy warnings
            <Why label="Why: no privacy warnings" text="Why?">
              <p>
                No privacy warnings for this plan. That does not make the payout private: totals, fees and batch sizes are always
                public. See{" "}
                <Link to="/privacy" className="font-medium underline underline-offset-4">
                  how privacy works
                </Link>
                .
              </p>
            </Why>
          </li>
        </ul>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {warnings.map((warning, index) => (
            <li key={`${warning.code}-${String(index)}`} className={chip}>
              {chipText(warning)}
              <Why label={`Why: ${chipText(warning)}`} text="Why?">
                <p>{warningMessage(warning)}</p>
              </Why>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
