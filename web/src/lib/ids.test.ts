import { describe, expect, it } from "vitest";

import { shortId } from "./ids";

describe("shortId", () => {
  const id = "0123456789abcdef".repeat(4);

  it("keeps both ends so two ids can be compared by eye", () => {
    expect(shortId(id)).toBe("01234567…89abcdef");
    expect(shortId(id, 4)).toBe("0123…cdef");
  });

  it("leaves a short value alone", () => {
    expect(shortId("abc")).toBe("abc");
    expect(shortId("a".repeat(17))).toBe("a".repeat(17));
  });
});
