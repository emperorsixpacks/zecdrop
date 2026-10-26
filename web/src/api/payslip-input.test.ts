import { describe, expect, it } from "vitest";

import {
  MAX_PAYSLIP_BODY,
  MAX_PAYSLIP_TEXT,
  PAYSLIP_PROBLEM_TEXT,
  payslipBody,
  readPayslip,
  type PayslipProblem,
} from "./payslip-input";

// A well-formed payslip whose values are recognisable, so a test can tell whether any of them leaked.
const TXID = "6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955";
const RECEIVER = "380decb3bc9fd833dc528ebb455958f71a626c2ea66b9a48f6a9750dbb5c66665571e614426d42d92e6310";
const RSEED = "71b88bf428e8edfa6f17d9196ddd697c3ab400a467ce07093df9da929f9e7ecb";

const good = () => ({ version: 1, network: "testnet", txid: TXID, action: 5, receiver: RECEIVER, value: "90000", rseed: RSEED });
const text = (slip: object = good()) => JSON.stringify(slip);

function problemOf(input: string): PayslipProblem {
  const read = readPayslip(input);
  if (read.ok) throw new Error("expected the paste to be refused");
  return read.problem;
}

describe("readPayslip: accepted", () => {
  it("reads a payslip as the operator writes it (indented, one field a line)", () => {
    const read = readPayslip(JSON.stringify(good(), null, 2) + "\n");
    expect(read).toEqual({ ok: true, payslip: good() });
  });

  it("reads it compact, or with space around it", () => {
    expect(readPayslip(text()).ok).toBe(true);
    expect(readPayslip(`\n\n   ${text()}  \t\n`).ok).toBe(true);
  });

  it("reads the fields in any order, and returns exactly those seven", () => {
    const { rseed, value, receiver, action, txid, network, version } = good();
    const read = readPayslip(text({ rseed, value, receiver, action, txid, network, version }));
    expect(read.ok && Object.keys(read.payslip)).toEqual(["version", "network", "txid", "action", "receiver", "value", "rseed"]);
  });

  it("accepts a mainnet payslip, the first and the last action, and the largest amount", () => {
    expect(readPayslip(text({ ...good(), network: "mainnet", action: 0, value: "0" })).ok).toBe(true);
    expect(readPayslip(text({ ...good(), action: 4_294_967_295, value: "2100000000000000" })).ok).toBe(true);
  });
});

describe("readPayslip: refused, by problem", () => {
  const field = (name: string, value: unknown) => text({ ...good(), [name]: value });
  const without = (name: string) => {
    const { [name as keyof ReturnType<typeof good>]: _gone, ...rest } = good();
    return text(rest);
  };

  const cases: [label: string, input: string, problem: PayslipProblem][] = [
    ["nothing", "", "empty"],
    ["only space", " \n\t ", "empty"],
    ["more text than any payslip", "x".repeat(MAX_PAYSLIP_TEXT + 1), "too_long"],
    ["half of a JSON object", '{"version":1,', "not_json"],
    ["words", "here is my payslip", "not_json"],
    ["a JSON array", "[]", "not_an_object"],
    ["a JSON string", '"payslip"', "not_an_object"],
    ["JSON null", "null", "not_an_object"],
    ["a JSON number", "5", "not_an_object"],
    ["a field the verifier does not know", field("memo", "hello"), "unknown_field"],
    ["the prototype key", '{"__proto__":{}}', "unknown_field"],
    ["no version", without("version"), "missing_field"],
    ["no network", without("network"), "missing_field"],
    ["no txid", without("txid"), "missing_field"],
    ["no action", without("action"), "missing_field"],
    ["no receiver", without("receiver"), "missing_field"],
    ["no value", without("value"), "missing_field"],
    ["no rseed", without("rseed"), "missing_field"],
    ["version 2", field("version", 2), "bad_version"],
    ["version as text", field("version", "1"), "bad_version"],
    ["version 1.5", field("version", 1.5), "bad_version"],
    ["a network that is neither", field("network", "regtest"), "bad_network"],
    ["a network in capitals", field("network", "Testnet"), "bad_network"],
    ["a network that is a number", field("network", 1), "bad_network"],
    ["a txid one character short", field("txid", TXID.slice(1)), "bad_txid"],
    ["a txid in capitals", field("txid", TXID.toUpperCase()), "bad_txid"],
    ["a txid that is not hex", field("txid", "z".repeat(64)), "bad_txid"],
    ["a txid that is a number", field("txid", 5), "bad_txid"],
    ["a negative action", field("action", -1), "bad_action"],
    ["a fractional action", field("action", 1.5), "bad_action"],
    ["an action above 32 bits", field("action", 4_294_967_296), "bad_action"],
    ["an action as text", field("action", "5"), "bad_action"],
    ["a receiver one character short", field("receiver", RECEIVER.slice(1)), "bad_receiver"],
    ["a receiver one character long", field("receiver", `${RECEIVER}0`), "bad_receiver"],
    ["a receiver in capitals", field("receiver", RECEIVER.toUpperCase()), "bad_receiver"],
    ["a receiver with 0x", field("receiver", `0x${RECEIVER.slice(2)}`), "bad_receiver"],
    ["an amount as a number", field("value", 90000), "bad_value"],
    ["an amount with a leading zero", field("value", "090000"), "bad_value"],
    ["an amount with a fraction", field("value", "0.0009"), "bad_value"],
    ["a negative amount", field("value", "-1"), "bad_value"],
    ["an amount in exponent form", field("value", "9e4"), "bad_value"],
    ["an amount above the supply", field("value", "2100000000000001"), "bad_value"],
    ["an empty amount", field("value", ""), "bad_value"],
    ["a secret one character short", field("rseed", RSEED.slice(1)), "bad_rseed"],
    ["a secret in capitals", field("rseed", RSEED.toUpperCase()), "bad_rseed"],
    ["a secret that is null", field("rseed", null), "bad_rseed"],
  ];

  it.each(cases)("%s", (_label, input, problem) => {
    expect(problemOf(input)).toBe(problem);
  });

  it("says something plain for every problem it can find", () => {
    for (const problem of new Set(cases.map(([, , p]) => p))) expect(PAYSLIP_PROBLEM_TEXT[problem].length).toBeGreaterThan(10);
    expect(Object.keys(PAYSLIP_PROBLEM_TEXT).sort()).toEqual([...new Set([...cases.map(([, , p]) => p), "viewing_key"])].sort());
  });

  it("checks the size before it parses anything, so a huge paste costs nothing", () => {
    expect(problemOf(`{"version":1,"x":"${"a".repeat(MAX_PAYSLIP_TEXT)}"}`)).toBe("too_long");
  });
});

