import type { FundingSource } from "@/api/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import { FUNDING_SOURCE_WORDING as WORDING } from "./funding-source-wording";

/** What the deposit spent, once the operator has read it (REQ-FUND-004); nothing until then. A transparent deposit is a
 * warning, never an error: it is on the chain already, and the payout can still be sent. Inside a live region (`quiet`) it
 * does not announce itself a second time. */
export function DepositSource({ source, pretend, quiet = false }: { source: FundingSource | null; pretend: boolean; quiet?: boolean }) {
  if (source === null) return null;
  if (source === "shielded") {
    return (
      <p className="max-w-[64ch] text-base" data-testid="deposit-source">
        {pretend ? WORDING.shieldedPretend : WORDING.shielded}
      </p>
    );
  }
  return (
    <Alert variant="warning" data-testid="deposit-source" className="max-w-[64ch]" {...(quiet ? { role: "note" } : {})}>
      <AlertTitle>{WORDING.transparentTitle}</AlertTitle>
      <AlertDescription className="text-card-foreground">{pretend ? WORDING.transparentPretend : WORDING.transparent}</AlertDescription>
    </Alert>
  );
}
