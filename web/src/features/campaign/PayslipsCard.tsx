import { useEffect, useId, useState } from "react";

import type { PayslipRow } from "@/api/operator/schemas";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FailureNotice } from "@/features/operator/FailureNotice";
import { useHealth, usePayslips } from "@/features/operator/hooks";
import { SendPayslip } from "@/features/payslip/SendPayslip";
import { shortId } from "@/lib/ids";
import { useCoinUnit } from "@/lib/units";
import { formatZec } from "@/lib/zec";

import { PAYSLIPS_VISIBLE_MS, PAYSLIPS_WORDING } from "./payslips-wording";

/** The payslips of a settled campaign (REQ-PAY-005): every person, and for each a way to send their own payslip as a link
 * or a QR code (the payslip page's own SendPayslip, with its warning first).
 *
 * The operator gives them only when asked, and they live in this component's state and nowhere else: not in the query
 * cache, not in storage, not in a URL. A link is made only when the person asks for one. They are hidden again when
 * the person presses Hide, after ten minutes, and when they leave the page. */
export function PayslipsCard({ campaignId }: { campaignId: string }) {
  const health = useHealth();
  const { state, request, clear } = usePayslips(campaignId);

  const shown = state.status === "ready";
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(clear, PAYSLIPS_VISIBLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [shown, clear]);

  return (
    <div className="max-w-[64ch] space-y-5">
      <p className="text-base">{PAYSLIPS_WORDING.lead}</p>
      <Alert variant="warning" role="note">
        <AlertTitle>{PAYSLIPS_WORDING.warningTitle}</AlertTitle>
        <AlertDescription className="text-card-foreground">{PAYSLIPS_WORDING.warning}</AlertDescription>
      </Alert>

      {health.isPending ? (
        <Skeleton className="h-10 w-48" />
      ) : health.data?.mock === true ? (
        <p className="text-base text-muted-foreground">{PAYSLIPS_WORDING.mock}</p>
      ) : state.status === "ready" ? (
        <div className="space-y-4">
          <PayslipList rows={state.payslips.payslips} />
          {state.payslips.unmatchedOutputs > 0 && (
            <p className="text-base font-medium text-problem">
              {state.payslips.unmatchedOutputs === 1 ? "1 output matches" : `${String(state.payslips.unmatchedOutputs)} outputs match`} no payout. Run the
              audit.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button variant="outline" onClick={clear}>
              Hide payslips
            </Button>
            <p className="text-sm text-muted-foreground">{PAYSLIPS_WORDING.hidden}</p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <Button
            onClick={() => {
              void request();
            }}
            disabled={state.status === "loading"}
          >
            {state.status === "loading" ? "Fetching…" : "Show payslips"}
          </Button>
          {state.status === "failed" && <FailureNotice error={state.error} />}
        </div>
      )}
    </div>
  );
}

/** One ruled row a person: who (the list's number and the note), the address short and the amount, and a button that
 * opens the ways to send their payslip. One person's at a time. */
function PayslipList({ rows }: { rows: readonly PayslipRow[] }) {
  const unit = useCoinUnit();
  const [open, setOpen] = useState<number | null>(null);
  const base = useId();
  return (
    <ul aria-label="Payslips" className="divide-y divide-border border-y border-border">
      {rows.map((row) => {
        const who = `${base}-who-${String(row.number)}`;
        const panel = `${base}-send-${String(row.number)}`;
        const opened = open === row.number && row.payslip !== null;
        return (
          <li key={row.number} className="space-y-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div className="min-w-0 space-y-1">
                <p id={who} className="text-base font-semibold">
                  Person {row.number}
                  {row.memo !== null && row.memo !== "" && <span className="font-normal text-muted-foreground"> ({row.memo})</span>}
                </p>
                <p className="flex flex-wrap gap-x-4 text-sm">
                  <span className="mono">{shortId(row.address, 6)}</span>
                  <span className="mono">
                    {formatZec(row.amount)} {unit}
                  </span>
                </p>
              </div>
              {row.payslip !== null && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-expanded={opened}
                  aria-controls={opened ? panel : undefined}
                  aria-describedby={who}
                  onClick={() => {
                    setOpen(opened ? null : row.number);
                  }}
                >
                  {opened ? "Close" : "Send payslip"}
                </Button>
              )}
            </div>
            {row.payslip === null && <p className="text-sm font-medium text-problem">{PAYSLIPS_WORDING.missing}</p>}
            {opened && row.payslip !== null && (
              <div id={panel}>
                <SendPayslip payslip={row.payslip} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
