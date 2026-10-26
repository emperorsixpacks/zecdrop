import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { shortId } from "@/lib/ids";

import type { NearStatus } from "./model";
import { describeNearStatus } from "./status";

const VARIANT = {
  waiting: "info",
  working: "info",
  check: "info",
  problem: "warning",
  ended: "warning",
  unknown: "warning",
} as const;

/** The operator's report on the swap, in plain words. (The line that does not
 * change, that the campaign counts as funded only when the coin is on chain, is
 * on the panel around it.) */
export function NearStatusCard({ status }: { status: NearStatus }) {
  const d = describeNearStatus(status.status);
  // An address that has lapsed is worth saying again whatever the service last said about it.
  const lapsed = status.expired && d.keepPolling && status.status !== "success";
  return (
    <div className="space-y-3" data-testid="near-status">
      <Alert variant={VARIANT[d.tone]} role={d.tone === "problem" || d.tone === "ended" || d.tone === "unknown" ? "alert" : "status"}>
        <AlertTitle>{d.title}</AlertTitle>
        <AlertDescription className="text-card-foreground">{d.detail}</AlertDescription>
      </Alert>
      {lapsed && <p className="text-base font-semibold">This deposit address has expired. Do not send to it.</p>}
      {status.zecTxids.length > 0 && (
        <p className="text-sm text-muted-foreground">
          The service names the Zcash transaction{status.zecTxids.length === 1 ? "" : "s"}{" "}
          {status.zecTxids.map((txid, i) => (
            <span key={txid}>
              {i > 0 && ", "}
              <span className="mono" title={txid}>
                {shortId(txid)}
              </span>
            </span>
          ))}
          . The operator looks for the coin itself.
        </p>
      )}
    </div>
  );
}
