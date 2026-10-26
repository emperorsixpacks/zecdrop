import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import apiRust from "../../../crates/drop-verifier/src/api.rs?raw";
import payslipRust from "../../../crates/drop-verify/src/payslip.rs?raw";
import { BANNED } from "@/test/banned-phrases";
import { between, stringLiterals } from "@/test/rust-source";

import { MAX_PAYSLIP_BODY } from "./payslip-input";
import {
  PAYSLIP_INVALID_REASONS,
  PAYSLIP_NOT_PROVEN,
  PAYSLIP_VERDICTS,
  parsePayslipAnswer,
  type PayslipInvalidReason,
} from "./payslip-answer";

const TXID = "6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955";

/** An answer as the verifier writes it for a payslip that checks out (crates/drop-verifier/tests/payslip_api.rs). */
const verified = () => ({
  network: "testnet",
  txid: TXID,
  action: 5,
  verdict: "verified",
  reason: null,
  confirmations: 19,
  required_depth: 3,
  ironwood_actions: 8,
  not_proven: [...PAYSLIP_NOT_PROVEN],
});

const refused = (answer: unknown) => {
  expect(() => parsePayslipAnswer(answer)).toThrow(ZodError);
};

describe("parsePayslipAnswer: each verdict", () => {
  it("verified: the output, the confirmations and the depth", () => {
    expect(parsePayslipAnswer(verified())).toEqual({
      network: "testnet",
      txid: TXID,
      action: 5,
      outcome: { verdict: "verified", confirmations: 19, ironwoodActions: 8 },
      requiredDepth: 3,
      notProven: PAYSLIP_NOT_PROVEN,
    });
  });

  it("verified at exactly the depth, pending one below it", () => {
    expect(parsePayslipAnswer({ ...verified(), confirmations: 3 }).outcome.verdict).toBe("verified");
    const pending = parsePayslipAnswer({ ...verified(), verdict: "pending", confirmations: 2 });
    expect(pending.outcome).toEqual({ verdict: "pending", confirmations: 2, ironwoodActions: 8 });
    expect(parsePayslipAnswer({ ...verified(), verdict: "pending", confirmations: 0 }).outcome.verdict).toBe("pending");
  });

  it("not_found: no counts and no reason", () => {
    const answer = parsePayslipAnswer({ ...verified(), verdict: "not_found", confirmations: null, ironwood_actions: null });
    expect(answer.outcome).toEqual({ verdict: "not_found" });
  });

  it.each(PAYSLIP_INVALID_REASONS)("invalid, with the reason %s", (reason) => {
    const answer = parsePayslipAnswer({ ...verified(), verdict: "invalid", reason, confirmations: null, ironwood_actions: null });
    expect(answer.outcome).toEqual({ verdict: "invalid", reason });
  });

  it("reads a mainnet answer, and an action that is a high number of a long list", () => {
    expect(parsePayslipAnswer({ ...verified(), network: "mainnet" }).network).toBe("mainnet");
    expect(parsePayslipAnswer({ ...verified(), action: 328, ironwood_actions: 329 }).action).toBe(328);
  });
});

describe("parsePayslipAnswer: what it refuses", () => {
  const invalid = () => ({ ...verified(), verdict: "invalid", reason: "does_not_match", confirmations: null, ironwood_actions: null });
  const notFound = () => ({ ...verified(), verdict: "not_found", confirmations: null, ironwood_actions: null });

  it.each([
    ["the receiver", { receiver: "380decb3" }],
    ["the amount", { value: "90000" }],
    ["the secret", { rseed: "71b88bf4" }],
    ["a memo", { memo: "hello" }],
    ["something undocumented", { extra: 1 }],
  ])("%s, as an extra field: the answer is refused, not trimmed", (_what, extra) => {
    refused({ ...verified(), ...extra });
  });

  it.each(["network", "txid", "action", "verdict", "reason", "confirmations", "required_depth", "ironwood_actions", "not_proven"])(
    "an answer with no %s",
    (name) => {
      const answer: Record<string, unknown> = verified();
      Reflect.deleteProperty(answer, name);
      refused(answer);
    },
  );

  it.each([
    ["a verdict it does not know", { ...verified(), verdict: "valid" }],
    ["a verdict in capitals", { ...verified(), verdict: "Verified" }],
    ["a reason it does not know", { ...invalid(), reason: "wrong_amount" }],
    ["a network it does not know", { ...verified(), network: "regtest" }],
    ["a txid that is not 64 lowercase hex", { ...verified(), txid: TXID.toUpperCase() }],
    ["a negative action", { ...verified(), action: -1 }],
    ["a depth of zero", { ...verified(), required_depth: 0 }],
    ["confirmations as text", { ...verified(), confirmations: "19" }],
    ["a count that is not whole", { ...verified(), ironwood_actions: 8.5 }],
  ])("%s", (_what, answer) => {
    refused(answer);
  });

  it.each([
    ["verified below the depth", { ...verified(), confirmations: 2 }],
    ["pending at the depth", { ...verified(), verdict: "pending", confirmations: 3 }],
    ["pending above the depth", { ...verified(), verdict: "pending" }],
    ["verified with no confirmations", { ...verified(), confirmations: null }],
    ["verified with no action count", { ...verified(), ironwood_actions: null }],
    ["verified with a reason", { ...verified(), reason: "does_not_match" }],
    ["verified for an action the transaction does not have", { ...verified(), action: 8 }],
    ["not found with a reason", { ...notFound(), reason: "does_not_match" }],
    ["not found with confirmations", { ...notFound(), confirmations: 3 }],
    ["not found with an action count", { ...notFound(), ironwood_actions: 8 }],
    ["invalid with no reason", { ...invalid(), reason: null }],
    ["invalid with confirmations", { ...invalid(), confirmations: 3 }],
    ["invalid with an action count", { ...invalid(), ironwood_actions: 8 }],
  ])("%s: the verdict and the counts must agree", (_what, answer) => {
    refused(answer);
  });

  it.each([
    ["not a list", "Who the recipient is"],
    ["an empty list", []],
    ["a list with something that is not text", ["fine", 5]],
    ["a list with an empty sentence", ["fine", ""]],
    ["a sentence too long to be one", ["x".repeat(501)]],
    ["more sentences than anyone would write", Array.from({ length: 11 }, () => "A sentence.")],
    ["null", null],
  ])("the sentences about what it does not prove: %s", (_what, notProven) => {
    refused({ ...verified(), not_proven: notProven });
  });

  it.each([null, undefined, "verified", 5, [], [verified()]])("something that is not an answer: %j", (input) => {
    refused(input);
  });

  it("an error names the rule, never the value", () => {
    try {
      parsePayslipAnswer({ ...verified(), memo: "SENTINEL-do-not-repeat" });
    } catch (error) {
      expect(JSON.stringify((error as ZodError).issues)).not.toContain("SENTINEL");
      return;
    }
    throw new Error("expected the answer to be refused");
  });

  it("keeps the verifier's sentences as the verifier wrote them", () => {
    const sentences = ["One.", "Two, <b>with markup</b>."];
    expect(parsePayslipAnswer({ ...verified(), not_proven: sentences }).notProven).toEqual(sentences);
  });
});

