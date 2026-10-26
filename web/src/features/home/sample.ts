// The public 8-payout sample list behind the home page's lens: the same CSV
// the real testnet run was made from (examples/demo-recipients.testnet.csv).
// The addresses are testnet addresses published in this repository; nothing
// here is anyone's private data. Rows are labelled "Person 1".."Person 8"
// because a list has people on it; the public receipt of the same batch can
// only count outputs, and labels its rows "Output N".

import csv from "../../../../examples/demo-recipients.testnet.csv?raw";

import type { LensRow } from "@/components/lens/Lens";
import { lensRowsFrom } from "@/features/wizard/list";
import { previewPayouts } from "@/lib/csv-preview";

export function samplePayoutRows(text: string = csv): LensRow[] {
  const preview = previewPayouts(text);
  if (preview.kind !== "rows") throw new Error("the bundled sample list is not a payout list");
  const rows = lensRowsFrom(preview.rows);
  if (rows.length !== preview.rows.length) throw new Error("the bundled sample list has an unreadable amount");
  return rows;
}
