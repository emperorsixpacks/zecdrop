import { describe, expect, it } from "vitest";

import recipientRust from "../../../crates/drop-core/src/recipient.rs?raw";

import { MAX_MEMO_BYTES, memoBytes } from "./memo";

describe("memo", () => {
  it("has the importer's limit", () => {
    expect(recipientRust).toContain(`pub const MAX_MEMO_BYTES: usize = ${String(MAX_MEMO_BYTES)};`);
  });

  it("counts bytes of UTF-8, not characters", () => {
    expect(memoBytes("")).toBe(0);
    expect(memoBytes("Happy Eid")).toBe(9);
    expect(memoBytes("é")).toBe(2);
    expect(memoBytes("🎉")).toBe(4);
    expect(memoBytes("x".repeat(MAX_MEMO_BYTES))).toBe(MAX_MEMO_BYTES);
  });
});