// The strict parser refuses any field the verifier did not mention, so a field added on the Rust side
// would stop every check on this page. These read the verifier's own source to see it coming.
// covers: REQ-VER-006
describe("the contract with the verifier (crates/drop-verifier/src/api.rs)", () => {
  it("the answer has the fields the parser reads, and no others", () => {
    const block = between(apiRust, "// Network and verdict only: nothing of the payslip.", "})))");
    const keys = [...block.matchAll(/"([a-z_]+)":/gu)].map((match) => match[1]);
    expect(keys.sort()).toEqual(Object.keys(verified()).sort());
  });

  it("the verdicts are the four the parser reads", () => {
    const handler = between(apiRust, "let (verdict, reason, confirmations, actions) =", "// Network and verdict only");
    const found = stringLiterals(handler).filter((literal) => (PAYSLIP_VERDICTS as readonly string[]).includes(literal));
    expect(new Set(found)).toEqual(new Set(PAYSLIP_VERDICTS));
  });

  it("the reasons an invalid payslip gets are the seven the parser reads", () => {
    const reasons = stringLiterals(between(apiRust, "fn invalid_reason(", "\n}\n"));
    expect(reasons.sort()).toEqual([...PAYSLIP_INVALID_REASONS].sort());
  });

  it.each(["network_not_configured", "chain_unavailable", "chain_inconsistent", "payload_too_large", "invalid_payslip", "viewing_key_refused"])(
    "the verifier still has the error code %s that the page tells apart",
    (code) => {
      expect(apiRust).toContain(`"${code}"`);
    },
  );

  it("reads at most the 1 KiB this page stays under, and says 'too large' with the status the page reads that way", () => {
    expect(Number(/const MAX_PAYSLIP_BODY: usize = (\d+);/u.exec(apiRust)?.[1])).toBe(MAX_PAYSLIP_BODY);
    expect(between(apiRust, "async fn payslip<S>(", '"payload_too_large"')).toContain("StatusCode::PAYLOAD_TOO_LARGE");
  });
});

describe("what a payslip does not prove, before anything is checked", () => {
  // The Rust list is written over two lines where it is long, with a backslash at the end of the first.
  const rust = stringLiterals(between(payslipRust, "pub const NOT_PROVEN", "];").replace(/\\\n\s*/gu, ""));

  it("is the verifier's list, word for word", () => {
    expect(rust).toHaveLength(5);
    expect([...PAYSLIP_NOT_PROVEN]).toEqual(rust);
  });

  it("makes none of the claims the public cannot back up", () => {
    for (const sentence of PAYSLIP_NOT_PROVEN) {
      for (const [label, pattern] of BANNED) expect(sentence, `contains the banned claim: ${label}`).not.toMatch(pattern);
    }
  });

  it("is the answer's list when the verifier has answered", () => {
    expect(parsePayslipAnswer(verified()).notProven).toEqual(rust);
  });
});

describe("reasons", () => {
  it("are fixed codes that name no field", () => {
    for (const reason of PAYSLIP_INVALID_REASONS as readonly PayslipInvalidReason[]) {
      expect(reason).not.toMatch(/receiver|value|amount|rseed|secret/u);
    }
  });
});
