// What a payout list turns into: batches, their fees, their totals and the privacy warnings. A port of the operator's planner
// (crates/drop-core/src/planner.rs), its fee (crates/drop-core/src/fee.rs, which lib/fees.ts already mirrors) and its
// warnings (crates/drop-core/src/warnings.rs, whose sentences api/warnings.ts already holds).
//
// This is where the list stops being a list: the plan keeps how many recipients each batch has and what it adds up to,
// which is what the public chain would show, and nothing else. The addresses, amounts and memos are not in it.

import { warningMessage, type PrivacyWarning } from "@/api/warnings";
import { estimateBatchFee, type FeePolicyName } from "@/lib/fees";

import { MAX_MONEY, type PayoutRow } from "./csv";

/** A campaign with fewer recipients than this has a small anonymity set. */
const SMALL_CAMPAIGN_RECIPIENTS = 5;

export interface PlannedBatch {
  index: number;
  recipients: number;
  /** Zatoshi: what enters the shielded pool. */
  total: bigint;
  /** Zatoshi. */
  fee: bigint;
  /** Zatoshi: the total plus the fee. */
  required: bigint;
}

/** A warning as the operator sends it: its own fields, and the sentence in `message`. */
export type WarningView =
  | { code: "singleton_campaign"; message: string }
  | { code: "small_campaign"; recipients: number; message: string }
  | { code: "two_recipient_batch"; batch_index: number; message: string }
  | { code: "uniform_batch"; batch_index: number; message: string };

export interface Plan {
  recipientCount: number;
  batches: PlannedBatch[];
  /** Zatoshi: the sum of the batch totals. */
  declaredTotal: bigint;
  feeTotal: bigint;
  /** Zatoshi: everything the deposit must cover. */
  required: bigint;
  warnings: WarningView[];
}

export type PlanResult = { ok: true; plan: Plan } | { ok: false; message: string };

/** How many recipients go in each batch: full ones in order, and if that would end in a batch of one, one recipient moves
 * back from the batch before so that no batch reveals a single person's amount. Null when no such split exists. */
function batchSizes(recipients: number, max: number): number[] | null {
  const sizes = Array.from({ length: Math.floor(recipients / max) }, () => max);
  if (recipients % max !== 0) sizes.push(recipients % max);
  if (recipients > 1 && sizes[sizes.length - 1] === 1) {
    const previous = sizes.length - 2;
    const size = sizes[previous];
    if (size === undefined || size < 3) return null;
    sizes[previous] = size - 1;
    sizes[sizes.length - 1] = 2;
  }
  return sizes;
}

function warningsFor(batches: readonly { amounts: readonly bigint[] }[]): WarningView[] {
  const recipients = batches.reduce((sum, batch) => sum + batch.amounts.length, 0);
  const found: PrivacyWarning[] = [];
  if (recipients === 1) found.push({ code: "singleton_campaign" });
  else if (recipients > 1 && recipients < SMALL_CAMPAIGN_RECIPIENTS) found.push({ code: "small_campaign", recipients });
  batches.forEach((batch, index) => {
    const count = batch.amounts.length;
    if (count === 2) found.push({ code: "two_recipient_batch", batchIndex: index });
    const [first, ...others] = batch.amounts;
    if (first !== undefined && count >= 2 && others.every((amount) => amount === first)) {
      found.push({ code: "uniform_batch", batchIndex: index });
    }
  });
  return found.map((warning): WarningView => {
    const message = warningMessage(warning);
    switch (warning.code) {
      case "singleton_campaign":
        return { code: warning.code, message };
      case "small_campaign":
        return { code: warning.code, recipients: warning.recipients, message };
      case "two_recipient_batch":
      case "uniform_batch":
        return { code: warning.code, batch_index: warning.batchIndex, message };
    }
  });
}

/** Split `rows` into batches of at most `maxOutputs`, price them under `policy`, and say what is worth warning about. The
 * refusals carry the operator's own sentences (`plan_failed`). */
export function planCampaign(rows: readonly PayoutRow[], maxOutputs: number, policy: FeePolicyName): PlanResult {
  if (maxOutputs === 0) return { ok: false, message: "max outputs per batch must be at least 1" };
  if (rows.length === 0) return { ok: false, message: "there are no recipients to plan" };
  const declaredTotal = rows.reduce((sum, row) => sum + row.amount, 0n);
  if (declaredTotal > MAX_MONEY) return { ok: false, message: "amount exceeds the maximum possible supply of 21,000,000 ZEC" };

  const sizes = batchSizes(rows.length, maxOutputs);
  if (sizes === null) {
    return {
      ok: false,
      message: `cannot split ${String(rows.length)} recipients into batches of at most ${String(maxOutputs)} without a single-recipient batch; raise the batch size`,
    };
  }

  const slices: { amounts: bigint[] }[] = [];
  let from = 0;
  for (const size of sizes) {
    slices.push({ amounts: rows.slice(from, from + size).map((row) => row.amount) });
    from += size;
  }
  const batches = slices.map((slice, index): PlannedBatch => {
    const total = slice.amounts.reduce((sum, amount) => sum + amount, 0n);
    const fee = estimateBatchFee(policy, slice.amounts.length);
    return { index, recipients: slice.amounts.length, total, fee, required: total + fee };
  });
  const feeTotal = batches.reduce((sum, batch) => sum + batch.fee, 0n);
  return {
    ok: true,
    plan: {
      recipientCount: rows.length,
      batches,
      declaredTotal,
      feeTotal,
      required: declaredTotal + feeTotal,
      warnings: warningsFor(slices),
    },
  };
}
