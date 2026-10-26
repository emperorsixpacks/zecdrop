import { describe, expect, it } from "vitest";

import type { ReceiptFinding } from "@/api/findings";
import type { PublicReceiptBatch } from "@/api/types";
import type { PhaseState } from "@/lib/phase";

import {
  BATCH_STATE_LABEL,
  batchState,
  confirmationsText,
  isPending,
  POOL_LABEL,
} from "./format";

const batch = (patch: Partial<PublicReceiptBatch>): PublicReceiptBatch => ({
  index: 0,
  txid: "a".repeat(64),
  fundingInput: { txid: "c".repeat(64), vout: 0 },
  netIntoPool: "1",
  fee: "1",
  shieldedActions: 2,
  pool: "ironwood",
  confirmations: 0,
  ...patch,
});

describe("batchState", () => {
  const sending: PhaseState = { phase: "sending", done: 1, total: 2 };
  const settled: PhaseState = { phase: "settled" };

  it("a batch with no txid is not sent yet, whatever the phase", () => {
    expect(batchState(batch({ txid: null }), sending)).toBe("not_built");
    expect(batchState(batch({ txid: null }), { phase: "funded" })).toBe("not_built");
  });

  it("zero confirmations waits for a block", () => {
    expect(batchState(batch({ confirmations: 0 }), sending)).toBe("unconfirmed");
  });

  it("some confirmations are confirming, never final, until the campaign settles", () => {
    expect(batchState(batch({ confirmations: 5 }), sending)).toBe("confirming");
    expect(batchState(batch({ confirmations: 99 }), { phase: "failed" })).toBe("confirming");
  });

  it("final only when the verifier reports the whole campaign settled", () => {
    expect(batchState(batch({ confirmations: 6 }), settled)).toBe("final");
  });

  it("has a plain-language label for every state, and only final is not pending", () => {
    for (const state of [
      "problem",
      "not_built",
      "not_found",
      "unconfirmed",
      "confirming",
      "final",
    ] as const) {
      expect(BATCH_STATE_LABEL[state].length).toBeGreaterThan(3);
      expect(isPending(state)).toBe(state !== "final");
    }
  });
});

describe("batchState with the verifier's findings", () => {
  const sending: PhaseState = { phase: "sending", done: 1, total: 3 };
  const failed: PhaseState = { phase: "failed" };
  const at = (index: number, code: ReceiptFinding["code"]): ReceiptFinding =>
    code === "declared_total_mismatch" ? { code } : { code, batchIndex: index };

  it("a failure finding makes the batch 'needs attention', whatever else is true", () => {
    for (const code of ["tx_unparseable", "negative_fee", "balance_mismatch", "unexpected_pool"] as const) {
      expect(batchState(batch({ confirmations: 9 }), failed, [at(0, code)])).toBe("problem");
    }
  });

  it("a campaign-level finding does not mark individual batches", () => {
    expect(
      batchState(batch({ confirmations: 2 }), failed, [{ code: "declared_total_mismatch" }]),
    ).toBe("confirming");
  });

  it("a transaction the verifier could not find is 'not on the chain yet'", () => {
    expect(batchState(batch({ confirmations: 0 }), failed, [at(0, "tx_not_found")])).toBe(
      "not_found",
    );
  });

  it("another batch's finding does not leak onto this one", () => {
    expect(batchState(batch({ index: 0, confirmations: 2 }), sending, [at(1, "negative_fee")])).toBe(
      "confirming",
    );
  });

  describe("finality needs evidence", () => {
    it("is shown when the verifier flags OTHER located batches as pending and not this one", () => {
      const findings = [at(1, "batch_pending")];
      expect(batchState(batch({ index: 0, confirmations: 6 }), sending, findings)).toBe("final");
      expect(batchState(batch({ index: 1, confirmations: 1 }), sending, findings)).toBe("confirming");
    });

    it("is NOT inferred for a receipt that has no pending findings at all (operator-built)", () => {
      expect(batchState(batch({ confirmations: 50 }), sending, [])).toBe("confirming");
    });

    it("is not given to a batch that has any finding of its own", () => {
      const findings = [at(1, "batch_pending"), at(0, "prevout_unresolved")];
      expect(batchState(batch({ index: 0, confirmations: 6 }), sending, findings)).toBe("confirming");
    });

    it("is not given to a batch with no confirmations", () => {
      expect(batchState(batch({ index: 0, confirmations: 0 }), sending, [at(1, "batch_pending")])).toBe(
        "unconfirmed",
      );
    });
  });
});

describe("labels", () => {
  it("names both pools", () => {
    expect(POOL_LABEL).toEqual({ ironwood: "Ironwood", orchard: "Orchard" });
  });

  it("pluralises confirmations", () => {
    expect(confirmationsText(0)).toBe("0 confirmations");
    expect(confirmationsText(1)).toBe("1 confirmation");
    expect(confirmationsText(5)).toBe("5 confirmations");
  });
});
