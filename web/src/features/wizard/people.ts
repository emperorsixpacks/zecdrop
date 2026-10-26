// The payout list a person builds in the page, one person at a time, and the CSV text it becomes (REQ-IMP-002).
//
// The operator's importer (crates/drop-core/src/import.rs, REQ-IMP-001) stays the one gate: this only writes what the
// person typed in the shape that importer reads, the header and then one line per person. A note is kept to one line,
// so person N is always on line N + 1 and a problem the operator reports for a line belongs to one person.
//
// A total is split in whole zatoshi. An even split gives every person exactly the same share and leaves the remainder
// (fewer zatoshi than there are people) out of the total: spreading it would make the shares differ by a zatoshi, which
// silences the review's warning about equal amounts while every share stays as easy to work out from the public total.
// A lucky split draws random shares from the browser's cryptographic random numbers.
//
// The list lives in the wizard's draft, in the page's memory and nowhere else. Nothing here stores or logs it, and no
// sentence built here repeats an address, an amount or a note.

import { classifyAddress } from "@/lib/address-shape";
import { previewPayouts } from "@/lib/csv-preview";
import { MAX_MEMO_BYTES, memoBytes } from "@/lib/memo";
import type { RandomBytes } from "@/lib/random";
import { formatZec, parsePositiveZec, ZecParseError, type ZecErrorCode } from "@/lib/zec";

export interface Person {
  /** Names the person for the page (React keys, focus) while others come and go. Not part of the list. */
  key: string;
  address: string;
  /** The amount as typed, or as a split wrote it. */
  amount: string;
  /** The note they will see in their wallet. */
  memo: string;
}

/** How the amounts are set: one by one, or from a total split evenly or at random. */
export type AmountMode = "each" | "even" | "lucky";

/** The header the importer asks for. */
export const CSV_HEADER = "address,amount,memo";

let lastKey = 0;

/** A person with nothing filled in yet. */
export function blankPerson(): Person {
  lastKey += 1;
  return { key: `person-${String(lastKey)}`, address: "", amount: "", memo: "" };
}

/** The people of a list written as CSV text (the practice example), amounts and notes as written. */
export function peopleFromCsv(text: string): Person[] {
  const preview = previewPayouts(text);
  return preview.kind === "rows" ? preview.rows.map((row) => ({ ...blankPerson(), address: row.address, amount: row.amountText, memo: row.memo })) : [];
}

/** The line of the CSV text that holds the person at `index` (0-based); the header is line 1. */
export const lineOf = (index: number): number => index + 2;

// ---- the text the operator imports ---------------------------------------------------------

