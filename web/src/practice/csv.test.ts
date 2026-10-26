// The importer the practice chain runs, tried on what the operator's own tests try (crates/drop-core/src/import.rs): the
// shape of a good list, every way a list can be wrong and the line it is reported on, and the places where a careless reader
// would let something through. server.test.ts compares whole answers with the real operator's; this is the edges.
import { describe, expect, it } from "vitest";

import { importCsv, MAX_MEMO_BYTES, type RowError, type RowErrorKind } from "./csv";

const A1 = "u1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const A2 = "u1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const A3 = "zs1cccccccccccccccccccccccccccccc";

const kinds = (errors: readonly RowError[]): [number, RowErrorKind][] => errors.map((error) => [error.line, error.kind]);

describe("a good list", () => {
  it("is read into rows in file order, with the amount in zatoshi and an empty memo as none", () => {
    const report = importCsv(`address,amount,memo\n${A1},1.5,hello\n${A2},0.25,\n${A3},3,\n`);
    expect(report.errors).toEqual([]);
    expect(report.rows).toEqual([
      { address: A1, amount: 150_000_000n, memo: "hello" },
      { address: A2, amount: 25_000_000n, memo: null },
      { address: A3, amount: 300_000_000n, memo: null },
    ]);
  });

  it("has a header in any case, in any order, with spaces round it, and a memo that is optional", () => {
    const report = importCsv(` Amount , ADDRESS \n2,${A1}\n`);
    expect(report.errors).toEqual([]);
    expect(report.rows).toEqual([{ address: A1, amount: 200_000_000n, memo: null }]);
  });

  it("may use semicolons, when the header has more of them than commas, a byte-order mark, and any line ending", () => {
    for (const text of [
      `address;amount;memo\n${A1};1;hi, there\n`,
      `\ufeffaddress,amount\r\n${A1},1\r\n`,
      `address,amount\r${A1},1\r`,
      `address,amount\n\n\n${A1},1\n\n`,
    ]) {
      const report = importCsv(text);
      expect(report.errors, text).toEqual([]);
      expect(report.rows, text).toHaveLength(1);
    }
    expect(importCsv(`address;amount;memo\n${A1};1;hi, there\n`).rows[0]?.memo).toBe("hi, there");
  });

  it("reads quoted fields: a delimiter, a doubled quote and a newline are text, and the line numbers go on counting", () => {
    const report = importCsv(`address,amount,memo\n${A1},1,"a, ""quoted""\nmemo"\n${A2},oops,\n`);
    expect(report.rows).toEqual([{ address: A1, amount: 100_000_000n, memo: 'a, "quoted"\nmemo' }]);
    // The second record starts on line 4: the quoted newline was a line of the file.
    expect(kinds(report.errors)).toEqual([[4, { code: "invalid_amount", reason: { code: "invalid_character" } }]]);
  });

  it("keeps a memo as it is written, spaces and all, and counts its bytes, not its characters", () => {
    expect(importCsv(`address,amount,memo\n${A1},1,  spaced  \n`).rows[0]?.memo).toBe("  spaced  ");
    // 256 two-byte characters are exactly the limit; one more byte is not.
    expect(importCsv(`address,amount,memo\n${A1},1,${"é".repeat(256)}\n`).errors).toEqual([]);
    const long = importCsv(`address,amount,memo\n${A1},1,${"é".repeat(256)}x\n`);
    expect(kinds(long.errors)).toEqual([[2, { code: "memo_too_long", bytes: MAX_MEMO_BYTES + 1, max: MAX_MEMO_BYTES }]]);
  });
});

describe("a header that is wrong", () => {
  it("is missing when the first row names no column, or there is nothing at all", () => {
    expect(kinds(importCsv("").errors)).toEqual([[1, { code: "missing_header" }]]);
    expect(kinds(importCsv("\n\n").errors)).toEqual([[1, { code: "missing_header" }]]);
    expect(kinds(importCsv(`${A1},1\n`).errors)).toEqual([[1, { code: "missing_header" }]]);
  });

  it("says each cell it does not know, each column it has twice and each one it lacks, by position", () => {
    expect(kinds(importCsv("address,amount,note\n").errors)).toEqual([[1, { code: "unknown_column", position: 3 }]]);
    expect(kinds(importCsv("address,amount,amount\n").errors)).toEqual([[1, { code: "duplicate_column", name: "amount" }]]);
    expect(kinds(importCsv("address,memo\n").errors)).toEqual([[1, { code: "missing_column", name: "amount" }]]);
    expect(kinds(importCsv("memo\n").errors)).toEqual([
      [1, { code: "missing_column", name: "address" }],
      [1, { code: "missing_column", name: "amount" }],
    ]);
    // Two of them at once: all of it is said, so one pass of fixing is enough.
    expect(kinds(importCsv("address,address,x\n").errors)).toEqual([
      [1, { code: "duplicate_column", name: "address" }],
      [1, { code: "unknown_column", position: 3 }],
      [1, { code: "missing_column", name: "amount" }],
    ]);
  });

  it("is refused outright when its quoting is wrong, and no row is read", () => {
    const report = importCsv(`"address,amount\n${A1},1\n`);
    expect(kinds(report.errors)).toEqual([[1, { code: "unterminated_quote" }]]);
    expect(report.rows).toEqual([]);
  });
});

