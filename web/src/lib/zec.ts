// ZEC money in bigint zatoshi. There is deliberately no float anywhere here.
//
// Two entry points parse text:
//   parseZec      what a person types ("1.5")   -> zatoshi
//   parseZatoshi  what the API sends ("150000000") -> zatoshi
// and one formats: formatZec, the exact inverse of parseZec.
//
// Parsing is a strict scan, not a lenient coercion. Anything that is not a
// canonical decimal is refused with a stable error CODE. Errors never carry
// the offending text: amounts must not leak into logs or UI error banners.

export const ZATOSHI_PER_ZEC = 100_000_000n;
export const FRACTION_DIGITS = 8;
/** Whole-ZEC cap: the total supply. Anything above is a typo or an attack. */
export const MAX_MONEY_ZEC = 21_000_000n;
export const MAX_MONEY = MAX_MONEY_ZEC * ZATOSHI_PER_ZEC;
export const U64_MAX = (1n << 64n) - 1n;

export type ZecErrorCode =
  | "not_a_string"
  | "empty"
  | "negative"
  | "exponent"
  | "separator"
  | "bad_format"
  | "too_many_decimals"
  | "over_max_money"
  | "zero"
  | "bad_zatoshi"
  | "u64_overflow";

const MESSAGES: Record<ZecErrorCode, string> = {
  not_a_string: "amount must be text",
  empty: "amount is empty",
  negative: "amount must not be negative",
  exponent: "exponent notation is not allowed",
  separator: "separators and whitespace are not allowed",
  bad_format: "amount is not a plain decimal number",
  too_many_decimals: `at most ${String(FRACTION_DIGITS)} decimal places are allowed`,
  over_max_money: "amount exceeds the total ZEC supply",
  zero: "amount must be greater than zero",
  bad_zatoshi: "zatoshi amount is not a plain whole number",
  u64_overflow: "zatoshi amount does not fit in 64 bits",
};

export class ZecParseError extends Error {
  override readonly name = "ZecParseError";
  readonly code: ZecErrorCode;

  constructor(code: ZecErrorCode) {
    super(MESSAGES[code]);
    this.code = code;
  }
}

function fail(code: ZecErrorCode): never {
  throw new ZecParseError(code);
}

/** True for a non-empty string made only of ASCII 0-9. */
function isAsciiDigits(text: string): boolean {
  if (text.length === 0) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

/** Digits with no redundant leading zero: "0", "7", "10", never "07". */
function isCanonicalWhole(text: string): boolean {
  return isAsciiDigits(text) && (text === "0" || !text.startsWith("0"));
}

/** Parse a typed ZEC amount such as "1.5" into zatoshi. Zero is allowed; use
 * {@link parsePositiveZec} for a payout. */
export function parseZec(input: string): bigint {
  if (typeof input !== "string") return fail("not_a_string");
  if (input.length === 0) return fail("empty");
  if (input.startsWith("-")) return fail("negative");
  if (input.includes("e") || input.includes("E")) return fail("exponent");
  if (/[\s,_']/u.test(input)) return fail("separator");

  const parts = input.split(".");
  if (parts.length > 2) return fail("bad_format");
  const whole = parts[0] ?? "";
  const fraction = parts[1];

  if (!isCanonicalWhole(whole)) return fail("bad_format");
  // The cap is 8 digits wide; refuse longer before building a huge BigInt.
  if (whole.length > String(MAX_MONEY_ZEC).length) return fail("over_max_money");

  if (fraction !== undefined) {
    if (!isAsciiDigits(fraction)) return fail("bad_format"); // "5." and "5.x"
    if (fraction.length > FRACTION_DIGITS) return fail("too_many_decimals");
  }

  const zatoshi =
    BigInt(whole) * ZATOSHI_PER_ZEC +
    BigInt((fraction ?? "").padEnd(FRACTION_DIGITS, "0"));
  if (zatoshi > MAX_MONEY) return fail("over_max_money");
  return zatoshi;
}

/** {@link parseZec} that also refuses zero. */
export function parsePositiveZec(input: string): bigint {
  const zatoshi = parseZec(input);
  if (zatoshi === 0n) return fail("zero");
  return zatoshi;
}

/** Exact inverse of {@link parseZec}: "1.5", never "1.50000000".
 *
 * Accepts any non-negative bigint, including values above the supply cap, so
 * rendering already-validated data can never throw and blank a page. */
export function formatZec(zatoshi: bigint): string {
  if (typeof zatoshi !== "bigint") throw new TypeError("zatoshi must be a bigint");
  if (zatoshi < 0n) throw new RangeError("zatoshi must not be negative");

  // Left-pad so there is always at least one whole digit, then split at the
  // decimal point that sits 8 digits from the right.
  const digits = zatoshi.toString().padStart(FRACTION_DIGITS + 1, "0");
  const whole = digits.slice(0, -FRACTION_DIGITS);
  const fraction = digits.slice(-FRACTION_DIGITS).replace(/0+$/u, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

/** Parse a zatoshi amount sent as a decimal string (the API wire format). */
export function parseZatoshi(input: string): bigint {
  if (typeof input !== "string" || !isCanonicalWhole(input)) {
    return fail("bad_zatoshi");
  }
  // u64 max has 20 digits; refuse anything longer before parsing.
  if (input.length > String(U64_MAX).length) return fail("u64_overflow");
  const value = BigInt(input);
  if (value > U64_MAX) return fail("u64_overflow");
  return value;
}

/** Like {@link parseZatoshi}, but also refuses more than the total supply.
 * This is the rule the Rust core applies to every amount it deserializes, so
 * an API value above it is malformed rather than merely large. */
export function parseMoneyZatoshi(input: string): bigint {
  const value = parseZatoshi(input);
  if (value > MAX_MONEY) return fail("over_max_money");
  return value;
}

/** Boolean form of {@link parseZatoshi}, for schema refinements. */
export function isZatoshiString(input: string): boolean {
  try {
    parseZatoshi(input);
    return true;
  } catch {
    return false;
  }
}

/** Boolean form of {@link parseMoneyZatoshi}. */
export function isMoneyZatoshiString(input: string): boolean {
  try {
    parseMoneyZatoshi(input);
    return true;
  } catch {
    return false;
  }
}

/** A wire amount (decimal zatoshi string) as ZEC text, e.g. "534500000" ->
 * "5.345". Throws on anything that is not a valid amount, so a bad value can
 * never be shown as if it were good. */
export function zecFromZatoshi(zatoshi: string): string {
  return formatZec(parseMoneyZatoshi(zatoshi));
}
