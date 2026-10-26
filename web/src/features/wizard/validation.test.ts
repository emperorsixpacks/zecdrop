import { describe, expect, it } from "vitest";

import { batchSizeProblem, CSV_MAX_BYTES, csvProblem, nameProblem } from "./validation";

describe("nameProblem (mirrors the operator: 1 to 100 characters, no control characters)", () => {
  it.each(["Spring drop", "a", "x".repeat(100), "Café \u{1F512}", "  padded  "])("accepts %j", (name) => {
    expect(nameProblem(name)).toBeNull();
  });

  it.each(["", "   ", "\t\n"])("asks for a name when given %j", (name) => {
    expect(nameProblem(name)).toMatch(/name/u);
  });

  it("counts characters, not UTF-16 units", () => {
    expect(nameProblem("\u{1F512}".repeat(100))).toBeNull();
    expect(nameProblem("\u{1F512}".repeat(101))).toMatch(/at most 100/u);
  });

  it.each(["a\u0000b", "a\nb", "a\u007fb", "a\u0085b"])("refuses control characters in %j", (name) => {
    expect(nameProblem(name)).toMatch(/control/u);
  });
});

describe("batchSizeProblem", () => {
  it.each([2, 3, 50, 330])("accepts %i", (n) => {
    expect(batchSizeProblem(n)).toBeNull();
  });

  it("refuses a batch of one, and says why", () => {
    expect(batchSizeProblem(1)).toMatch(/at least 2/u);
    expect(batchSizeProblem(1)).toMatch(/reveal/u);
    expect(batchSizeProblem(0)).toMatch(/at least 2/u);
    expect(batchSizeProblem(-5)).toMatch(/at least 2/u);
  });

  it("refuses more than fit in one transaction", () => {
    expect(batchSizeProblem(331)).toMatch(/330/u);
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses %s", (n) => {
    expect(batchSizeProblem(n)).toMatch(/whole number/u);
  });
});

describe("csvProblem (says nothing about the content)", () => {
  it("asks for recipients when empty or blank", () => {
    expect(csvProblem("")).toMatch(/Add the recipients/u);
    expect(csvProblem("  \n\t ")).toMatch(/Add the recipients/u);
  });

  it("accepts anything non-blank within the size limit; the operator checks the rest", () => {
    expect(csvProblem("anything at all")).toBeNull();
  });

  it("refuses more than the operator's limit, counting bytes not characters", () => {
    expect(csvProblem("x".repeat(CSV_MAX_BYTES))).toBeNull();
    expect(csvProblem("x".repeat(CSV_MAX_BYTES + 1))).toMatch(/32 MB/u);
    expect(csvProblem("é".repeat(CSV_MAX_BYTES / 2 + 1))).toMatch(/32 MB/u);
  });

  it("never repeats the input in its message", () => {
    expect(csvProblem("u1sentineladdressaaaa,1.5")).toBeNull();
    expect(`${csvProblem("") ?? ""}${csvProblem("x".repeat(CSV_MAX_BYTES + 1)) ?? ""}`).not.toContain("xxxx");
  });
});
