import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import rustSource from "../../../crates/drop-core/src/warnings.rs?raw";
import { between, fill, stringLiterals } from "@/test/rust-source";

import {
  parsePrivacyWarnings,
  warningMessage,
  warningTitle,
  type PrivacyWarning,
} from "./warnings";

// ---- Agreement with the core ----------------------------------------------

// covers: REQ-PRIV-003
describe("messages equal the core's own sentences", () => {
  // The four literals inside `PrivacyWarning::message`, in declaration order.
  const [singleton, small, two, uniform] = stringLiterals(
    between(rustSource, "pub fn message(&self) -> String {", "impl fmt::Display for PrivacyWarning"),
  );

  it("found exactly the four sentences in the Rust source", () => {
    expect(
      [singleton, small, two, uniform].every((s) => typeof s === "string" && s.length > 20),
    ).toBe(true);
  });

  it("singleton campaign", () => {
    expect(warningMessage({ code: "singleton_campaign" })).toBe(singleton);
  });

  it.each([0, 1, 2, 3, 4, 17, 4_294_967_295])("small campaign with %i recipients", (n) => {
    expect(warningMessage({ code: "small_campaign", recipients: n })).toBe(
      fill(small ?? "", { recipients: n }),
    );
  });

  it.each([0, 1, 2, 9, 10, 4_294_967_295])("two-recipient batch %i", (i) => {
    expect(warningMessage({ code: "two_recipient_batch", batchIndex: i })).toBe(
      fill(two ?? "", { batch_index: i }),
    );
  });

  it.each([0, 1, 2, 9, 10, 4_294_967_295])("uniform batch %i", (i) => {
    expect(warningMessage({ code: "uniform_batch", batchIndex: i })).toBe(
      fill(uniform ?? "", { batch_index: i }),
    );
  });

  it("the core's JSON examples parse to the same codes", () => {
    // Shapes from warnings.rs's json_shape_and_user_messages test.
    expect(
      parsePrivacyWarnings([
        { code: "singleton_campaign" },
        { code: "small_campaign", recipients: 3 },
        { code: "two_recipient_batch", batch_index: 2 },
        { code: "uniform_batch", batch_index: 4 },
      ]),
    ).toEqual([
      { code: "singleton_campaign" },
      { code: "small_campaign", recipients: 3 },
      { code: "two_recipient_batch", batchIndex: 2 },
      { code: "uniform_batch", batchIndex: 4 },
    ]);
  });
});

// ---- Strictness ------------------------------------------------------------

// covers: REQ-PRIV-003
describe("parsePrivacyWarnings", () => {
  const rejects = (input: unknown) => expect(() => parsePrivacyWarnings(input)).toThrow(ZodError);

  it("accepts an empty list", () => {
    expect(parsePrivacyWarnings([])).toEqual([]);
  });

  it.each([
    ["an unknown code", [{ code: "huge_campaign" }]],
    ["no code", [{ recipients: 3 }]],
    ["a missing count", [{ code: "small_campaign" }]],
    ["a missing batch index", [{ code: "uniform_batch" }]],
    ["a negative count", [{ code: "small_campaign", recipients: -1 }]],
    ["a fractional count", [{ code: "small_campaign", recipients: 2.5 }]],
    ["a string count", [{ code: "small_campaign", recipients: "3" }]],
    ["a count above u32", [{ code: "small_campaign", recipients: 4_294_967_296 }]],
    ["the camelCase index name", [{ code: "uniform_batch", batchIndex: 1 }]],
    ["a non-array", { code: "singleton_campaign" }],
    ["null", null],
  ])("rejects %s", (_label, input) => {
    rejects(input);
  });

  // covers: REQ-PRIV-002
  it.each([
    ["address", "u1sentineladdress"],
    ["recipient", "u1sentineladdress"],
    ["recipients_list", ["u1sentineladdress"]],
    ["amount", "7777001"],
    ["memo", "sentinel-memo"],
  ])("rejects a smuggled `%s` field on every warning", (key, value) => {
    for (const warning of [
      { code: "singleton_campaign" },
      { code: "small_campaign", recipients: 3 },
      { code: "two_recipient_batch", batch_index: 1 },
      { code: "uniform_batch", batch_index: 1 },
    ]) {
      rejects([{ ...warning, [key]: value }]);
    }
  });

  it("does not echo a smuggled value in the error", () => {
    let message = "";
    try {
      parsePrivacyWarnings([{ code: "singleton_campaign", address: "u1sentineladdress" }]);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).not.toContain("u1sentineladdress");
  });
});

// ---- Presentation ----------------------------------------------------------

describe("titles", () => {
  it("every code has a short, distinct heading", () => {
    const codes = [
      "singleton_campaign",
      "small_campaign",
      "two_recipient_batch",
      "uniform_batch",
    ] as const satisfies readonly PrivacyWarning["code"][];
    const titles = codes.map(warningTitle);
    expect(new Set(titles).size).toBe(codes.length);
    for (const t of titles) expect(t.length).toBeLessThan(30);
  });
});
