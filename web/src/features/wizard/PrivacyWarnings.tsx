import { useId } from "react";
import { Link } from "react-router";

import { warningMessage, warningTitle, type PrivacyWarning } from "@/api/warnings";
import { Badge } from "@/components/ui/badge";

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

/** Privacy warnings for the review step.
 *
 * Accessibility: the heading names the region and the count; a visually
 * hidden status line announces changes when the plan is edited; each warning
 * has a text title and a full sentence, so nothing relies on colour. */
export function PrivacyWarnings({ warnings }: PrivacyWarningsProps) {
  const headingId = useId();
  const count = warnings.length;

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-lg font-semibold tracking-tight">
        Privacy warnings{count > 0 ? ` (${String(count)})` : ""}
      </h2>
      <p role="status" className="sr-only">
        {summary(count)}
      </p>

      {count === 0 ? (
        <p className="rounded-lg border p-4 text-sm">
          No privacy warnings for this plan. That does not make the payout private: totals, fees
          and batch sizes are always public. See the{" "}
          <Link to="/privacy" className="font-medium text-link underline underline-offset-4">
            privacy boundary
          </Link>
          .
        </p>
      ) : (
        <ul className="space-y-2">
          {warnings.map((warning, index) => (
            <li
              key={`${warning.code}-${String(index)}`}
              className="space-y-1.5 rounded-lg border border-link/40 bg-primary/10 p-3 text-sm"
            >
              <Badge variant="outline">{warningTitle(warning.code)}</Badge>
              <p>{warningMessage(warning)}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
