// Consistency checks a browser can do on a receipt without trusting the
// verifier's word for it:
//
//   1. the answer must match what the LINK claimed (network, declared total,
//      commitment, which transactions);
//   2. the receipt's own totals must equal the sum of its batches.
//
// Anything found here is shown as a clear, calm notice and never hidden.
// Everything compared is public: totals, commitments, transaction ids.

import type { ReceiptQuery } from "@/api/receipt-query";
import type { PublicReceipt } from "@/api/types";
import type { ZecNetwork } from "@/lib/config";
import { parseZatoshi } from "@/lib/zec";

export type ReceiptProblem =
  | { kind: "network_differs"; claimed: ZecNetwork; found: ZecNetwork }
  | { kind: "declared_total_differs"; claimed: string; found: string }
  | { kind: "commitment_differs"; claimed: string; found: string }
  | { kind: "transactions_differ"; missing: string[]; unexpected: string[] }
  | {
      kind: "batches_do_not_add_up";
      field: "declared_total" | "fee_total";
      reported: string;
      sum: string;
    };

function sum(values: readonly string[]): string {
  return values.reduce((total, v) => total + parseZatoshi(v), 0n).toString();
}

/** The values if every one is known; null if any could not be established. */
function allKnown(values: readonly (string | null)[]): string[] | null {
  return values.every((v): v is string => v !== null) ? [...values] : null;
}

/** Problems with `receipt`; `claim` is the link's claim, absent for the demo. */
export function checkReceipt(receipt: PublicReceipt, claim?: ReceiptQuery): ReceiptProblem[] {
  const problems: ReceiptProblem[] = [];

  if (claim) {
    if (claim.network !== receipt.network) {
      problems.push({ kind: "network_differs", claimed: claim.network, found: receipt.network });
    }
    if (claim.declaredTotal !== receipt.declaredTotal) {
      problems.push({
        kind: "declared_total_differs",
        claimed: claim.declaredTotal,
        found: receipt.declaredTotal,
      });
    }
    if (claim.commitment !== receipt.manifestCommitment) {
      problems.push({
        kind: "commitment_differs",
        claimed: claim.commitment,
        found: receipt.manifestCommitment,
      });
    }

    // Batches not built yet have no txid; they cannot be in a link.
    const found = new Set(receipt.batches.flatMap((b) => (b.txid === null ? [] : [b.txid])));
    const claimed = new Set(claim.txids);
    const missing = claim.txids.filter((t) => !found.has(t));
    const unexpected = [...found].filter((t) => !claimed.has(t));
    if (missing.length > 0 || unexpected.length > 0) {
      problems.push({ kind: "transactions_differ", missing, unexpected });
    }
  }

  // Arithmetic only over facts that are all known. A missing fact is already
  // explained by the verifier's findings; guessing a sum would just add noise.
  // And when the verifier itself flagged the total, do not say it twice.
  const verifierFlaggedTotal = receipt.findings.some((f) => f.code === "declared_total_mismatch");
  const nets = allKnown(receipt.batches.map((b) => b.netIntoPool));
  if (!verifierFlaggedTotal && nets !== null) {
    const netSum = sum(nets);
    if (netSum !== parseZatoshi(receipt.declaredTotal).toString()) {
      problems.push({
        kind: "batches_do_not_add_up",
        field: "declared_total",
        reported: receipt.declaredTotal,
        sum: netSum,
      });
    }
  }

  const fees = allKnown(receipt.batches.map((b) => b.fee));
  if (receipt.feeTotal !== null && fees !== null) {
    const feeSum = sum(fees);
    if (feeSum !== parseZatoshi(receipt.feeTotal).toString()) {
      problems.push({
        kind: "batches_do_not_add_up",
        field: "fee_total",
        reported: receipt.feeTotal,
        sum: feeSum,
      });
    }
  }

  return problems;
}
