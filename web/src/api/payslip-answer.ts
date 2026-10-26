// The verifier's answer to a payslip, as served by POST /v1/payslip (crates/drop-verifier/src/api.rs).
//
// Two layers, as for the receipt (types.ts): the wire format, validated here with a strict zod
// schema, and a view that UI code uses. parsePayslipAnswer() is the only way from the first to the
// second. Rules it enforces at runtime:
//   1. The object is `.strict()`: a field the verifier does not document is REFUSED, never stripped.
//      The answer carries no receiver, amount or secret, and one that started to would fail loudly here.
//   2. Facts that go together agree. A verdict of "verified" has its confirmations at or above the
//      depth, "pending" has them below it, and only an "invalid" answer has a reason; anything else is
//      not an answer this page shows.
//   3. The sentences about what a payslip does not prove are text: bounded, and shown as text.
//
// A payslip that does not match the chain is NOT an error: it is an answer with the verdict "invalid".

import { z } from "zod";

import type { ZecNetwork } from "@/lib/config";

import { hex32Wire, u32Wire } from "./types";

export const PAYSLIP_VERDICTS = ["verified", "pending", "not_found", "invalid"] as const;
export type PayslipVerdict = (typeof PAYSLIP_VERDICTS)[number];

/** Why an "invalid" payslip does not verify: fixed codes that never say which field was wrong. */
export const PAYSLIP_INVALID_REASONS = [
  "does_not_match",
  "no_such_action",
  "malformed_note",
  "tx_unparseable",
  "no_ironwood_outputs",
  "unsupported_version",
  "txid_mismatch",
] as const;
export type PayslipInvalidReason = (typeof PAYSLIP_INVALID_REASONS)[number];

export type PayslipOutcome =
  /** The output matches. "verified" when the transaction has reached the depth, "pending" before. */
  | { verdict: "verified" | "pending"; confirmations: number; ironwoodActions: number }
  | { verdict: "not_found" }
  | { verdict: "invalid"; reason: PayslipInvalidReason };

export interface PayslipAnswer {
  network: ZecNetwork;
  txid: string;
  action: number;
  outcome: PayslipOutcome;
  /** Confirmations the verifier waits for before it calls a transaction final. */
  requiredDepth: number;
  /** What a verified payslip does not prove, in the verifier's words. */
  notProven: readonly string[];
}

/** What a payslip that checks out still leaves open: crates/drop-verify/src/payslip.rs, `NOT_PROVEN`
 * (payslip-answer.test.ts compares the two, word for word). The page shows these before anything is
 * checked, and the verifier's own list once it has answered. */
export const PAYSLIP_NOT_PROVEN: readonly string[] = [
  "Who the recipient is, or that whoever presents the payslip controls the receiver. A payslip is a bearer document: anyone who holds it can present it.",
  "The memo. The note commitment does not cover it.",
  "That the transaction is mined or final. That needs the chain: see the confirmations.",
  "That the funds are unspent, or that the transaction belongs to a given campaign. Compare its id with the campaign's public receipt.",
  "Anything about any other output of the transaction.",
];

const answerWire = z
  .object({
    network: z.enum(["testnet", "mainnet"]),
    txid: hex32Wire,
    action: u32Wire,
    verdict: z.enum(PAYSLIP_VERDICTS),
    reason: z.enum(PAYSLIP_INVALID_REASONS).nullable(),
    confirmations: u32Wire.nullable(),
    required_depth: u32Wire.min(1),
    ironwood_actions: u32Wire.nullable(),
    not_proven: z.array(z.string().min(1).max(500)).min(1).max(10),
  })
  .strict()
  .transform((a, ctx): PayslipAnswer => {
    const outcome = outcomeOf(a);
    if (outcome === null) {
      ctx.addIssue({ code: "custom", message: "the verdict, the reason and the counts do not agree" });
      return z.NEVER;
    }
    return {
      network: a.network,
      txid: a.txid,
      action: a.action,
      outcome,
      requiredDepth: a.required_depth,
      notProven: a.not_proven,
    };
  });

type Wire = z.input<typeof answerWire>;

/** The outcome the wire fields describe, or null when they contradict each other. */
function outcomeOf(a: Wire): PayslipOutcome | null {
  switch (a.verdict) {
    case "verified":
    case "pending": {
      if (a.reason !== null || a.confirmations === null || a.ironwood_actions === null) return null;
      // The output is one of the transaction's actions, and the verdict follows from the depth.
      if (a.action >= a.ironwood_actions) return null;
      if ((a.confirmations >= a.required_depth) !== (a.verdict === "verified")) return null;
      return { verdict: a.verdict, confirmations: a.confirmations, ironwoodActions: a.ironwood_actions };
    }
    case "not_found":
      return a.reason === null && a.confirmations === null && a.ironwood_actions === null ? { verdict: "not_found" } : null;
    case "invalid":
      return a.reason !== null && a.confirmations === null && a.ironwood_actions === null
        ? { verdict: "invalid", reason: a.reason }
        : null;
  }
}

/** Validate untrusted JSON as the verifier's answer to a payslip and map it to the view type.
 * Throws ZodError on any deviation. Error messages name keys and rules, never the values. */
export function parsePayslipAnswer(input: unknown): PayslipAnswer {
  return answerWire.parse(input);
}
