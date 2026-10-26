// The operator's CSV importer, for tests of what the page writes (the people list): a port of crates/drop-core/src/import.rs
// with the address check of crates/drop-operator/src/codec.rs, which looks at the SHAPE of an address and nothing else (no
// checksum, no network). A list is answered line by line as the operator answers it, with the operator's own sentences, and
// csv-import.test.ts compares the answers with the ones the real operator gave (fixtures/contract/operator).
//
// No error holds the text that was wrong: a line number, a kind, and static words.

export const MAX_MEMO_BYTES = 512;
export const MAX_ADDRESS_BYTES = 1_024;
/** 21,000,000 ZEC in zatoshi. */
export const MAX_MONEY = 21_000_000n * 100_000_000n;
/** The most the operator reports of a bad list, however many problems it has. */
export const MAX_REPORTED_ROW_ERRORS = 200;

export type AmountReason =
  | { code: "empty" }
  | { code: "negative" }
  | { code: "scientific_notation" }
  | { code: "invalid_character" }
  | { code: "malformed_decimal" }
  | { code: "too_many_decimals" }
  | { code: "exceeds_max_money" };

export type AddressReason =
  | { code: "empty" }
  | { code: "malformed"; reason: string }
  | { code: "wrong_network" }
  | { code: "unsupported_receiver" }
  | { code: "transparent_not_allowed" };

export type ColumnName = "address" | "amount" | "memo";

export type RowErrorKind =
  | { code: "missing_header" }
  | { code: "unknown_column"; position: number }
  | { code: "duplicate_column"; name: ColumnName }
  | { code: "missing_column"; name: ColumnName }
  | { code: "field_count"; expected: number; found: number }
  | { code: "unterminated_quote" }
  | { code: "malformed_quote" }
  | { code: "missing_address" }
  | { code: "invalid_address"; reason: AddressReason }
  | { code: "invalid_amount"; reason: AmountReason }
  | { code: "zero_amount" }
  | { code: "memo_too_long"; bytes: number; max: number }
  | { code: "duplicate_address"; first_line: number };

/** A problem with one line, as the operator sends it: `{line, kind, message}`. */
export interface RowError {
  line: number;
  kind: RowErrorKind;
  message: string;
}

export interface PayoutRow {
  address: string;
  /** Zatoshi. */
  amount: bigint;
  memo: string | null;
}

export interface ImportReport {
  rows: PayoutRow[];
  errors: RowError[];
}

// ---- the operator's sentences (Display of the Rust error types) -----------------------------

const AMOUNT_TEXT: Record<AmountReason["code"], string> = {
  empty: "amount is empty",
  negative: "amount must not be negative",
  scientific_notation: "scientific notation is not allowed; write the amount as a plain decimal",
  invalid_character: "amount may contain only digits and one decimal point (no spaces, signs or separators)",
  malformed_decimal: "amount must look like 1 or 0.5, with digits on both sides of the decimal point",
  too_many_decimals: "amount has more than 8 decimal places",
  exceeds_max_money: "amount exceeds the maximum possible supply of 21,000,000 ZEC",
};

function addressText(reason: AddressReason): string {
  switch (reason.code) {
    case "empty":
      return "address is empty";
    case "malformed":
      return `address is not valid: ${reason.reason}`;
    case "wrong_network":
      return "address is for a different network";
    case "unsupported_receiver":
      return "address has no receiver that can be paid";
    case "transparent_not_allowed":
      return "transparent addresses are not allowed; use a shielded or unified address";
  }
}

function messageOf(kind: RowErrorKind): string {
  switch (kind.code) {
    case "missing_header":
      return "the first row must be a header such as: address,amount,memo";
    case "unknown_column":
      return `unknown column in header at position ${String(kind.position)}; expected address, amount, memo`;
    case "duplicate_column":
      return `column \`${kind.name}\` appears more than once in the header`;
    case "missing_column":
      return `the header has no \`${kind.name}\` column`;
    case "field_count":
      return `expected ${String(kind.expected)} columns but found ${String(kind.found)}`;
    case "unterminated_quote":
      return "a quoted field is never closed; the rest of the file would be swallowed";
    case "malformed_quote":
      return "misplaced quote character; quote the whole field and double any inner quotes";
    case "missing_address":
      return "address is empty";
    case "invalid_address":
      return addressText(kind.reason);
    case "invalid_amount":
      return AMOUNT_TEXT[kind.reason.code];
    case "zero_amount":
      return "amount must be greater than zero";
    case "memo_too_long":
      return `memo is ${String(kind.bytes)} bytes; the limit is ${String(kind.max)} bytes`;
    case "duplicate_address":
      return `this address already appears on line ${String(kind.first_line)}`;
  }
}

const rowError = (line: number, kind: RowErrorKind): RowError => ({ line, kind, message: messageOf(kind) });