// covers: REQ-VER-002
describe("readPayslip: a viewing key is not a payslip", () => {
  it.each(["uview1abcdef", "uivktest1abcdef", "ufvk1abc", "zxviews1abc", "zxviewtestsapling1abc", "zivk1abc"])(
    "%s, bare or inside an otherwise good payslip, is refused as a key",
    (key) => {
      expect(problemOf(key)).toBe("viewing_key");
      expect(problemOf(text({ ...good(), memo: key }))).toBe("viewing_key");
      expect(problemOf(text({ ...good(), memo: key.toUpperCase() }))).toBe("viewing_key");
    },
  );

  it("is said before anything else about the paste", () => {
    expect(problemOf(`{ not json at all ufvk1abc`)).toBe("viewing_key");
  });
});

describe("what a problem says", () => {
  it("never repeats the text that was pasted", () => {
    const sentinel = "SENTINEL-kq7zx-do-not-repeat";
    const pastes = [
      sentinel,
      text({ ...good(), receiver: sentinel }),
      text({ ...good(), rseed: sentinel }),
      text({ ...good(), value: sentinel }),
      text({ ...good(), [sentinel]: 1 }),
      text({ ...good(), network: sentinel }),
      text({ ...good(), txid: sentinel }),
    ];
    for (const paste of pastes) {
      const read = readPayslip(paste);
      expect(read.ok, paste).toBe(false);
      expect(JSON.stringify(read)).not.toContain("SENTINEL");
      if (!read.ok) expect(PAYSLIP_PROBLEM_TEXT[read.problem]).not.toContain("SENTINEL");
    }
    for (const sentence of Object.values(PAYSLIP_PROBLEM_TEXT)) expect(sentence).not.toContain(RECEIVER);
  });
});

describe("payslipBody", () => {
  it("is the payslip, compact, in the verifier's order", () => {
    const read = readPayslip(JSON.stringify(good(), null, 4));
    if (!read.ok) throw new Error("expected a payslip");
    expect(payslipBody(read.payslip)).toBe(
      `{"version":1,"network":"testnet","txid":"${TXID}","action":5,"receiver":"${RECEIVER}","value":"90000","rseed":"${RSEED}"}`,
    );
  });

  it("is built from the seven fields, not from the pasted text", () => {
    // The paste has the fields in another order and a great deal of space; the body has neither.
    const { rseed, value, receiver, action, txid, network, version } = good();
    const read = readPayslip(`\n   ${JSON.stringify({ rseed, value, receiver, action, txid, network, version }, null, 12)}   \n`);
    if (!read.ok) throw new Error("expected a payslip");
    const body = payslipBody(read.payslip);
    expect(body).not.toMatch(/\s/u);
    expect(Object.keys(JSON.parse(body) as object)).toEqual(["version", "network", "txid", "action", "receiver", "value", "rseed"]);
  });

  it("is far below the verifier's limit, even for the largest payslip there can be", () => {
    const read = readPayslip(text({ ...good(), network: "mainnet", action: 4_294_967_295, value: "2100000000000000" }));
    if (!read.ok) throw new Error("expected a payslip");
    expect(new TextEncoder().encode(payslipBody(read.payslip)).length).toBeLessThan(MAX_PAYSLIP_BODY / 2);
  });
});
