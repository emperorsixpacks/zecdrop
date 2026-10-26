import { describe, expect, it } from "vitest";

import { fundingPaymentUri } from "./payment-uri";

const ADDRESS = "tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD";

describe("fundingPaymentUri", () => {
  it("is zcash:<address>?amount=<ZEC>, with the amount as a plain decimal", () => {
    expect(fundingPaymentUri(ADDRESS, "545000")).toBe(`zcash:${ADDRESS}?amount=0.00545`);
    expect(fundingPaymentUri(ADDRESS, "150000000")).toBe(`zcash:${ADDRESS}?amount=1.5`);
    expect(fundingPaymentUri(ADDRESS, "100000000")).toBe(`zcash:${ADDRESS}?amount=1`);
    expect(fundingPaymentUri(ADDRESS, "1")).toBe(`zcash:${ADDRESS}?amount=0.00000001`);
  });

  it("never carries a memo, a message or anything else about the payout", () => {
    const uri = fundingPaymentUri(ADDRESS, "545000") ?? "";
    expect([...new URLSearchParams(uri.split("?")[1] ?? "").keys()]).toEqual(["amount"]);
  });

  it("refuses an address that is not plain letters and digits, so nothing can be added to the link", () => {
    for (const bad of ["", "tm", `${ADDRESS}?amount=9`, `${ADDRESS}&memo=x`, `${ADDRESS}#x`, `${ADDRESS} `, "zcash:" + ADDRESS, `${ADDRESS}/`]) {
      expect(fundingPaymentUri(bad, "545000"), bad).toBeNull();
    }
  });

  it("refuses an amount that is zero, negative, fractional, in exponent form or not a number", () => {
    for (const bad of ["0", "-5", "1.5", "1e3", "", "abc", "007", " 5"]) {
      expect(fundingPaymentUri(ADDRESS, bad), bad).toBeNull();
    }
  });
});