// ---- amounts ----------------------------------------------------------------------------------

const isDigit = (code: number): boolean => code >= 48 && code <= 57;

/** `Zatoshi::parse_zec`: plain decimal ZEC, at most eight decimals, at most the supply. Zero is accepted here. */
function parseAmount(text: string): { zatoshi: bigint } | { reason: AmountReason } {
  const fail = (code: AmountReason["code"]): { reason: AmountReason } => ({ reason: { code } });
  if (text.trim() === "") return fail("empty");
  if (text.startsWith("-")) return fail("negative");
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (isDigit(code) || code === 46) continue;
    if ((code === 101 || code === 69) && at > 0 && isDigit(text.charCodeAt(at - 1))) return fail("scientific_notation");
    return fail("invalid_character");
  }
  const dot = text.indexOf(".");
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? null : text.slice(dot + 1);
  if (whole === "") return fail("malformed_decimal");
  if (fraction !== null) {
    if (fraction === "" || fraction.includes(".")) return fail("malformed_decimal");
    if (fraction.length > 8) return fail("too_many_decimals");
  }
  if (BigInt(whole) > MAX_MONEY / 100_000_000n) return fail("exceeds_max_money");
  const zatoshi = BigInt(whole) * 100_000_000n + BigInt((fraction ?? "").padEnd(8, "0") || "0");
  return zatoshi > MAX_MONEY ? fail("exceeds_max_money") : { zatoshi };
}

// ---- addresses: the shape only, as the mock chain's codec looks -----------------------------------

type Receiver = "unified" | "shielded" | "transparent";

function receiverOf(address: string): Receiver | { reason: AddressReason } {
  if (address === "") return { reason: { code: "empty" } };
  if (!/^[A-Za-z0-9]+$/u.test(address)) return { reason: { code: "malformed", reason: "unexpected character" } };
  switch (address.charAt(0).toLowerCase()) {
    case "u":
      return "unified";
    case "z":
      return "shielded";
    case "t":
      return "transparent";
    default:
      return { reason: { code: "malformed", reason: "unknown address prefix" } };
  }
}

/** Two spellings of one address are one: the bech32 kinds (unified, shielded) ignore case, base58 transparent ones do not. */
function canonical(address: string): string {
  const first = address.charAt(0).toLowerCase();
  return first === "u" || first === "z" ? address.toLowerCase() : address;
}

// ---- reading the text ---------------------------------------------------------------------------------

type QuoteIssue = "unterminated" | "malformed";

interface CsvRecord {
  line: number;
  fields: string[];
  issue: QuoteIssue | null;
}

/** `;` rather than `,` when the header line has more unquoted semicolons than commas. */
function detectDelimiter(input: string): string {
  const header = input.replace(/^[\n\r]+/u, "").split(/[\n\r]/u)[0] ?? "";
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (const character of header) {
    if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) commas += 1;
    else if (character === ";" && !quoted) semicolons += 1;
  }
  return semicolons > commas ? ";" : ",";
}

/** A strict RFC 4180 reader: wholly empty lines are skipped, nothing else is, and a quote that never closes or sits where it
 * must not is reported instead of swallowing the rest of the file. */
function tokenize(input: string, delimiter: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let at = 0;
  let line = 1;

  const eatNewline = (): boolean => {
    const character = input.charAt(at);
    if (character === "\n") at += 1;
    else if (character === "\r") {
      at += 1;
      if (input.charAt(at) === "\n") at += 1;
    } else return false;
    line += 1;
    return true;
  };
  const atCellEnd = (character: string): boolean => character === delimiter || character === "\n" || character === "\r";

  for (;;) {
    if (eatNewline()) continue;
    if (at >= input.length) break;

    const startLine = line;
    const fields: string[] = [];
    let issue: QuoteIssue | null = null;

    for (;;) {
      let field = "";
      if (input.charAt(at) === '"') {
        at += 1;
        let closed = false;
        while (at < input.length) {
          const character = input.charAt(at);
          at += 1;
          if (character === '"') {
            if (input.charAt(at) === '"') {
              at += 1;
              field += '"';
              continue;
            }
            closed = true;
            break;
          }
          if (character === "\n") {
            line += 1;
            field += "\n";
          } else if (character === "\r") {
            if (input.charAt(at) === "\n") {
              at += 1;
              field += "\r\n";
            } else field += "\r";
            line += 1;
          } else field += character;
        }
        if (!closed) issue = "unterminated";
        else if (at < input.length && !atCellEnd(input.charAt(at))) {
          // Text after the closing quote: flag it and skip to the end of the cell.
          issue ??= "malformed";
          while (at < input.length && !atCellEnd(input.charAt(at))) at += 1;
        }
      } else {
        while (at < input.length && !atCellEnd(input.charAt(at))) {
          const character = input.charAt(at);
          if (character === '"') issue ??= "malformed";
          field += character;
          at += 1;
        }
      }
      fields.push(field);
      if (input.charAt(at) === delimiter) {
        at += 1;
        continue;
      }
      break;
    }

    eatNewline();
    records.push({ line: startLine, fields, issue });
  }
  return records;
}

