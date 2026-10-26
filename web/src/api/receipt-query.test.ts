import { describe, expect, it } from "vitest";

import {
  LINK_PROBLEM_TEXT,
  MAX_RECEIPT_TXIDS,
  parseReceiptLink,
  receiptSearchParams,
  type LinkProblem,
  type ReceiptQuery,
} from "./receipt-query";

const TX_A = "a".repeat(64);
const TX_B = "b".repeat(64);
const COMMITMENT = "e".repeat(64);

/** Build a link from name/value pairs, so repeated names are possible. */
const link = (...pairs: [string, string][]) => new URLSearchParams(pairs);

const valid = (): [string, string][] => [
  ["network", "testnet"],
  ["tx", TX_A],
  ["tx", TX_B],
  ["commitment", COMMITMENT],
  ["declared_total", "534500000"],
];

/** `valid()` with every pair named `name` removed, then `extra` appended. */
const without = (name: string, ...extra: [string, string][]) =>
  link(...valid().filter(([n]) => n !== name), ...extra);

function problemOf(params: URLSearchParams): LinkProblem {
  const result = parseReceiptLink(params);
  if (result.ok) throw new Error("expected the link to be rejected");
  return result.problem;
}

describe("parseReceiptLink: accepted", () => {
  it("reads a complete link", () => {
    const result = parseReceiptLink(link(...valid()));
    expect(result).toEqual({
      ok: true,
      query: {
        network: "testnet",
        txids: [TX_A, TX_B],
        commitment: COMMITMENT,
        declaredTotal: "534500000",
      },
    });
  });

  it("keeps transaction order", () => {
    const result = parseReceiptLink(
      link(["network", "mainnet"], ["tx", TX_B], ["tx", TX_A], ["commitment", COMMITMENT], ["declared_total", "0"]),
    );
    expect(result.ok && result.query.txids).toEqual([TX_B, TX_A]);
  });

  it("ignores unknown parameters instead of forwarding them", () => {
    const result = parseReceiptLink(link(...valid(), ["utm_source", "x"], ["demo", "1"]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.query).sort()).toEqual(["commitment", "declaredTotal", "network", "txids"]);
  });

  it("accepts the supply cap and the maximum number of transactions", () => {
    const many = Array.from({ length: MAX_RECEIPT_TXIDS }, (_, i) => i.toString(16).padStart(64, "0"));
    const pairs: [string, string][] = [
      ["network", "testnet"],
      ...many.map((t): [string, string] => ["tx", t]),
      ["commitment", COMMITMENT],
      ["declared_total", "2100000000000000"],
    ];
    expect(parseReceiptLink(link(...pairs)).ok).toBe(true);
  });
});

describe("parseReceiptLink: rejected, by problem", () => {
  const cases: [label: string, params: URLSearchParams, problem: LinkProblem][] = [
    ["no network", without("network"), "missing_network"],
    ["unknown network", without("network", ["network", "regtest"]), "bad_network"],
    ["uppercase network", without("network", ["network", "Testnet"]), "bad_network"],
    ["empty network", without("network", ["network", ""]), "bad_network"],
    ["repeated network", without("network", ["network", "testnet"], ["network", "mainnet"]), "repeated_parameter"],
    ["no transactions", without("tx"), "no_transactions"],
    ["short transaction id", without("tx", ["tx", "abc"]), "bad_transaction"],
    ["uppercase transaction id", without("tx", ["tx", "A".repeat(64)]), "bad_transaction"],
    ["0x-prefixed transaction id", without("tx", ["tx", `0x${"a".repeat(62)}`]), "bad_transaction"],
    ["empty transaction id", without("tx", ["tx", ""]), "bad_transaction"],
    ["repeated transaction id", without("tx", ["tx", TX_A], ["tx", TX_A]), "duplicate_transaction"],
    ["no commitment", without("commitment"), "missing_commitment"],
    ["short commitment", without("commitment", ["commitment", "ee"]), "bad_commitment"],
    ["uppercase commitment", without("commitment", ["commitment", "E".repeat(64)]), "bad_commitment"],
    ["repeated commitment", without("commitment", ["commitment", COMMITMENT], ["commitment", COMMITMENT]), "repeated_parameter"],
    ["no declared total", without("declared_total"), "missing_declared_total"],
    ["decimal declared total", without("declared_total", ["declared_total", "1.5"]), "bad_declared_total"],
    ["negative declared total", without("declared_total", ["declared_total", "-1"]), "bad_declared_total"],
    ["declared total above the supply", without("declared_total", ["declared_total", "2100000000000001"]), "bad_declared_total"],
    ["empty declared total", without("declared_total", ["declared_total", ""]), "bad_declared_total"],
    ["repeated declared total", without("declared_total", ["declared_total", "1"], ["declared_total", "1"]), "repeated_parameter"],
  ];

  it.each(cases)("%s", (_label, params, problem) => {
    expect(problemOf(params)).toBe(problem);
  });

  it("rejects more transactions than the limit", () => {
    const many = Array.from({ length: MAX_RECEIPT_TXIDS + 1 }, (_, i) => i.toString(16).padStart(64, "0"));
    const params = link(
      ["network", "testnet"],
      ...many.map((t): [string, string] => ["tx", t]),
      ["commitment", COMMITMENT],
      ["declared_total", "1"],
    );
    expect(problemOf(params)).toBe("too_many_transactions");
  });

  it("rejects an empty link", () => {
    expect(problemOf(new URLSearchParams())).toBe("missing_network");
  });
});

describe("explanations", () => {
  it("exist for every problem and never contain a value from the link", () => {
    const problems = Object.keys(LINK_PROBLEM_TEXT) as LinkProblem[];
    expect(problems).toHaveLength(11);
    for (const problem of problems) {
      const text = LINK_PROBLEM_TEXT[problem];
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/[0-9a-f]{16}/u);
    }
  });
});

describe("receiptSearchParams", () => {
  const query: ReceiptQuery = {
    network: "testnet",
    txids: [TX_A, TX_B],
    commitment: COMMITMENT,
    declaredTotal: "534500000",
  };

  it("uses the shared parameter names, repeating tx", () => {
    expect(receiptSearchParams(query).toString()).toBe(
      `network=testnet&tx=${TX_A}&tx=${TX_B}&commitment=${COMMITMENT}&declared_total=534500000`,
    );
  });

  it("round-trips through parseReceiptLink", () => {
    const parsed = parseReceiptLink(receiptSearchParams(query));
    expect(parsed).toEqual({ ok: true, query });
  });
});
