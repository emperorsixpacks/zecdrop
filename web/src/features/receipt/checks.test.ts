import { describe, expect, it } from "vitest";

import type { ReceiptQuery } from "@/api/receipt-query";
import type { PublicReceipt, PublicReceiptBatch } from "@/api/types";

import { checkReceipt } from "./checks";

const TX_A = "a".repeat(64);
const TX_B = "b".repeat(64);
const COMMITMENT = "e".repeat(64);

const batch = (patch: Partial<PublicReceiptBatch> = {}): PublicReceiptBatch => ({
  index: 0,
  txid: TX_A,
  fundingInput: { txid: "c".repeat(64), vout: 0 },
  netIntoPool: "485000000",
  fee: "20000",
  shieldedActions: 3,
  pool: "ironwood",
  confirmations: 5,
  ...patch,
});

const receipt = (patch: Partial<PublicReceipt> = {}): PublicReceipt => ({
  campaignId: "camp",
  network: "testnet",
  fundingAddress: null,
  declaredTotal: "534500000",
  feeTotal: "35000",
  manifestCommitment: COMMITMENT,
  phase: { phase: "sending", done: 1, total: 2 },
  findings: [],
  batches: [
    batch(),
    batch({ index: 1, txid: null, netIntoPool: "49500000", fee: "15000", shieldedActions: 2, confirmations: 0 }),
  ],
  ...patch,
});

const claim = (patch: Partial<ReceiptQuery> = {}): ReceiptQuery => ({
  network: "testnet",
  txids: [TX_A],
  commitment: COMMITMENT,
  declaredTotal: "534500000",
  ...patch,
});

describe("a consistent receipt", () => {
  it("has no problems, with or without a claim", () => {
    expect(checkReceipt(receipt())).toEqual([]);
    expect(checkReceipt(receipt(), claim())).toEqual([]);
  });

  it("an empty campaign adds up to zero", () => {
    expect(checkReceipt(receipt({ batches: [], declaredTotal: "0", feeTotal: "0" }))).toEqual([]);
  });

  it("is independent of the order of the claimed transactions", () => {
    const r = receipt({
      batches: [batch(), batch({ index: 1, txid: TX_B, netIntoPool: "49500000", fee: "15000" })],
    });
    expect(checkReceipt(r, claim({ txids: [TX_B, TX_A] }))).toEqual([]);
  });
});

describe("the answer disagrees with the link", () => {
  it("different network", () => {
    expect(checkReceipt(receipt(), claim({ network: "mainnet" }))).toEqual([
      { kind: "network_differs", claimed: "mainnet", found: "testnet" },
    ]);
  });

  it("different declared total", () => {
    expect(checkReceipt(receipt(), claim({ declaredTotal: "534500001" }))).toEqual([
      { kind: "declared_total_differs", claimed: "534500001", found: "534500000" },
    ]);
  });

  it("different commitment", () => {
    const other = "d".repeat(64);
    expect(checkReceipt(receipt(), claim({ commitment: other }))).toEqual([
      { kind: "commitment_differs", claimed: other, found: COMMITMENT },
    ]);
  });

  it("a claimed transaction the receipt does not have", () => {
    expect(checkReceipt(receipt(), claim({ txids: [TX_A, TX_B] }))).toEqual([
      { kind: "transactions_differ", missing: [TX_B], unexpected: [] },
    ]);
  });

  it("a transaction in the receipt that the link did not claim", () => {
    expect(checkReceipt(receipt(), claim({ txids: [TX_B] }))).toEqual([
      { kind: "transactions_differ", missing: [TX_B], unexpected: [TX_A] },
    ]);
  });

  it("a batch with no txid yet is never counted as missing or unexpected", () => {
    expect(checkReceipt(receipt(), claim())).toEqual([]);
  });

  it("reports every difference at once", () => {
    const kinds = checkReceipt(
      receipt(),
      claim({ network: "mainnet", declaredTotal: "1", commitment: "d".repeat(64), txids: [TX_B] }),
    ).map((p) => p.kind);
    expect(kinds).toEqual([
      "network_differs",
      "declared_total_differs",
      "commitment_differs",
      "transactions_differ",
    ]);
  });
});

describe("the receipt's own arithmetic", () => {
  it("flags a declared total that is not the sum of the batches", () => {
    expect(checkReceipt(receipt({ declaredTotal: "534500001" }))).toEqual([
      { kind: "batches_do_not_add_up", field: "declared_total", reported: "534500001", sum: "534500000" },
    ]);
  });

  it("flags a fee total that is not the sum of the batch fees", () => {
    expect(checkReceipt(receipt({ feeTotal: "34999" }))).toEqual([
      { kind: "batches_do_not_add_up", field: "fee_total", reported: "34999", sum: "35000" },
    ]);
  });

  it("does not overflow on amounts that would break float sums", () => {
    const big = "2099999999999999";
    const r = receipt({
      declaredTotal: big,
      feeTotal: "0",
      batches: [batch({ netIntoPool: big, fee: "0" })],
    });
    expect(checkReceipt(r)).toEqual([]);
  });
});

describe("unknown facts (null) are never guessed at", () => {
  const unknownBatch = (index: number): PublicReceiptBatch => ({
    index,
    txid: TX_B,
    fundingInput: null,
    netIntoPool: null,
    fee: null,
    shieldedActions: null,
    pool: null,
    confirmations: 0,
  });

  it("skips the declared-total arithmetic when any batch's net is unknown", () => {
    const r = receipt({
      declaredTotal: "1",
      feeTotal: null,
      batches: [batch(), unknownBatch(1)],
      findings: [{ code: "tx_not_found", batchIndex: 1 }],
    });
    expect(checkReceipt(r)).toEqual([]);
  });

  it("skips the fee arithmetic when the fee total or any fee is unknown", () => {
    expect(checkReceipt(receipt({ feeTotal: null }))).toEqual([]);
    const r = receipt({
      feeTotal: "999",
      batches: [batch(), batch({ index: 1, txid: TX_B, fee: null, netIntoPool: "49500000" })],
    });
    expect(checkReceipt(r)).toEqual([]);
  });

  it("does not repeat a total mismatch the verifier already reported", () => {
    const r = receipt({
      declaredTotal: "534500001",
      findings: [{ code: "declared_total_mismatch" }],
    });
    expect(checkReceipt(r)).toEqual([]);
  });

  it("still reports a total mismatch the verifier did not report", () => {
    expect(checkReceipt(receipt({ declaredTotal: "534500001" })).map((p) => p.kind)).toEqual([
      "batches_do_not_add_up",
    ]);
  });
});
