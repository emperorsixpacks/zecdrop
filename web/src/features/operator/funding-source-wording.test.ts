import { describe, expect, it } from "vitest";

import { RECEIPT_SOURCE_WORDING } from "@/features/receipt/funding-source-wording";
import { BANNED } from "@/test/banned-phrases";

import { FUNDING_SOURCE_WORDING } from "./funding-source-wording";

const sentences = (wording: object): string[] =>
  Object.values(wording).flatMap((value: unknown) => (typeof value === "string" ? [value] : Array.isArray(value) ? (value as string[]) : []));

// covers: REQ-FUND-004, REQ-VER-007
describe("what the copy says about where a deposit came from", () => {
  const lines = [...sentences(FUNDING_SOURCE_WORDING), ...sentences(RECEIPT_SOURCE_WORDING)];

  it("makes none of the claims this project must not make", () => {
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      for (const [label, pattern] of BANNED) expect(line, `"${line}" says: ${label}`).not.toMatch(pattern);
    }
  });

  it("says what stays public wherever it says a deposit names no address", () => {
    for (const line of lines.filter((l) => /names? no (payer )?address/u.test(l))) {
      const said = [line, ...FUNDING_SOURCE_WORDING.askMore, RECEIPT_SOURCE_WORDING.shieldedMore].join(" ");
      expect(said, line).toMatch(/amount and (the )?time (are|would be) public/u);
    }
    expect(FUNDING_SOURCE_WORDING.shielded).toMatch(/amount and time are public/u);
    expect(RECEIPT_SOURCE_WORDING.shieldedMore).toMatch(/amount and time are public/u);
    expect(RECEIPT_SOURCE_WORDING.flowHelp).toMatch(/never says who paid/u);
  });

  it("would be caught claiming what a shielded deposit cannot give", () => {
    for (const claim of [
      "The payer stays hidden.",
      "Your deposit is untraceable.",
      "An anonymous deposit, from you.",
      "Nobody can see who paid.",
      "It cannot be linked to you.",
      "This hides who paid.",
    ]) {
      expect(
        BANNED.some(([, pattern]) => pattern.test(claim)),
        claim,
      ).toBe(true);
    }
  });

  it("never says a transparent deposit stops the payout", () => {
    expect(FUNDING_SOURCE_WORDING.transparent).toMatch(/You can still send/u);
    expect(`${FUNDING_SOURCE_WORDING.transparentTitle} ${FUNDING_SOURCE_WORDING.transparent}`).not.toMatch(/cannot send|blocked|refused/iu);
  });
});