const quoteError = (issue: QuoteIssue): RowErrorKind => ({ code: issue === "unterminated" ? "unterminated_quote" : "malformed_quote" });

interface Columns {
  address: number;
  amount: number;
  memo: number | null;
  width: number;
}

function readHeader(record: CsvRecord): Columns | RowError[] {
  const error = (kind: RowErrorKind): RowError => rowError(record.line, kind);
  if (record.issue !== null) return [error(quoteError(record.issue))];

  let address: number | null = null;
  let amount: number | null = null;
  let memo: number | null = null;
  const errors: RowError[] = [];
  let recognised = 0;

  for (const [index, cell] of record.fields.entries()) {
    const name = cell.trim().toLowerCase();
    if (name !== "address" && name !== "amount" && name !== "memo") {
      errors.push(error({ code: "unknown_column", position: index + 1 }));
      continue;
    }
    recognised += 1;
    const taken = name === "address" ? address : name === "amount" ? amount : memo;
    if (taken !== null) {
      errors.push(error({ code: "duplicate_column", name }));
    } else if (name === "address") address = index;
    else if (name === "amount") amount = index;
    else memo = index;
  }

  if (recognised === 0) return [error({ code: "missing_header" })];
  if (address === null) errors.push(error({ code: "missing_column", name: "address" }));
  if (amount === null) errors.push(error({ code: "missing_column", name: "amount" }));
  if (address === null || amount === null || errors.length > 0) return errors;
  return { address, amount, memo, width: record.fields.length };
}

/** Read a payout list. Every problem comes back with its line; nothing is skipped or cut short silently, and `rows` holds only
 * what read cleanly, so it is for a list with no `errors` and for nothing else. */
export function importCsv(text: string): ImportReport {
  const input = text.startsWith("﻿") ? text.slice(1) : text;
  const records = tokenize(input, detectDelimiter(input));
  const report: ImportReport = { rows: [], errors: [] };

  const [first, ...rest] = records;
  if (first === undefined) return { rows: [], errors: [rowError(1, { code: "missing_header" })] };
  const columns = readHeader(first);
  if (Array.isArray(columns)) return { rows: [], errors: columns };

  const seen = new Map<string, number>();
  for (const record of rest) {
    const line = record.line;
    const before = report.errors.length;
    const fail = (kind: RowErrorKind) => {
      report.errors.push(rowError(line, kind));
    };

    if (record.issue !== null) {
      fail(quoteError(record.issue));
      continue;
    }
    if (record.fields.length !== columns.width) {
      fail({ code: "field_count", expected: columns.width, found: record.fields.length });
      continue;
    }
    const cell = (index: number): string => record.fields[index] ?? "";

    // The address, then a duplicate check that runs for any valid address even when another cell on the row is bad,
    // so that one pass of fixing is enough.
    const address = cell(columns.address).trim();
    let addressOk = false;
    if (address === "") fail({ code: "missing_address" });
    else {
      const receiver = receiverOf(address);
      if (typeof receiver === "object") fail({ code: "invalid_address", reason: receiver.reason });
      else if (receiver === "transparent") fail({ code: "invalid_address", reason: { code: "transparent_not_allowed" } });
      else addressOk = true;
    }
    if (addressOk) {
      const key = canonical(address);
      const earlier = seen.get(key);
      if (earlier === undefined) seen.set(key, line);
      else fail({ code: "duplicate_address", first_line: earlier });
    }

    // The amount.
    const parsed = parseAmount(cell(columns.amount).trim());
    let amount: bigint | null = null;
    if ("reason" in parsed) fail({ code: "invalid_amount", reason: parsed.reason });
    else if (parsed.zatoshi === 0n) fail({ code: "zero_amount" });
    else amount = parsed.zatoshi;

    // The memo, which is left as written (an empty one is none).
    const memoText = columns.memo === null ? "" : cell(columns.memo);
    const memo = memoText === "" ? null : memoText;
    let memoOk = true;
    if (memo !== null) {
      const bytes = new TextEncoder().encode(memo).length;
      if (bytes > MAX_MEMO_BYTES) {
        memoOk = false;
        fail({ code: "memo_too_long", bytes, max: MAX_MEMO_BYTES });
      }
    }

    if (report.errors.length !== before || !addressOk || !memoOk || amount === null) continue;
    if (new TextEncoder().encode(address).length > MAX_ADDRESS_BYTES) {
      fail({ code: "invalid_address", reason: { code: "malformed", reason: "address is too long" } });
      continue;
    }
    report.rows.push({ address, amount, memo });
  }
  return report;
}
