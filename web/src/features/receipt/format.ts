// Small display rules for the receipt page.

import { findingBatch, isFailure, type ReceiptFinding } from "@/api/findings";
import type { PublicReceipt, PublicReceiptBatch, ReceiptPool } from "@/api/types";
import type { PhaseState } from "@/lib/phase";

export const POOL_LABEL: Record<ReceiptPool, string> = {
  ironwood: "Ironwood",
  orchard: "Orchard",
};

export type BatchState =
  | "problem"
  | "not_built"
  | "not_found"
  | "unconfirmed"
  | "confirming"
  | "final";

export const BATCH_STATE_LABEL: Record<BatchState, string> = {
  problem: "Needs attention",
  not_built: "Not sent yet",
  not_found: "Not on the chain yet",
  unconfirmed: "Waiting for a block",
  confirming: "Confirming",
  final: "Final",
};

/** Findings about one batch. */
function aboutBatch(findings: readonly ReceiptFinding[], index: number): ReceiptFinding[] {
  return findings.filter((f) => findingBatch(f) === index);
}

/** Where one batch stands.
 *
 * "Final" needs evidence. The receipt does not carry the required confirmation
 * depth, so it is claimed only when
 *   - the verifier reports the whole campaign settled, or
 *   - the verifier flagged other batches as `batch_pending` and not this one:
 *     it adds that finding to EVERY located batch below the required depth, so
 *     a located batch without it has reached the depth.
 * An operator-built receipt never carries `batch_pending`, so for it only the
 * first rule applies and nothing is called final early. */
export function batchState(
  batch: PublicReceiptBatch,
  phase: PhaseState,
  findings: readonly ReceiptFinding[] = [],
): BatchState {
  const mine = aboutBatch(findings, batch.index);
  if (mine.some(isFailure)) return "problem";
  if (batch.txid === null) return "not_built";
  if (mine.some((f) => f.code === "tx_not_found")) return "not_found";
  if (batch.confirmations === 0) return "unconfirmed";
  if (phase.phase === "settled") return "final";

  const verifierReportsPending = findings.some((f) => f.code === "batch_pending");
  const thisOnePending = mine.some((f) => f.code === "batch_pending");
  return verifierReportsPending && !thisOnePending && mine.length === 0 ? "final" : "confirming";
}

/** True while a batch has not reached the point the verifier calls final. */
export function isPending(state: BatchState): boolean {
  return state !== "final";
}

export function confirmationsText(count: number): string {
  return count === 1 ? "1 confirmation" : `${String(count)} confirmations`;
}

/** How many shielded outputs the receipt's batches have in all, or null when some
 * batch's count could not be established (a sum with a hole in it says nothing). */
export function outputCount(receipt: PublicReceipt): number | null {
  let total = 0;
  for (const batch of receipt.batches) {
    if (batch.shieldedActions === null) return null;
    total += batch.shieldedActions;
  }
  return total;
}
