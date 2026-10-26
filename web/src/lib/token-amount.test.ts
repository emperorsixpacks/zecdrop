import { describe, expect, it } from "vitest";

import { formatTokenAmount, parseSmallestUnits, TokenAmountError } from "./token-amount";

describe("formatTokenAmount", () => {
  it.each([
    ["1234567", 6, 6, "1.234567"],
    ["1000000", 6, 6, "1"],
    ["0", 6, 6, "0"],
    ["5", 6, 6, "0.000005"],
    ["123", 0, 6, "123"],
    ["100000000", 8, 6, "1"],
    ["545000", 8, 6, "0.00545"],
    ["1000000000000000000", 18, 6, "1"],
    ["1234567890123456789", 18, 6, "1.234568"],
  ])("%s with %i decimals is %s", (raw, decimals, max, expected) => {
    expect(formatTokenAmount(raw, decimals, max)).toBe(expected);
  });

  it("rounds UP, so a price shown is never lower than the real one", () => {
    expect(formatTokenAmount("1234567", 6, 2)).toBe("1.24");
    expect(formatTokenAmount("1000001", 6, 2)).toBe("1.01");
    expect(formatTokenAmount("1", 18, 6)).toBe("0.000001");
    expect(formatTokenAmount("1000000", 6, 2)).toBe("1"); // exact: no change
  });

  it("carries across the point when rounding up", () => {
    expect(formatTokenAmount("999999999999999999", 18, 6)).toBe("1");
    expect(formatTokenAmount("99999999", 8, 2)).toBe("1");
  });

  it("handles amounts far beyond Number's exact range", () => {
    expect(formatTokenAmount("123456789012345678901234567890", 18, 6)).toBe("123456789012.345679");
  });

  it.each(["", "-1", "1.5", "1e3", " 1", "1 ", "01", "0x10", "abc", "١٢٣"])("refuses %j", (raw) => {
    expect(() => formatTokenAmount(raw, 6)).toThrow(TokenAmountError);
  });

  it.each([-1, 1.5, 37, Number.NaN])("refuses %s decimals", (decimals) => {
    expect(() => formatTokenAmount("1", decimals)).toThrow(TokenAmountError);
  });

  it("refuses an absurdly long number", () => {
    expect(() => parseSmallestUnits("1".repeat(79))).toThrow(TokenAmountError);
  });
});
