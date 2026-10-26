// What a batch costs, and how long it takes to build, for the wizard's plain
// explanations. The authoritative numbers always come from the operator after
// the campaign is created (each batch carries its exact fee); this is only the
// estimate shown while choosing, and fees.test.ts checks it against every
// batch the real operator has reported.
//
// The fee follows ZIP-317: marginal_fee x max(grace_actions, logical_actions).
// For the standard batch (one transparent input, N shielded outputs, one
// transparent change output) the logical actions are the shielded actions,
// padded to at least two, plus one for the transparent side.

export type FeePolicyName = "zip317_text" | "zebra_main";

export interface FeePolicyInfo {
  name: FeePolicyName;
  /** Zatoshi charged per logical action. */
  marginalFee: bigint;
  /** The fee never covers fewer actions than this. */
  graceActions: bigint;
  title: string;
}

export const FEE_POLICIES: Readonly<Record<FeePolicyName, FeePolicyInfo>> = {
  zip317_text: {
    name: "zip317_text",
    marginalFee: 5_000n,
    graceActions: 2n,
    title: "Standard: 5,000 zatoshi per action",
  },
  zebra_main: {
    name: "zebra_main",
    marginalFee: 1_000n,
    graceActions: 2n,
    title: "Lower: 1,000 zatoshi per action",
  },
};

/** The policy used unless the person chooses otherwise: the higher one, because
 * paying above a node's minimum is accepted and paying below it is not
 * (docs/LEARNINGS.md). */
export const DEFAULT_FEE_POLICY: FeePolicyName = "zip317_text";

export const DEFAULT_BATCH_SIZE = 50;
export const MIN_BATCH_SIZE = 2;
/** Real ceiling: 330 actions per pool per transaction where NU7 is active (ADR 0005). */
export const MAX_BATCH_SIZE = 330;

/** Proving time per payout, measured offline on one machine (ADR 0001). A
 * ballpark, not a promise. */
export const PROVING_SECONDS_PER_PAYOUT = 1.25;

/** Logical actions of a standard batch with `outputs` recipients. */
export function logicalActions(outputs: number): number {
  return Math.max(2, outputs) + 1;
}

/** The estimated fee for one standard batch, in zatoshi. */
export function estimateBatchFee(policy: FeePolicyName, outputs: number): bigint {
  const { marginalFee, graceActions } = FEE_POLICIES[policy];
  const actions = BigInt(logicalActions(outputs));
  return marginalFee * (actions > graceActions ? actions : graceActions);
}

/** Estimated seconds to build one batch of `outputs` payouts. */
export function estimateProvingSeconds(outputs: number): number {
  return outputs * PROVING_SECONDS_PER_PAYOUT;
}

/** "about 30 seconds", "about 1 minute", "about 7 minutes": rounded, and honest
 * about being a rough guide. */
export function describeDuration(seconds: number): string {
  if (seconds < 45) {
    const whole = Math.max(1, Math.round(seconds));
    return `about ${String(whole)} ${whole === 1 ? "second" : "seconds"}`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `about ${String(minutes)} ${minutes === 1 ? "minute" : "minutes"}`;
}
