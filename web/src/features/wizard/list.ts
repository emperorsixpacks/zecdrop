// The payout list as the Check stage shows it through the redaction lens.
//
// It exists only in memory, only between creating the campaign and leaving the
// Check stage (see draft.ts), and is built from what the person already had on
// screen in the preview. Rows are named "Person 1", "Person 2": a label made for
// the row, not data from the list.

import type { LensRow } from "@/components/lens/Lens";
import type { PreviewRow } from "@/lib/csv-preview";

export function lensRowsFrom(rows: readonly PreviewRow[]): LensRow[] {
  const out: LensRow[] = [];
  for (const row of rows) {
    // The operator has already read every amount; a row with none cannot be on a created campaign.
    if (row.amount === null) continue;
    const n = out.length + 1;
    out.push({
      id: `person-${String(n)}`,
      label: `Person ${String(n)}`,
      address: row.address,
      amount: row.amount.toString(),
      memo: row.memo === "" ? null : row.memo,
    });
  }
  return out;
}