/** A field as RFC 4180 writes it: quoted when it holds a quote, a comma or a line break, its quotes doubled. */
function field(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** The note as it is sent: on one line, with no space at either end. */
export function cleanMemo(memo: string): string {
  return memo.replace(/[\r\n]+/gu, " ").trim();
}

/** The amount as the importer reads it best: what `formatZec` writes, its parser's inverse. One that cannot be read
 * is sent as typed, so the operator names the problem on that person's line. */
function amountField(text: string): string {
  const trimmed = text.trim();
  try {
    return formatZec(parsePositiveZec(trimmed));
  } catch {
    return trimmed;
  }
}

/** The list as the text the operator imports: the header, then one line per person, in order. */
export function composeCsv(people: readonly Person[]): string {
  const lines = [CSV_HEADER];
  for (const person of people) lines.push([person.address.trim(), amountField(person.amount), cleanMemo(person.memo)].map(field).join(","));
  return `${lines.join("\n")}\n`;
}

// ---- splitting a total ---------------------------------------------------------------------

/** Every person's share when `total` is split evenly: exactly equal, the remainder left out. Empty when there is
 * nobody, or when the total is less than one zatoshi each. */
export function splitEvenly(total: bigint, people: number): bigint[] {
  if (people <= 0 || total <= 0n) return [];
  const share = total / BigInt(people);
  return share === 0n ? [] : Array.from({ length: people }, () => share);
}

/** Random shares of `total`. They add up to it exactly, none is less than half of an even share, and for two people
 * or more they are never all equal. Empty when the total is too small to share that way. */
export function luckySplit(total: bigint, people: number, random: RandomBytes): bigint[] {
  if (people <= 0 || total <= 0n) return [];
  if (people === 1) return [total];
  const n = BigInt(people);
  const least = total / n / 2n;
  if (least === 0n) return [];

  // Each person gets the least, and the rest is shared in proportion to a random weight of 32 bits (never zero).
  const bytes = random(people * 4);
  const weights = Array.from({ length: people }, (_, i) => {
    const at = i * 4;
    return ((BigInt(bytes[at] ?? 0) << 24n) | (BigInt(bytes[at + 1] ?? 0) << 16n) | (BigInt(bytes[at + 2] ?? 0) << 8n) | BigInt(bytes[at + 3] ?? 0)) + 1n;
  });
  const weight = weights.reduce((sum, w) => sum + w, 0n);
  const rest = total - least * n;
  const shares = weights.map((w) => least + (rest * w) / weight);
  // What the rounding down left over is less than one zatoshi each: one more to the first people.
  let left = total - shares.reduce((sum, s) => sum + s, 0n);
  for (let i = 0; left > 0n; i += 1, left -= 1n) shares[i % people] = (shares[i % people] ?? 0n) + 1n;
  // All equal is as guessable as an even split. Only a total of a few zatoshi can come out so; move one zatoshi.
  // (Equal shares are each more than the least, so the first can give one.)
  if (shares.every((s) => s === shares[0])) {
    shares[0] = (shares[0] ?? 0n) - 1n;
    shares[1] = (shares[1] ?? 0n) + 1n;
  }
  return shares;
}

/** The people with the amounts a split of `totalText` gives them. In "each" mode they are as they are; a total that
 * cannot be read, or cannot be split, leaves every amount empty. */
export function applySplit(people: readonly Person[], mode: AmountMode, totalText: string, random: RandomBytes): Person[] {
  if (mode === "each") return [...people];
  let total: bigint;
  try {
    total = parsePositiveZec(totalText.trim());
  } catch {
    return people.map((person) => ({ ...person, amount: "" }));
  }
  const shares = mode === "even" ? splitEvenly(total, people.length) : luckySplit(total, people.length, random);
  return people.map((person, i) => {
    const share = shares[i];
    return { ...person, amount: share === undefined ? "" : formatZec(share) };
  });
}

// ---- what is wrong with a row --------------------------------------------------------------

const AMOUNT_TEXT: Partial<Record<ZecErrorCode, string>> = {
  empty: "Add an amount.",
  zero: "The amount must be more than 0.",
  negative: "The amount can't be negative.",
  too_many_decimals: "Use at most 8 decimal places.",
  separator: "Write it with a dot, like 0.5, and no spaces.",
  over_max_money: "That is more than all the ZEC there will ever be.",
};
const AMOUNT_UNREADABLE = "Write it as a number, like 0.5.";

/** Why an amount (or a total) cannot be used, in one sentence, or null. Never repeats the amount. */
export function amountProblem(text: string): string | null {
  try {
    parsePositiveZec(text.trim());
    return null;
  } catch (error) {
    return (error instanceof ZecParseError ? AMOUNT_TEXT[error.code] : undefined) ?? AMOUNT_UNREADABLE;
  }
}

export interface PersonProblems {
  address: string | null;
  amount: string | null;
  memo: string | null;
}

/** What stops the person at `index` from being sent, field by field. The amount is checked only when it is typed
 * ("each"); a split's amounts follow from the total, which is checked on its own. */
export function personProblems(people: readonly Person[], index: number, mode: AmountMode): PersonProblems {
  const person = people[index];
  if (person === undefined) return { address: null, amount: null, memo: null };
  const address = person.address.trim();
  let addressProblem: string | null = null;
  if (address === "") addressProblem = "Add their address.";
  else {
    const same = people.findIndex((other) => other.address.trim().toLowerCase() === address.toLowerCase());
    if (same >= 0 && same < index) addressProblem = `The same address as person ${String(same + 1)}.`;
  }
  const bytes = memoBytes(cleanMemo(person.memo));
  return {
    address: addressProblem,
    amount: mode === "each" ? amountProblem(person.amount) : null,
    memo: bytes > MAX_MEMO_BYTES ? `The note is too long: ${String(bytes)} of ${String(MAX_MEMO_BYTES)} bytes.` : null,
  };
}

/** Why a total cannot be split between `people`, or null. */
export function totalProblem(text: string, people: number, mode: Exclude<AmountMode, "each">): string | null {
  if (text.trim() === "") return "Type the total to split.";
  const unreadable = amountProblem(text);
  if (unreadable !== null) return unreadable;
  if (people <= 0) return null;
  // The same limits as the splits: an even share of at least a zatoshi, a random one of at least half that.
  const share = parsePositiveZec(text.trim()) / BigInt(people);
  const tooSmall = mode === "even" ? share === 0n : people > 1 && share / 2n === 0n;
  return tooSmall ? "That total is too small to split between them." : null;
}

/** A word about how an address looks, when it looks wrong for a payout on `network`. A hint, not a gate: the operator
 * decodes the address and its answer is the one that counts. */
export function addressHint(text: string, network: "testnet" | "mainnet" | null): string | null {
  const shape = classifyAddress(text);
  const start = network === "testnet" ? "utest1" : "u1";
  switch (shape.kind) {
    case "empty":
      return null;
    case "mainnet_unified":
      return network === "testnet" ? "This is a mainnet address, and this payout is on testnet." : null;
    case "testnet_unified":
      return network === "mainnet" ? "This is a testnet address, and this payout is on mainnet." : null;
    case "transparent":
      return `This address is public. Ask for their private one, starting with ${start}.`;
    case "sapling":
      return `This is an older kind of address. Ask for one starting with ${start}.`;
    case "unrecognised":
      switch (shape.why) {
        case "inside_space":
          return "It has a space or a line break inside. Copy it again.";
        case "mixed_case":
          return "It mixes capital and small letters. Copy it again.";
        case "characters":
          return "It has a character no address uses. Copy it again.";
        case "length":
          return "It looks too short or too long. Copy the whole address.";
        default:
          return "It doesn't start like a Zcash address.";
      }
  }
}

/** The sum of the amounts that can be read, and how many cannot. */
export function listTotal(people: readonly Person[]): { total: bigint; unreadable: number } {
  let total = 0n;
  let unreadable = 0;
  for (const person of people) {
    try {
      total += parsePositiveZec(person.amount.trim());
    } catch {
      unreadable += 1;
    }
  }
  return { total, unreadable };
}
