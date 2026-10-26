// How a batch is described to the operator. Pure, so it is testable.

import type { OperatorBatch } from "@/api/operator/schemas";
import type { PhaseState } from "@/lib/phase";

export type BadgeTone = "outline" | "secondary" | "shielded" | "done" | "destructive";

export interface BatchStatusView {
  label: string;
  tone: BadgeTone;
  /** Extra line under the label, if any. */
  note: string | null;
}

/** The status of one batch. "Final" is claimed only when the whole campaign is
 * settled: the batch view does not carry the required depth, so a confirmed
 * batch before that is "confirming", never "final". */
export function batchStatus(batch: OperatorBatch, phase: PhaseState): BatchStatusView {
  switch (batch.state) {
    case "planned":
      return { label: "Planned", tone: "outline", note: null };
    case "built":
      return { label: "Built", tone: "secondary", note: "Not sent yet" };
    case "broadcast":
      return { label: "Sent", tone: "shielded", note: "Waiting for a block" };
    case "confirmed":
      return phase.phase === "settled"
        ? { label: "Final", tone: "done", note: confirmations(batch.confirmations) }
        : { label: "Confirming", tone: "shielded", note: confirmations(batch.confirmations) };
    case "failed":
      return { label: "Failed", tone: "destructive", note: batch.reason };
  }
}

function confirmations(count: number): string {
  return count === 1 ? "1 confirmation" : `${String(count)} confirmations`;
}
