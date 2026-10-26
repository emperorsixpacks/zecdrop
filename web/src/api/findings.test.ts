import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import receiptRust from "../../../crates/drop-core/src/receipt.rs?raw";
import { between, fill, stringLiterals } from "@/test/rust-source";

import {
  findingBatch,
  findingMessage,
  findingWire,
  isFailure,
  type BatchFindingCode,
  type ReceiptFinding,
} from "./findings";

const BATCH_CODES: readonly BatchFindingCode[] = [
  "tx_not_found",
  "tx_unparseable",
  "prevout_unresolved",
  "negative_fee",
  "balance_mismatch",
  "unexpected_pool",
  "batch_pending",
  "mixed_funding_sources",
];

// Rust enum variant name -> wire code.
const snake = (variant: string) => variant.replace(/(?<!^)([A-Z])/gu, "_$1").toLowerCase();

// covers: REQ-VER-001
describe("messages equal the core's own sentences", () => {
  // The nine literals inside `Finding::message`, in declaration order.
  const literals = stringLiterals(
    between(receiptRust, "pub fn message(&self) -> String {", "/// What the hosted verifier may expose"),
  );
  const [declared, ...perBatch] = literals;

  it("found the nine sentences in the Rust source", () => {
    expect(literals).toHaveLength(9);
    expect(literals.every((s) => s.length > 20)).toBe(true);
  });

  it("declared total mismatch", () => {
    expect(findingMessage({ code: "declared_total_mismatch" })).toBe(declared);
  });

  it.each(BATCH_CODES.map((code, i) => [code, i] as const))("%s", (code, i) => {
    for (const batchIndex of [0, 1, 7, 4_294_967_295]) {
      expect(findingMessage({ code, batchIndex })).toBe(
        fill(perBatch[i] ?? "", { batch_index: batchIndex }),
      );
    }
  });
});

// covers: REQ-VER-001
describe("isFailure equals the core's is_failure", () => {
  const failureBody = between(receiptRust, "pub fn is_failure(&self) -> bool {", "pub fn message");
  const rustFailures = [...failureBody.matchAll(/Finding::(\w+)/gu)].map((m) => snake(m[1] ?? ""));

  it("found the failure variants in the Rust source", () => {
    expect(rustFailures.length).toBeGreaterThanOrEqual(5);
  });

  it("agrees on every code", () => {
    const all: ReceiptFinding[] = [
      { code: "declared_total_mismatch" },
      ...BATCH_CODES.map((code): ReceiptFinding => ({ code, batchIndex: 0 })),
    ];
    for (const finding of all) {
      expect(isFailure(finding), finding.code).toBe(rustFailures.includes(finding.code));
    }
  });

  it("covers every code the core defines (no code left out)", () => {
    const enumBody = between(receiptRust, "pub enum Finding {", "impl Finding {");
    const rustCodes = [...enumBody.matchAll(/^\s{4}([A-Z]\w+)\s*[,{]/gmu)].map((m) => snake(m[1] ?? ""));
    expect(rustCodes.sort()).toEqual(["declared_total_mismatch", ...BATCH_CODES].sort());
  });
});

describe("findingWire", () => {
  const parse = (input: unknown) => findingWire.parse(input);

  it("maps each wire shape to the view", () => {
    expect(parse({ code: "declared_total_mismatch" })).toEqual({ code: "declared_total_mismatch" });
    for (const code of BATCH_CODES) {
      expect(parse({ code, batch_index: 3 })).toEqual({ code, batchIndex: 3 });
    }
  });

  it.each([
    ["an unknown code", { code: "huge_fee", batch_index: 1 }],
    ["no code", { batch_index: 1 }],
    ["a batch code without its index", { code: "tx_not_found" }],
    ["a batch index on the campaign-level code", { code: "declared_total_mismatch", batch_index: 1 }],
    ["a negative index", { code: "tx_not_found", batch_index: -1 }],
    ["an index above u32", { code: "tx_not_found", batch_index: 4_294_967_296 }],
    ["a fractional index", { code: "tx_not_found", batch_index: 0.5 }],
    ["a string index", { code: "tx_not_found", batch_index: "1" }],
    ["the camelCase index name", { code: "tx_not_found", batchIndex: 1 }],
    ["free text from outside", { code: "tx_not_found", batch_index: 1, message: "see http://evil.example" }],
    ["a smuggled address", { code: "tx_not_found", batch_index: 1, address: "u1sentineladdress" }],
  ])("rejects %s", (_label, input) => {
    expect(() => parse(input)).toThrow(ZodError);
  });
});

describe("findingBatch", () => {
  it("is the batch index, or null for the campaign-level finding", () => {
    expect(findingBatch({ code: "declared_total_mismatch" })).toBeNull();
    expect(findingBatch({ code: "tx_not_found", batchIndex: 5 })).toBe(5);
  });
});
