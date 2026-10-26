import { describe, expect, it } from "vitest";

import {
  formatZec,
  isMoneyZatoshiString,
  isZatoshiString,
  MAX_MONEY,
  parseMoneyZatoshi,
  parsePositiveZec,
  parseZatoshi,
  parseZec,
  U64_MAX,
  zecFromZatoshi,
  ZecParseError,
  type ZecErrorCode,
} from "./zec";

/** Run `fn`, require it to throw a ZecParseError, and return its code. */
function codeOf(fn: () => unknown): ZecErrorCode {
  try {
    fn();
  } catch (e) {
    if (e instanceof ZecParseError) return e.code;
    throw e;
  }
  throw new Error("expected a ZecParseError, but nothing was thrown");
}

describe("parseZec: accepted input", () => {
  const accepted: [text: string, zatoshi: bigint][] = [
    ["0", 0n],
    ["1", 100_000_000n],
    ["1.5", 150_000_000n],
    ["0.1", 10_000_000n],
    ["0.3", 30_000_000n],
    ["0.30000000", 30_000_000n],
    ["0.00000001", 1n],
    ["123.45678901", 12_345_678_901n],
    ["19999999.99999999", 1_999_999_999_999_999n],
    ["21000000", MAX_MONEY],
    ["21000000.00000000", MAX_MONEY],
  ];

  it.each(accepted)("%s", (text, zatoshi) => {
    expect(parseZec(text)).toBe(zatoshi);
  });
});

describe("parseZec: rejected input, by error code", () => {
  const rejected: [label: string, text: string, code: ZecErrorCode][] = [
    ["empty string", "", "empty"],

    ["minus sign", "-1", "negative"],
    ["negative zero", "-0", "negative"],
    ["negative fraction", "-0.5", "negative"],

    ["lowercase exponent", "1e3", "exponent"],
    ["uppercase negative exponent", "1E-8", "exponent"],
    ["zero exponent", "5e0", "exponent"],

    ["nine decimals", "0.123456789", "too_many_decimals"],
    ["nine zero decimals", "1.000000000", "too_many_decimals"],
    ["eleven decimals", "1.00000000000", "too_many_decimals"],

    ["thousands comma", "1,000", "separator"],
    ["decimal comma", "1,5", "separator"],
    ["underscore", "1_000", "separator"],
    ["apostrophe", "1'000", "separator"],
    ["inner space", "1 000", "separator"],
    ["leading space", " 1", "separator"],
    ["trailing space", "1 ", "separator"],
    ["trailing newline", "1\n", "separator"],
    ["tab", "\t1", "separator"],
    ["no-break space", "1 000", "separator"],

    ["over the cap by one zatoshi", "21000000.00000001", "over_max_money"],
    ["over the cap by one ZEC", "21000001", "over_max_money"],
    ["twenty digits", "99999999999999999999", "over_max_money"],

    ["leading plus", "+1", "bad_format"],
    ["bare fraction", ".5", "bad_format"],
    ["trailing dot", "5.", "bad_format"],
    ["lone dot", ".", "bad_format"],
    ["two dots", "1..5", "bad_format"],
    ["three parts", "1.2.3", "bad_format"],
    ["leading zeros", "007", "bad_format"],
    ["leading zeros before dot", "00.5", "bad_format"],
    ["hex", "0x10", "bad_format"],
    ["word", "abc", "bad_format"],
    ["NaN", "NaN", "bad_format"],
    ["Infinity", "Infinity", "bad_format"],
    ["Arabic-Indic digit", "١", "bad_format"],
    ["full-width digit", "１", "bad_format"],
    ["letters in fraction", "1.5x", "bad_format"],
  ];

  it.each(rejected)("%s", (_label, text, code) => {
    expect(codeOf(() => parseZec(text))).toBe(code);
  });

  it.each([1, null, undefined, {}, 1n])("non-string %o", (value) => {
    expect(codeOf(() => parseZec(value as string))).toBe(
      "not_a_string",
    );
  });
});

describe("parsePositiveZec", () => {
  it("accepts the smallest amount", () => {
    expect(parsePositiveZec("0.00000001")).toBe(1n);
  });

  it.each(["0", "0.0", "0.00000000"])("rejects zero as %s", (text) => {
    expect(codeOf(() => parsePositiveZec(text))).toBe("zero");
  });

  it("still reports other errors by their own code", () => {
    expect(codeOf(() => parsePositiveZec("-1"))).toBe("negative");
  });
});

describe("formatZec", () => {
  const cases: [zatoshi: bigint, text: string][] = [
    [0n, "0"],
    [1n, "0.00000001"],
    [10_000_000n, "0.1"],
    [99_999_999n, "0.99999999"],
    [100_000_000n, "1"],
    [150_000_000n, "1.5"],
    [12_345_678_901n, "123.45678901"],
    [MAX_MONEY, "21000000"],
  ];

  it.each(cases)("%s zatoshi -> %s", (zatoshi, text) => {
    expect(formatZec(zatoshi)).toBe(text);
  });

  it("refuses negatives and non-bigints", () => {
    expect(() => formatZec(-1n)).toThrow(RangeError);
    expect(() => formatZec(1 as unknown as bigint)).toThrow(TypeError);
  });

  it("renders above the supply cap instead of throwing", () => {
    expect(formatZec(MAX_MONEY + 1n)).toBe("21000000.00000001");
    expect(formatZec(U64_MAX)).toBe("184467440737.09551615");
  });
});

