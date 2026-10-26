// Findings: the problems a verifier reports about a receipt, in-band, instead
// of hiding them (REQ-VER-001). A closed set of codes carrying at most a batch
// index, mirrored from crates/drop-core/src/receipt.rs. Findings never contain
// text that came from outside, and neither does anything rendered from them.
//
// The sentences below are word-for-word the core's `Finding::message`, and
// `isFailure` is the core's `Finding::is_failure`. findings.test.ts compares
// both with the Rust source, so neither side can change alone.

import { z } from "zod";

const U32_MAX = 4_294_967_295;
const u32 = z.number().int().min(0).max(U32_MAX);

/** Codes about one batch. */
export type BatchFindingCode =
  | "tx_not_found"
  | "tx_unparseable"
  | "prevout_unresolved"
  | "negative_fee"
  | "balance_mismatch"
  | "unexpected_pool"
  | "batch_pending"
  /** The batch spends from a different transparent address than the other batches. */
  | "mixed_funding_sources";

export type ReceiptFinding =
  /** The batches' net values do not add up to the declared total. */
  | { code: "declared_total_mismatch" }
  | { code: BatchFindingCode; batchIndex: number };

export type FindingCode = ReceiptFinding["code"];

const batchFinding = <C extends BatchFindingCode>(code: C) =>
  z.object({ code: z.literal(code), batch_index: u32 }).strict();

/** The wire form of a finding, as it appears in a receipt's `findings`. */
export const findingWire = z
  .discriminatedUnion("code", [
    z.object({ code: z.literal("declared_total_mismatch") }).strict(),
    batchFinding("tx_not_found"),
    batchFinding("tx_unparseable"),
    batchFinding("prevout_unresolved"),
    batchFinding("negative_fee"),
    batchFinding("balance_mismatch"),
    batchFinding("unexpected_pool"),
    batchFinding("batch_pending"),
    batchFinding("mixed_funding_sources"),
  ])
  .transform(
    (f): ReceiptFinding =>
      f.code === "declared_total_mismatch"
        ? { code: f.code }
        : { code: f.code, batchIndex: f.batch_index },
  );

/** Whether a finding means the campaign is wrong, as opposed to merely not yet
 * verifiable or not yet final. Failures make a receipt's phase `failed`. */
export function isFailure(finding: ReceiptFinding): boolean {
  switch (finding.code) {
    case "declared_total_mismatch":
    case "tx_unparseable":
    case "negative_fee":
    case "balance_mismatch":
    case "unexpected_pool":
    case "mixed_funding_sources":
      return true;
    case "tx_not_found":
    case "prevout_unresolved":
    case "batch_pending":
      return false;
  }
}

/** The core's sentence for a finding (see the file header). */
export function findingMessage(finding: ReceiptFinding): string {
  switch (finding.code) {
    case "declared_total_mismatch":
      return "The batches add up to a different total than the one declared for this campaign.";
    case "tx_not_found":
      return `Batch ${String(finding.batchIndex)}: the transaction was not found on the chain.`;
    case "tx_unparseable":
      return `Batch ${String(finding.batchIndex)}: the data returned for this transaction is not a valid transaction.`;
    case "prevout_unresolved":
      return `Batch ${String(finding.batchIndex)}: a funding input could not be looked up, so the fee cannot be checked.`;
    case "negative_fee":
      return `Batch ${String(finding.batchIndex)}: the inputs are worth less than the outputs, which no valid transaction can be.`;
    case "balance_mismatch":
      return `Batch ${String(finding.batchIndex)}: the shielded value balance does not match the transaction's own signature.`;
    case "unexpected_pool":
      return `Batch ${String(finding.batchIndex)}: the transaction does not pay into the expected shielded pool.`;
    case "batch_pending":
      return `Batch ${String(finding.batchIndex)}: not yet confirmed to the required depth.`;
    case "mixed_funding_sources":
      return `Batch ${String(finding.batchIndex)}: spends from a different address than the other batches, so they do not all come from one campaign funding address.`;
  }
}

/** The batch a finding is about, if any. */
export function findingBatch(finding: ReceiptFinding): number | null {
  return finding.code === "declared_total_mismatch" ? null : finding.batchIndex;
}
