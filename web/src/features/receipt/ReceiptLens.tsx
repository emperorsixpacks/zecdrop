import { useMemo } from "react";

import type { PublicReceipt } from "@/api/types";
import { LensList, type LensRow } from "@/components/lens/Lens";

/** Rows shown before "and N more": a receipt can have hundreds of outputs. */
const SHOWN = 12;

/** The receipt through the public lens, and only that one. A row stands for one
 * shielded output; the chain gives the count and nothing about the rest, so every
 * row is a bar, and the rows are named "Output N", never "Person N". */
export function ReceiptLens({ receipt }: { receipt: PublicReceipt }) {
  const { rows, total, unknownBatches } = useMemo(() => {
    const rows: LensRow[] = [];
    let total = 0;
    const unknownBatches: number[] = [];
    for (const batch of receipt.batches) {
      if (batch.shieldedActions === null) {
        unknownBatches.push(batch.index);
        continue;
      }
      for (let i = 0; i < batch.shieldedActions; i += 1) {
        total += 1;
        if (rows.length < SHOWN) rows.push({ id: `output-${String(total)}`, label: `Output ${String(total)}` });
      }
    }
    return { rows, total, unknownBatches };
  }, [receipt.batches]);

  if (rows.length === 0 && unknownBatches.length === 0) return null;

  return (
    <section aria-labelledby="public-view-heading" className="space-y-4">
      <h2 id="public-view-heading" className="text-[1.75rem] leading-tight font-bold tracking-[-0.02em]">
        What the public sees
      </h2>
      <LensList rows={rows} mode="public" selectedId={null} />
      {total > rows.length && (
        <p className="text-sm text-muted-foreground">And {total - rows.length} more outputs, hidden the same way.</p>
      )}
      {unknownBatches.length > 0 && (
        <p className="text-sm text-muted-foreground">
          The output count of {unknownBatches.length === 1 ? "batch" : "batches"} {unknownBatches.join(", ")} could not be established.
        </p>
      )}
      <p className="max-w-[64ch] text-base">
        The chain shows how many outputs there are, the total and the fee. Who got each output, and how much, stays hidden. An
        auditor with the campaign&apos;s viewing key can see every row.
      </p>
    </section>
  );
}