describe("parseZec and formatZec are inverses", () => {
  it("format(parse(s)) is the canonical form of s", () => {
    const pairs: [typed: string, canonical: string][] = [
      ["1.50000000", "1.5"],
      ["2.0", "2"],
      ["0.10", "0.1"],
      ["0", "0"],
      ["20999999.99999999", "20999999.99999999"],
    ];
    for (const [typed, canonical] of pairs) {
      expect(formatZec(parseZec(typed))).toBe(canonical);
    }
  });

  it("parse(format(z)) === z across the whole range", () => {
    // xorshift64*, seeded: deterministic, no Math.random, bigint only.
    let state = 0x9e3779b97f4a7c15n;
    const next = (): bigint => {
      state ^= state >> 12n;
      state ^= (state << 25n) & U64_MAX;
      state ^= state >> 27n;
      return (state * 0x2545f4914f6cdd1dn) & U64_MAX;
    };

    const edges = [0n, 1n, 99_999_999n, 100_000_000n, MAX_MONEY - 1n, MAX_MONEY];
    const samples = [...edges];
    for (let i = 0; i < 2_000; i++) samples.push(next() % (MAX_MONEY + 1n));

    for (const z of samples) {
      const text = formatZec(z);
      expect(text).toMatch(/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/); // canonical
      expect(parseZec(text)).toBe(z);
    }
  });
});

describe("parseZatoshi (API wire format)", () => {
  it.each<[string, bigint]>([
    ["0", 0n],
    ["12345", 12345n],
    ["18446744073709551615", U64_MAX],
  ])("accepts %s", (text, value) => {
    expect(parseZatoshi(text)).toBe(value);
  });

  it.each(["-1", "+1", "1.0", "1e3", " 1", "1 ", "01", "", "0x1", "1,000"])(
    "rejects %j as not a plain whole number",
    (text) => {
      expect(codeOf(() => parseZatoshi(text))).toBe("bad_zatoshi");
    },
  );

  it.each(["18446744073709551616", "99999999999999999999999"])(
    "rejects %s as overflowing u64",
    (text) => {
      expect(codeOf(() => parseZatoshi(text))).toBe("u64_overflow");
    },
  );

  it("isZatoshiString agrees", () => {
    expect(isZatoshiString("100")).toBe(true);
    expect(isZatoshiString("-100")).toBe(false);
    expect(isZatoshiString("18446744073709551616")).toBe(false);
  });
});

describe("parseMoneyZatoshi (wire amounts, capped at the supply)", () => {
  it("accepts zero and exactly the cap", () => {
    expect(parseMoneyZatoshi("0")).toBe(0n);
    expect(parseMoneyZatoshi(MAX_MONEY.toString())).toBe(MAX_MONEY);
  });

  it("rejects one zatoshi over the cap, even though it fits in u64", () => {
    const over = (MAX_MONEY + 1n).toString();
    expect(codeOf(() => parseMoneyZatoshi(over))).toBe("over_max_money");
    expect(codeOf(() => parseMoneyZatoshi(U64_MAX.toString()))).toBe("over_max_money");
    expect(isMoneyZatoshiString(over)).toBe(false);
    expect(isZatoshiString(over)).toBe(true); // plain u64 still allows it
  });

  it("keeps the plain-number rules", () => {
    expect(codeOf(() => parseMoneyZatoshi("-1"))).toBe("bad_zatoshi");
    expect(codeOf(() => parseMoneyZatoshi("1.5"))).toBe("bad_zatoshi");
    expect(codeOf(() => parseMoneyZatoshi("18446744073709551616"))).toBe("u64_overflow");
    expect(isMoneyZatoshiString("12345")).toBe(true);
  });
});

// covers: REQ-PRIV-002
describe("errors never carry the rejected text", () => {
  // Each input holds a distinctive digit run that would appear in the message
  // if anything interpolated it.
  const inputs = [
    "7391.2x",
    "-7391.5",
    "7391e2",
    "7391,50",
    "7391 50",
    "739100000000.5",
    "0.739100001",
    ".7391",
    "7391.",
    "0x7391",
  ];

  it.each(inputs)("parseZec(%j)", (text) => {
    let error: unknown;
    try {
      parseZec(text);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ZecParseError);
    // Message and every enumerable field (the stack is left out on purpose:
    // file paths and line numbers could contain digits by coincidence).
    const dump = `${(error as Error).message} ${JSON.stringify(error)}`;
    expect(dump).not.toContain("7391");
  });

  it("parseZatoshi", () => {
    let error: unknown;
    try {
      parseZatoshi("7391.5");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ZecParseError);
    expect((error as Error).message).not.toContain("7391");
  });
});

describe("zecFromZatoshi (display of wire amounts)", () => {
  it.each([
    ["0", "0"],
    ["1", "0.00000001"],
    ["534500000", "5.345"],
    ["35000", "0.00035"],
    ["100000000", "1"],
    [MAX_MONEY.toString(), "21000000"],
  ])("%s zatoshi -> %s ZEC", (zatoshi, zec) => {
    expect(zecFromZatoshi(zatoshi)).toBe(zec);
  });

  it.each(["", "-1", "1.5", "abc", (MAX_MONEY + 1n).toString()])(
    "throws on %j rather than showing a wrong number",
    (bad) => {
      expect(() => zecFromZatoshi(bad)).toThrow(ZecParseError);
    },
  );
});