describe("a row that is wrong", () => {
  it("has the wrong number of cells", () => {
    expect(kinds(importCsv(`address,amount,memo\n${A1},1\n${A2},1,m,extra\n`).errors)).toEqual([
      [2, { code: "field_count", expected: 3, found: 2 }],
      [3, { code: "field_count", expected: 3, found: 4 }],
    ]);
  });

  it("has a quote that is never closed, which swallows the rest of the file rather than hiding in it", () => {
    const report = importCsv(`address,amount,memo\n${A1},1,"never closed\n${A2},2,\n`);
    expect(kinds(report.errors)).toEqual([[2, { code: "unterminated_quote" }]]);
    expect(report.rows).toEqual([]);
  });

  it("has a quote where it must not be: inside an unquoted cell, or text after a closing quote", () => {
    expect(kinds(importCsv(`address,amount\nu1a"bc,1\n`).errors)).toEqual([[2, { code: "malformed_quote" }]]);
    expect(kinds(importCsv(`address,amount\n"${A1}"x,1\n`).errors)).toEqual([[2, { code: "malformed_quote" }]]);
  });

  it("says why an address is wrong, in the operator's words, and never what it was", () => {
    const report = importCsv(
      ["address,amount", ",1", "x1abc,1", "u1 abc,1", "u1abc!,1", "é1abc,1", `t1abc,1`, `${"u".repeat(1025)},1`].join("\n"),
    );
    expect(report.errors.map((error) => error.message)).toEqual([
      "address is empty",
      "address is not valid: unknown address prefix",
      "address is not valid: unexpected character",
      "address is not valid: unexpected character",
      "address is not valid: unexpected character",
      "transparent addresses are not allowed; use a shielded or unified address",
      "address is not valid: address is too long",
    ]);
    for (const error of report.errors) expect(JSON.stringify(error)).not.toMatch(/abc|uuuu/u);
  });

  it("looks only at the shape of an address, as the practice chain does: a real-looking one with a bad checksum is accepted", () => {
    expect(importCsv(`address,amount\nutest1thisisnotarealaddressbutithastherightshape,1\n`).errors).toEqual([]);
    expect(importCsv(`address,amount\nZS1UPPERCASEISFINE,1\n`).errors).toEqual([]);
  });

  it("repeats an address on an earlier line, in any case for the kinds that ignore case, and says which line was first", () => {
    const report = importCsv(`address,amount\n${A1},1\n${A2},1\n${A1.toUpperCase()},2\n${A3},1\n${A3.toUpperCase()},1\n`);
    expect(kinds(report.errors)).toEqual([
      [4, { code: "duplicate_address", first_line: 2 }],
      [6, { code: "duplicate_address", first_line: 5 }],
    ]);
    // A duplicate is found even when the amount beside it is bad: one pass of fixing is enough.
    const both = importCsv(`address,amount\n${A1},1\n${A1},abc\n`);
    expect(kinds(both.errors)).toEqual([
      [3, { code: "duplicate_address", first_line: 2 }],
      [3, { code: "invalid_amount", reason: { code: "invalid_character" } }],
    ]);
  });

  it("keeps the rows that read well out of the report's use: the rows are only for a list with no errors", () => {
    const report = importCsv(`address,amount\n${A1},1\n${A2},abc\n`);
    expect(report.errors).toHaveLength(1);
    expect(report.rows).toHaveLength(1);
  });
});

describe("an amount", () => {
  const amount = (text: string) => importCsv(`address,amount\n${A1},${text}\n`);
  const reason = (text: string) => {
    const kind = amount(text).errors[0]?.kind;
    if (kind === undefined) return "ok";
    return kind.code === "invalid_amount" ? kind.reason.code : kind.code;
  };

  it.each([
    ["1", 100_000_000n],
    ["0.5", 50_000_000n],
    ["0.00000001", 1n],
    ["  2.25  ", 225_000_000n],
    ["21000000", 2_100_000_000_000_000n],
    ["00001", 100_000_000n],
  ])("%j is %s zatoshi", (text, zatoshi) => {
    expect(amount(text).rows[0]?.amount).toBe(zatoshi);
  });

  it.each([
    ["", "empty"],
    ["-1", "negative"],
    ["1e3", "scientific_notation"],
    ["1E3", "scientific_notation"],
    ["e3", "invalid_character"],
    ["+1", "invalid_character"],
    ["1 000", "invalid_character"],
    ["1_000", "invalid_character"],
    ["١", "invalid_character"],
    ["NaN", "invalid_character"],
    [".5", "malformed_decimal"],
    ["1.", "malformed_decimal"],
    ["1.2.3", "malformed_decimal"],
    ["0.123456789", "too_many_decimals"],
    ["21000001", "exceeds_max_money"],
    ["21000000.00000001", "exceeds_max_money"],
    ["99999999999999999999999", "exceeds_max_money"],
    ["0", "zero_amount"],
    ["0.0", "zero_amount"],
  ])("%j is refused as %s", (text, why) => {
    expect(reason(text)).toBe(why);
  });
});
