import { describe, expect, it } from "vitest";

import { coinUnit, unitNote } from "./units";

describe("coin units", () => {
  it("mainnet is ZEC and testnet is TAZ", () => {
    expect(coinUnit("mainnet")).toBe("ZEC");
    expect(coinUnit("testnet")).toBe("TAZ");
  });

  it("only testnet needs explaining, and says the coin has no value", () => {
    expect(unitNote("ZEC")).toBeNull();
    expect(unitNote("TAZ")).toBe("Amounts are in TAZ, the testnet coin. It has no value.");
  });
});
