import { describe, expect, it } from "vitest";

import { between } from "@/test/rust-source";
import commandsSource from "../../../../crates/drop-operator/src/commands.rs?raw";

import { DISCLOSURE_WARNING, KEY_VISIBLE_MS } from "./disclosure";

/** The Rust constant, with its `\` line continuations joined as rustc does. */
function rustDisclosure(): string {
  // rustfmt may put the literal on the line after the `=`, so start from the first quote.
  const afterEquals = between(commandsSource, "pub const DISCLOSURE_WARNING: &str =", "\";");
  const literal = afterEquals.slice(afterEquals.indexOf("\"") + 1);
  return literal.replace(/\\\n\s*/gu, "");
}

describe("the disclosure warning", () => {
  it("is the operator's sentence, word for word", () => {
    expect(DISCLOSURE_WARNING).toBe(rustDisclosure());
  });

  it("says what is disclosed and that it cannot be undone", () => {
    expect(DISCLOSURE_WARNING).toMatch(/every payout of this campaign/u);
    expect(DISCLOSURE_WARNING).toMatch(/recipient address, amount and memo/u);
    expect(DISCLOSURE_WARNING).toMatch(/cannot be undone/u);
    expect(DISCLOSURE_WARNING).toMatch(/keep it forever/u);
  });

  it("is noticed if the operator changes it (this test compares with the real source)", () => {
    expect(rustDisclosure().length).toBeGreaterThan(150);
  });
});

describe("how long a revealed key stays on screen", () => {
  it("is two minutes", () => {
    expect(KEY_VISIBLE_MS).toBe(120_000);
  });
});
