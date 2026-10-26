import { describe, expect, it } from "vitest";

import { describeNearStatus, KNOWN_NEAR_STATUSES, NEAR_FUNDED_ONLY_ON_CHAIN } from "./status";

// The service's seven statuses, from its documentation (crates/drop-near/src/status.rs), in the
// lower-case words the operator reports them in.
const DOCUMENTED = [
  "pending_deposit",
  "known_deposit_tx",
  "processing",
  "success",
  "incomplete_deposit",
  "refunded",
  "failed",
];

describe("describeNearStatus", () => {
  it("has a sentence for each of the seven documented statuses, and for no others", () => {
    expect([...KNOWN_NEAR_STATUSES].sort()).toEqual([...DOCUMENTED].sort());
    for (const status of DOCUMENTED) {
      const d = describeNearStatus(status);
      expect(d.title.length, status).toBeGreaterThan(5);
      expect(d.detail.length, status).toBeGreaterThan(20);
      expect(d.tone, status).not.toBe("unknown");
    }
  });

  it("no status, SUCCESS included, says the campaign is funded", () => {
    for (const status of [...DOCUMENTED, "unknown", "something_new"]) {
      const text = Object.values(describeNearStatus(status)).join(" ");
      // Take out the ways the word may be used (negated, or as the condition for being funded);
      // if "funded" is left, it was said affirmatively.
      const rest = text
        .replace(/\bnot (yet )?(been )?funded\b/giu, "")
        .replace(/\bcount as funded\b/giu, "")
        .replace(/\bfunded by (this|it)\b/giu, "");
      expect(rest, status).not.toMatch(/\bfunded\b|\bfunding (is )?complete\b|\bready to send\b/iu);
    }
  });

  it("every one of them says the campaign is not funded by it yet, or by it at all", () => {
    for (const status of DOCUMENTED.filter((s) => s !== "pending_deposit")) {
      expect(describeNearStatus(status).detail, status).toMatch(/not (been )?funded|only then|not proof/iu);
    }
  });

  it("success is the service's report, not proof, and the page goes on checking the chain", () => {
    const d = describeNearStatus("success");
    expect(d.tone).toBe("check");
    expect(d.title).toBe("Paid to the deposit address, says the service");
    expect(d.detail).toMatch(/not proof/u);
    expect(d.detail).toMatch(/chain/u);
    expect(d.keepPolling).toBe(true);
  });

  it("stops asking once the swap has ended one way or the other, and keeps asking while it can still change", () => {
    expect(describeNearStatus("refunded").keepPolling).toBe(false);
    expect(describeNearStatus("failed").keepPolling).toBe(false);
    for (const status of ["pending_deposit", "known_deposit_tx", "processing", "incomplete_deposit", "success"]) {
      expect(describeNearStatus(status).keepPolling, status).toBe(true);
    }
  });

  it("a word this page has never heard of says to investigate, shows the word as text, and stops", () => {
    const d = describeNearStatus("mystery_state");
    expect(d.tone).toBe("unknown");
    expect(d.detail).toContain('"mystery_state"');
    expect(d.detail).toMatch(/Do not send more/u);
    expect(d.keepPolling).toBe(false);
  });

  it("the operator's own word 'unknown' says to investigate without quoting a word, and stops", () => {
    const d = describeNearStatus("unknown");
    expect(d.tone).toBe("unknown");
    expect(d.detail).not.toContain('"');
    expect(d.detail).toMatch(/Do not send more/u);
    expect(d.keepPolling).toBe(false);
  });

  it("the old upper-case spellings are not words the operator uses, so they are not taken for known ones", () => {
    for (const status of ["PENDING_DEPOSIT", "SUCCESS"]) expect(describeNearStatus(status).tone, status).toBe("unknown");
  });

  it("clips a very long unknown status, and treats inherited property names as unknown, not as known", () => {
    expect(describeNearStatus("X".repeat(500)).detail.length).toBeLessThan(400);
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(describeNearStatus(name).tone, name).toBe("unknown");
    }
  });

  it("the persistent line says what counts", () => {
    expect(NEAR_FUNDED_ONLY_ON_CHAIN).toBe("The campaign counts as funded only when the coin appears on chain.");
  });
});
