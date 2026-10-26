import { describe, expect, it } from "vitest";

import { importCsv } from "@/test/csv-import";
import { formatZec, parseZec } from "@/lib/zec";

import {
  addressHint,
  amountProblem,
  applySplit,
  blankPerson,
  composeCsv,
  CSV_HEADER,
  lineOf,
  listTotal,
  luckySplit,
  personProblems,
  splitEvenly,
  totalProblem,
  type Person,
} from "./people";

const person = (address: string, amount: string, memo = ""): Person => ({ ...blankPerson(), address, amount, memo });

/** Random bytes from a small fixed generator, so a lucky split can be repeated. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return (length: number) =>
    Uint8Array.from({ length }, () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state >>> 24;
    });
}

const sum = (shares: readonly bigint[]) => shares.reduce((a, b) => a + b, 0n);

// Addresses that the test importer (a port of the operator's, with the mock chain's shape-only codec) accepts.
const A = "u1alphaaddressforthelisttest";
const B = "u1bravoaddressforthelisttest";
const C = "u1charlieaddressforthelisttest";

describe("composeCsv", () => {
  // covers: REQ-IMP-002
  it("writes the header, then one line per person in order, as the importer reads it", () => {
    const text = composeCsv([person(A, "1.5", "Happy Eid"), person(B, "0.25")]);
    expect(text).toBe(`${CSV_HEADER}\n${A},1.5,Happy Eid\n${B},0.25,\n`);
    const report = importCsv(text);
    expect(report.errors).toEqual([]);
    expect(report.rows).toEqual([
      { address: A, amount: 150_000_000n, memo: "Happy Eid" },
      { address: B, amount: 25_000_000n, memo: null },
    ]);
  });

  // covers: REQ-IMP-002
  it("quotes a note with commas, quotes or a semicolon, and keeps letters of any language", () => {
    const notes = ['Mum, Dad and "the twins"', "Eid Mubarak; ¡feliz año!", "Ẹ ku ọdun 🎉", "a,b,,c"];
    const people = notes.map((memo, i) => person([A, B, C, `${A}x`][i] ?? A, "0.1", memo));
    const report = importCsv(composeCsv(people));
    expect(report.errors).toEqual([]);
    expect(report.rows.map((row) => row.memo)).toEqual(notes);
  });

  // covers: REQ-IMP-002
  it("keeps every person on one line, so the operator's line numbers point at people", () => {
    const people = [person(A, "1", "two\nlines"), person(B, "1", "  padded  "), person(C, "not a number")];
    const text = composeCsv(people);
    expect(text.split("\n")).toHaveLength(people.length + 2);
    const report = importCsv(text);
    expect(report.errors.map((error) => error.line)).toEqual([lineOf(2)]);
    expect(report.errors[0]?.kind.code).toBe("invalid_amount");
  });

  it("writes amounts the way the importer's own formatter does", () => {
    expect(composeCsv([person(A, "0.50"), person(B, " 2 ")])).toBe(`${CSV_HEADER}\n${A},0.5,\n${B},2,\n`);
  });
});

describe("splitEvenly", () => {
  // covers: REQ-IMP-002
  it("gives everyone exactly the same share and leaves out what cannot be shared equally", () => {
    expect(splitEvenly(900n, 3)).toEqual([300n, 300n, 300n]);
    expect(splitEvenly(1_000n, 3)).toEqual([333n, 333n, 333n]);
    expect(splitEvenly(2n, 3)).toEqual([]);
    expect(splitEvenly(10n, 0)).toEqual([]);
    expect(splitEvenly(0n, 3)).toEqual([]);
  });
});

describe("luckySplit", () => {
  // covers: REQ-IMP-002
  it("adds up exactly, gives everyone at least half an even share, and never gives all the same", () => {
    for (const [total, people] of [
      [500_000n, 8],
      [1_000_000_000n, 2],
      [12_345_678n, 7],
      [7n, 3],
      [6n, 3],
      [100n, 50],
      [2_100_000_000_000_000n, 330],
    ] as const) {
      for (let seed = 1; seed <= 25; seed += 1) {
        const shares = luckySplit(total, people, seeded(seed));
        expect(shares).toHaveLength(people);
        expect(sum(shares)).toBe(total);
        const least = total / BigInt(people) / 2n;
        for (const share of shares) expect(share >= least && share > 0n).toBe(true);
        expect(new Set(shares).size).toBeGreaterThan(1);
      }
    }
  });

  it("is all equal by chance only with all-equal random bytes, and is then put right", () => {
    const zeros = (length: number) => new Uint8Array(length);
    const shares = luckySplit(9n, 3, zeros);
    expect(sum(shares)).toBe(9n);
    expect(new Set(shares).size).toBeGreaterThan(1);
  });

  it("depends only on the random bytes it is given", () => {
    expect(luckySplit(5_000_000n, 8, seeded(42))).toEqual(luckySplit(5_000_000n, 8, seeded(42)));
    expect(luckySplit(5_000_000n, 8, seeded(42))).not.toEqual(luckySplit(5_000_000n, 8, seeded(43)));
  });

  it("gives one person the whole total, and refuses a total too small to share", () => {
    expect(luckySplit(5n, 1, seeded(1))).toEqual([5n]);
    expect(luckySplit(5n, 3, seeded(1))).toEqual([]);
    expect(luckySplit(0n, 3, seeded(1))).toEqual([]);
  });
});

describe("applySplit", () => {
  const people = [person(A, "1"), person(B, "2"), person(C, "3")];

  it("leaves typed amounts alone", () => {
    expect(applySplit(people, "each", "10", seeded(1)).map((p) => p.amount)).toEqual(["1", "2", "3"]);
  });

  // covers: REQ-IMP-002
  it("writes every share as the importer reads it, and empties them for a total that cannot be used", () => {
    expect(applySplit(people, "even", "0.01", seeded(1)).map((p) => p.amount)).toEqual(["0.00333333", "0.00333333", "0.00333333"]);
    const lucky = applySplit(people, "lucky", "0.01", seeded(7)).map((p) => p.amount);
    expect(sum(lucky.map((amount) => parseZec(amount)))).toBe(1_000_000n);
    expect(applySplit(people, "even", "", seeded(1)).map((p) => p.amount)).toEqual(["", "", ""]);
    expect(applySplit(people, "lucky", "abc", seeded(1)).map((p) => p.amount)).toEqual(["", "", ""]);
    expect(applySplit(people, "even", "0.00000002", seeded(1)).map((p) => p.amount)).toEqual(["", "", ""]);
  });

  it("keeps who is who", () => {
    expect(applySplit(people, "even", "3", seeded(1)).map((p) => p.key)).toEqual(people.map((p) => p.key));
  });
});

describe("checks", () => {
  it("names what is missing or wrong in a row, never the value", () => {
    const people = [person("", ""), person(A, "1.123456789"), person(A.toUpperCase(), "0"), person(B, "1", "x".repeat(513))];
    expect(personProblems(people, 0, "each")).toEqual({ address: "Add their address.", amount: "Add an amount.", memo: null });
    expect(personProblems(people, 1, "each").amount).toBe("Use at most 8 decimal places.");
    expect(personProblems(people, 2, "each")).toEqual({
      address: "The same address as person 2.",
      amount: "The amount must be more than 0.",
      memo: null,
    });
    expect(personProblems(people, 3, "each").memo).toBe("The note is too long: 513 of 512 bytes.");
    // In a split the amounts follow from the total, which is checked on its own.
    expect(personProblems(people, 0, "even").amount).toBeNull();
  });

  it("says why an amount or a total cannot be used, in one short sentence", () => {
    expect(amountProblem("1,5")).toBe("Write it with a dot, like 0.5, and no spaces.");
    expect(amountProblem("1e3")).toBe("Write it as a number, like 0.5.");
    expect(amountProblem("-1")).toBe("The amount can't be negative.");
    expect(amountProblem("22000000")).toBe("That is more than all the ZEC there will ever be.");
    expect(amountProblem(" 0.5 ")).toBeNull();
    expect(totalProblem("", 3, "even")).toBe("Type the total to split.");
    expect(totalProblem("0.00000002", 3, "even")).toBe("That total is too small to split between them.");
    expect(totalProblem("0.00000005", 3, "lucky")).toBe("That total is too small to split between them.");
    expect(totalProblem("0.00000006", 3, "lucky")).toBeNull();
    expect(totalProblem("1", 3, "even")).toBeNull();
  });

  it("hints when an address looks wrong for the payout's network, and only then", () => {
    const testnet = `utest1${"q".repeat(104)}`;
    const mainnet = `u1${"q".repeat(104)}`;
    expect(addressHint(testnet, "testnet")).toBeNull();
    expect(addressHint(mainnet, "mainnet")).toBeNull();
    expect(addressHint(mainnet, "testnet")).toBe("This is a mainnet address, and this payout is on testnet.");
    expect(addressHint(testnet, "mainnet")).toBe("This is a testnet address, and this payout is on mainnet.");
    expect(addressHint("tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD", "testnet")).toBe("This address is public. Ask for their private one, starting with utest1.");
    expect(addressHint("hello", "testnet")).toBe("It doesn't start like a Zcash address.");
    expect(addressHint("", "testnet")).toBeNull();
  });

  it("adds up what can be read", () => {
    expect(listTotal([person(A, "1.5"), person(B, ""), person(C, "x")])).toEqual({ total: 150_000_000n, unreadable: 2 });
    expect(formatZec(listTotal([person(A, "0.1"), person(B, "0.2")]).total)).toBe("0.3");
  });
});
