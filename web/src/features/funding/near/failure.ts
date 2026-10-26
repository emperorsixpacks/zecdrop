// What a failed NEAR call says. The operator is the only thing that talks to the
// price service, so the page sees the operator's answer, never the service's.

import { OperatorApiError } from "@/api/operator/client";
import { KNOWN_ERROR_CODES } from "@/api/operator/schemas";
import { explainFailure, type Explained } from "@/features/operator/messages";
import type { CoinUnit } from "@/lib/units";

/** The words for a failure of a NEAR call. When the operator could not get an
 * answer from the service (a gateway or availability error), say that plainly,
 * and that nothing was created; anything else is explained like any operator error. */
export function describeNearFailure(error: unknown, unit?: CoinUnit): Explained {
  // A code this page has a sentence for says it in its own words (messages.ts).
  const known = error instanceof OperatorApiError && error.api !== null && (KNOWN_ERROR_CODES as readonly string[]).includes(error.api.code);
  if (!known && error instanceof OperatorApiError && error.kind === "api") {
    const status = error.status;
    const upstream = status === 502 || status === 503 || status === 504;
    if (upstream) {
      return {
        title: "The price service could not be reached",
        detail:
          "The operator could not get an answer from NEAR Intents. Check that its computer is online and try again. Nothing was created.",
      };
    }
  }
  return unit === undefined ? explainFailure(error) : explainFailure(error, unit);
}
