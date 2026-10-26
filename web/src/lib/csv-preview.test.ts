import { describe, expect, it } from "vitest";

import { previewPayouts } from "./csv-preview";

const rowsOf = (text: string) => {
  const p = previewPayouts(text);
  if (p.kind !== "rows") throw new Error(`expected rows, got ${p.kind}`);
  return p;
};

describe("previewPayouts", () => {
  it("reads a header and rows, and adds up the amounts", () => {
    const p = rowsOf("address,amount,memo\nu1aaa,1.5,hello\nu1bbb,2.25,\nu1ccc,0.75,x\n");
    expect(p.rows.map((r) => [r.address, r.amountText, r.memo])).toEqual([
      ["u1aaa", "1.5", "hello"],
      ["u1bbb", "2.25", ""],
      ["u1ccc", "0.75", "x"],
    ]);
    expect(p.total).toBe(450_000_000n);
    expect(p.unreadableAmounts).toBe(0);
  });

  it("numbers each row by the line its record starts on, as the operator does", () => {
    const p = rowsOf('address,amount,memo\nu1a,1,"two\nlines"\nu1b,2,\n\nu1c,3,\n');
    expect(p.rows.map((r) => r.line)).toEqual([2, 4, 6]);
  });

  it("takes the columns in any order, with any letter case, and memo is optional", () => {
    const p = rowsOf("Amount,ADDRESS\n1,u1a\n2,u1b\n");
    expect(p.rows.map((r) => [r.address, r.amountText, r.memo])).toEqual([
      ["u1a", "1", ""],
      ["u1b", "2", ""],
    ]);
    expect(p.total).toBe(300_000_000n);
  });

  it("copes with a BOM, CRLF line ends and semicolons", () => {
    const p = rowsOf("﻿address;amount\r\nu1a;1,5\r\nu1b;2\r\n");
    expect(p.rows.map((r) => r.address)).toEqual(["u1a", "u1b"]);
    // "1,5" is not a plain amount: it is shown, not added.
    expect(p.rows[0]?.amount).toBeNull();
    expect(p.unreadableAmounts).toBe(1);
    expect(p.total).toBe(200_000_000n);
  });

  it("reads quoted fields, with delimiters and doubled quotes inside", () => {
    const p = rowsOf('address,amount,memo\nu1a,1,"a, b ""c"""\n');
    expect(p.rows[0]?.memo).toBe('a, b "c"');
  });

  it("shows an amount it cannot read as it was written, and leaves it out of the total", () => {
    const p = rowsOf("address,amount\nu1a,1\nu1b,abc\nu1c,-2\nu1d,1e3\nu1e,\n");
    expect(p.rows.map((r) => r.amount === null)).toEqual([false, true, true, true, true]);
    expect(p.unreadableAmounts).toBe(4);
    expect(p.total).toBe(100_000_000n);
  });

  it("is empty for nothing at all, and says what a missing header needs", () => {
    expect(previewPayouts("")).toEqual({ kind: "empty" });
    expect(previewPayouts("  \n \n")).toEqual({ kind: "empty" });
    for (const text of ["u1a,1\nu1b,2\n", "name,value\nx,1\n", "address\nu1a\n"]) {
      const p = previewPayouts(text);
      expect(p.kind, text).toBe("no_header");
    }
  });

  it("does not fail on an unterminated quote (the operator will say what is wrong)", () => {
    const p = rowsOf('address,amount,memo\nu1a,1,"never closed\nu1b,2,\n');
    expect(p.rows).toHaveLength(1);
  });

  it("handles a large list without trouble", () => {
    const body = Array.from({ length: 20_000 }, (_, i) => `u1addr${String(i)},0.0001`).join("\n");
    const p = rowsOf(`address,amount\n${body}\n`);
    expect(p.rows).toHaveLength(20_000);
    expect(p.total).toBe(20_000n * 10_000n);
  });
});
