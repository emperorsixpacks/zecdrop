// A quick look at a payout list, so the person sees their rows and a total as soon
// as they paste or drop the file.
//
// This is a PREVIEW, not the importer. The operator reads the same text with the
// real importer (crates/drop-core/src/import.rs) when the person continues, and its
// answer is the one that counts: it checks addresses, amounts, memos, duplicates
// and the rest, and reports each problem by line number. This only splits the text
// into rows the way that importer does (a header row, columns in any order, `,` or
// `;`, quoted fields, BOM, CRLF) so the person can see what they have, and it
// numbers each row by the line its record starts on, the same way the operator does.
//
// The text stays in memory. Nothing here stores or logs it.

import { parseZec, ZecParseError } from "./zec";

export interface PreviewRow {
  /** 1-based line where the record starts, as the operator numbers it. */
  line: number;
  address: string;
  /** The amount as written. */
  amountText: string;
  /** The amount in zatoshi, or null if it is not a plain ZEC amount. */
  amount: bigint | null;
  /** Why the amount cannot be read ("amount has more than 8 decimal places"), or null. Never the text itself. */
  amountProblem: string | null;
  memo: string;
}

export type Preview =
  | { kind: "empty" }
  | { kind: "no_header"; reason: string }
  | {
      kind: "rows";
      rows: PreviewRow[];
      /** The sum of the amounts that could be read. */
      total: bigint;
      /** Rows whose amount could not be read. */
      unreadableAmounts: number;
    };

interface RawRecord {
  line: number;
  fields: string[];
}

const HEADER_HINT = "The first row should name the columns: address, amount and, if you like, memo.";

/** `;` instead of `,` when the header line has more unquoted semicolons than commas. */
function detectDelimiter(text: string): "," | ";" {
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted) {
      if (ch === "\n" || ch === "\r") break;
      if (ch === ",") commas += 1;
      else if (ch === ";") semicolons += 1;
    }
  }
  return semicolons > commas ? ";" : ",";
}

function records(text: string, delimiter: string): RawRecord[] {
  const out: RawRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let startLine = 1;
  let sawContent = false;

  const endField = () => {
    fields.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    if (sawContent || fields.some((f) => f.trim() !== "")) out.push({ line: startLine, fields });
    fields = [];
    sawContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else {
        if (ch === "\n") line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      sawContent = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text.charAt(i + 1) === "\n") i += 1;
      endRecord();
      line += 1;
      startLine = line;
    } else {
      field += ch;
    }
  }
  if (field !== "" || fields.length > 0 || sawContent) endRecord();
  return out;
}

/** Split `text` into rows and add up what can be added. */
export function previewPayouts(text: string): Preview {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (clean.trim() === "") return { kind: "empty" };

  const parsed = records(clean, detectDelimiter(clean));
  const header = parsed[0];
  if (header === undefined) return { kind: "empty" };
  const names = header.fields.map((f) => f.trim().toLowerCase());
  const at = (name: string) => names.indexOf(name);
  const address = at("address");
  const amount = at("amount");
  const memo = at("memo");
  if (address < 0 || amount < 0) return { kind: "no_header", reason: HEADER_HINT };

  const rows: PreviewRow[] = [];
  let total = 0n;
  let unreadableAmounts = 0;
  for (const record of parsed.slice(1)) {
    const amountText = (record.fields[amount] ?? "").trim();
    let zatoshi: bigint | null;
    let amountProblem: string | null = null;
    try {
      zatoshi = parseZec(amountText);
    } catch (error) {
      zatoshi = null;
      amountProblem = error instanceof ZecParseError ? error.message : "amount cannot be read";
    }
    if (zatoshi === null) unreadableAmounts += 1;
    else total += zatoshi;
    rows.push({
      line: record.line,
      address: (record.fields[address] ?? "").trim(),
      amountText,
      amount: zatoshi,
      amountProblem,
      memo: memo >= 0 ? (record.fields[memo] ?? "").trim() : "",
    });
  }
  return { kind: "rows", rows, total, unreadableAmounts };
}
