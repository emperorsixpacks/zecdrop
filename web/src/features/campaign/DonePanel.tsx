import { Link } from "react-router";

import type { OperatorCampaign } from "@/api/operator/schemas";
import { Confetti } from "@/components/Confetti";
import { CopyButton } from "@/components/CopyButton";
import { Stamp } from "@/components/Stamp";
import { Button } from "@/components/ui/button";
import { FailureNotice } from "@/features/operator/FailureNotice";

import { useReceiptShare } from "./useReceiptShare";

/** The campaign is settled: the stamp comes down once, then the things to do next.
 * "Open public receipt" and "Copy receipt link" wait for the receipt the operator builds. */
export function DonePanel({
  campaign,
  onAuditor,
  onPayslips,
  celebrate = false,
}: {
  campaign: OperatorCampaign;
  onAuditor: () => void;
  /** Open the section where each person's payslip is sent. */
  onPayslips: () => void;
  /** This page watched it settle: a short burst of confetti beside the stamp, when Lively. */
  celebrate?: boolean;
}) {
  const { receipt, link, shown } = useReceiptShare(campaign);
  const ready = shown !== null && link?.ok === true;
  const batches = campaign.batchCount;

  return (
    <section aria-labelledby="done-heading" className="space-y-6">
      <div className="relative flex flex-wrap items-center gap-x-8 gap-y-4">
        {celebrate && <Confetti />}
        <Stamp>Sealed</Stamp>
        <div className="space-y-1">
          <h2 id="done-heading" className="text-[1.75rem] leading-tight font-bold tracking-[-0.02em]">
            All {batches === 1 ? "1 batch is" : `${String(batches)} batches are`} confirmed
          </h2>
          <p className="text-base text-muted-foreground">Anyone with the receipt link can check the totals.</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3" aria-busy={receipt.isPending}>
        {ready ? (
          shown.complete ? (
            <Button asChild size="lg">
              <a href={shown.text} target="_blank" rel="noopener noreferrer">
                Open public receipt<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
          ) : (
            <Button asChild size="lg">
              <Link to={shown.text}>Open public receipt</Link>
            </Button>
          )
        ) : (
          <Button size="lg" disabled>
            Open public receipt
          </Button>
        )}
        {ready ? (
          <CopyButton value={shown.text} label="Copy receipt link" text="Copy receipt link" size="lg" />
        ) : (
          <Button size="lg" variant="outline" disabled>
            Copy receipt link
          </Button>
        )}
        <Button size="lg" variant="outline" onClick={onPayslips}>
          Send payslips
        </Button>
        <Button size="lg" variant="outline" onClick={onAuditor}>
          Give an auditor access
        </Button>
      </div>
      {receipt.isError && <FailureNotice error={receipt.error} onRetry={() => void receipt.refetch()} retrying={receipt.isFetching} />}
    </section>
  );
}
