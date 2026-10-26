import { describe, expect, it } from "vitest";

import { pageName } from "./page-name";

describe("the name the header capsule gives the page", () => {
  it.each([
    ["/", "Home"],
    ["/r/demo", "Receipt"],
    ["/r/camp-01", "Receipt"],
    ["/get-paid", "Get paid"],
    ["/payslip", "Payslip"],
    ["/privacy", "How privacy works"],
  ])("names the public page %s %s", (path, name) => {
    expect(pageName(path, false)).toBe(name);
    // A visitor on the operator's own copy reads the same names on the public pages.
    expect(pageName(path, true)).toBe(name);
  });

  it.each([
    ["/campaigns", "Payouts"],
    ["/new", "New payout"],
    ["/new/check", "New payout"],
    ["/new/send", "New payout"],
    ["/campaign/camp-01", "Payout"],
    ["/audit", "Audit"],
  ])("names the operator page %s %s", (path, name) => {
    expect(pageName(path, true)).toBe(name);
  });

  it("does not name an operator page on a copy that has no operator: that address shows a notice, not the page", () => {
    for (const path of ["/campaigns", "/new", "/new/send", "/campaign/camp-01", "/audit"]) {
      expect(pageName(path, false), path).toBe("ZecDrop");
    }
  });

  it("falls back to the name of the site for anything else", () => {
    for (const path of ["/nope", "/r", "/newsletter", "/campaignsx", "/auditing", "/get-paid/extra"]) {
      expect(pageName(path, true), path).toBe("ZecDrop");
    }
  });

  it("reads an address the way the router does: a trailing slash and capital letters change nothing", () => {
    expect(pageName("/privacy/", false)).toBe("How privacy works");
    expect(pageName("/Get-Paid", false)).toBe("Get paid");
    expect(pageName("/campaigns/", true)).toBe("Payouts");
  });
});
