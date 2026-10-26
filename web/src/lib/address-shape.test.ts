import { describe, expect, it } from "vitest";

import recipientRust from "../../../crates/drop-core/src/recipient.rs?raw";
import demoCsv from "../../../examples/demo-recipients.testnet.csv?raw";

import { classifyAddress, MAX_ADDRESS_CHARS, type AddressKind } from "./address-shape";

// Addresses of every shape, made from the alphabets and lengths. They are not checksummed, and they are not
// anyone's: the check is of shape only. (The demo addresses below are the real, public ones of the sample batch.)
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const data = (n: number, alphabet = BECH32) => Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");

const unified = (length = 106) => `u1${data(length - 2)}`;
const testnetUnified = (length = 110) => `utest1${data(length - 6)}`;
const sapling = (length = 78) => `zs1${data(length - 3)}`;
const testnetSapling = (length = 88) => `ztestsapling1${data(length - 13)}`;
const transparent = (prefix = "t1", length = 35) => `${prefix}${data(length - 2, BASE58)}`;

// The mainnet funding address in the hosted stub and the testnet funding address of the real batch: real transparent ones.
const REAL_T1 = "t1cFrgk2qsbNHgNSmV8DNauWTCe6EKRLW9L";
const REAL_TM = "tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD";

const kindOf = (input: unknown): AddressKind => classifyAddress(input).kind;

describe("classifyAddress: every kind", () => {
  it.each<[label: string, address: string, kind: AddressKind, suits: boolean]>([
    ["a mainnet unified address (u1)", unified(), "mainnet_unified", true],
    ["a mainnet unified address with every receiver (213 characters)", unified(213), "mainnet_unified", true],
    ["a testnet unified address (utest1)", testnetUnified(), "testnet_unified", true],
    ["a mainnet transparent address, pay to key hash (t1)", REAL_T1, "transparent", false],
    ["a mainnet transparent address, pay to script hash (t3)", transparent("t3"), "transparent", false],
    ["a testnet transparent address (tm)", REAL_TM, "transparent", false],
    ["a testnet transparent script address (t2)", transparent("t2"), "transparent", false],
    ["a mainnet Sapling address (zs1)", sapling(), "sapling", false],
    ["a testnet Sapling address (ztestsapling1)", testnetSapling(), "sapling", false],
    ["nothing", "", "empty", false],
    ["only space", "  \n\t ", "empty", false],
    ["a Bitcoin address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "unrecognised", false],
    ["an Ethereum address", "0x52908400098527886E0F7030069857D2E4169EE7", "unrecognised", false],
    ["a Sprout address", `zc${data(93, BASE58)}`, "unrecognised", false],
    ["a regtest unified address", `uregtest1${data(100)}`, "unrecognised", false],
    ["a payment link", `zcash:${unified()}?amount=1`, "unrecognised", false],
    ["a sentence", "my address is in the other message", "unrecognised", false],
  ])("%s", (_label, address, kind, suits) => {
    const shape = classifyAddress(address);
    expect(shape.kind).toBe(kind);
    expect(shape.suitsPayouts).toBe(suits);
  });

  it("only a unified address, real or practice, suits a payout, and only that is handed back to share", () => {
    for (const address of [unified(), testnetUnified()]) {
      const shape = classifyAddress(address);
      expect(shape.suitsPayouts).toBe(true);
      expect(shape.shareable).toBe(address);
    }
    for (const address of [REAL_T1, REAL_TM, sapling(), testnetSapling(), "", "nonsense"]) {
      const shape = classifyAddress(address);
      expect(shape.suitsPayouts).toBe(false);
      expect(shape.shareable).toBe("");
    }
  });

  it("says why something is not recognised, and only then", () => {
    expect(classifyAddress("nonsense")).toMatchObject({ kind: "unrecognised", why: "prefix" });
    expect(classifyAddress(unified()).why).toBeNull();
    expect(classifyAddress(REAL_T1).why).toBeNull();
    expect(classifyAddress("").why).toBeNull();
  });

  it("is the real demo addresses of the sample batch: eight practice addresses that suit a payout", () => {
    const addresses = demoCsv
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.split(",")[0] ?? "");
    expect(addresses).toHaveLength(8);
    for (const address of addresses) {
      const shape = classifyAddress(address);
      expect(shape.kind).toBe("testnet_unified");
      expect(shape.suitsPayouts).toBe(true);
      expect(shape.shareable).toBe(address);
    }
  });
});

describe("classifyAddress: lengths", () => {
  it.each<[label: string, make: (length: number) => string, shortest: number, longest: number, kind: AddressKind]>([
    ["unified", unified, 100, MAX_ADDRESS_CHARS, "mainnet_unified"],
    ["testnet unified", (n) => testnetUnified(n), 100, MAX_ADDRESS_CHARS, "testnet_unified"],
    ["Sapling", (n) => sapling(n), 70, 100, "sapling"],
    ["testnet Sapling", (n) => testnetSapling(n), 70, 100, "sapling"],
    ["transparent", (n) => transparent("t1", n), 34, 36, "transparent"],
    ["testnet transparent", (n) => transparent("tm", n), 34, 36, "transparent"],
  ])("%s: the shortest and the longest that are recognised, and one short and one long that are not", (_label, make, shortest, longest, kind) => {
    expect(kindOf(make(shortest))).toBe(kind);
    expect(kindOf(make(longest))).toBe(kind);
    expect(classifyAddress(make(shortest - 1))).toMatchObject({ kind: "unrecognised", why: "length" });
    expect(classifyAddress(make(longest + 1))).toMatchObject({ kind: "unrecognised", why: "length" });
  });

  it("the longest address is the longest the core takes (MAX_ADDRESS_BYTES in crates/drop-core/src/recipient.rs)", () => {
    expect(Number(/pub const MAX_ADDRESS_BYTES: usize = (\d+);/u.exec(recipientRust)?.[1])).toBe(MAX_ADDRESS_CHARS);
  });

  it("a real unified address is within the bounds, for one receiver and for all of them", () => {
    // 106 on mainnet and 110 on testnet for one shielded receiver, 213 with every receiver there is today.
    for (const length of [106, 178, 213]) expect(kindOf(unified(length))).toBe("mainnet_unified");
    for (const length of [110, 182, 217]) expect(kindOf(testnetUnified(length))).toBe("testnet_unified");
  });

  it("a prefix alone, or a few characters, is too short", () => {
    for (const text of ["u1", "u1qpz", "utest1", "utest1qpz", "zs1", "zs1qpz", "t1", "t1abc", "ztestsapling1"]) {
      expect(classifyAddress(text), text).toMatchObject({ kind: "unrecognised", why: "length" });
    }
  });
});

describe("classifyAddress: case", () => {
  it("reads a unified address in capitals (a QR code writes them so) and hands it back in small letters", () => {
    for (const address of [unified(), testnetUnified()]) {
      const shape = classifyAddress(address.toUpperCase());
      expect(shape.suitsPayouts).toBe(true);
      expect(shape.shareable).toBe(address);
    }
    expect(kindOf(sapling().toUpperCase())).toBe("sapling");
  });

  it("refuses a mixed-case Bech32 address, which is no address", () => {
    const mixed = `U1${unified().slice(2)}`;
    expect(classifyAddress(mixed)).toMatchObject({ kind: "unrecognised", why: "mixed_case" });
    const oneCapital = `${unified().slice(0, 50)}${unified().slice(50, 51).toUpperCase()}${unified().slice(51)}`;
    expect(classifyAddress(oneCapital)).toMatchObject({ kind: "unrecognised", why: "mixed_case" });
  });

  it("keeps a transparent address as it is: Base58 has capitals, and a capital T does not start one", () => {
    expect(kindOf(REAL_T1)).toBe("transparent");
    expect(kindOf(REAL_T1.toUpperCase())).toBe("unrecognised");
    // Case is part of a Base58 address, so it is never folded: this one in small letters is another string, with an l
    // in it, which Base58 does not use.
    expect(classifyAddress(REAL_T1.toLowerCase())).toMatchObject({ kind: "unrecognised", why: "characters" });
  });
});

describe("classifyAddress: space around it", () => {
  const wrap = (address: string) => [
    `  ${address}`,
    `${address}  `,
    `\n${address}\n`,
    `\r\n\t${address}\r\n`,
    `\u00a0${address}\u00a0`,
    `\u2003${address}\u2003`,
  ];

  it.each([unified(), testnetUnified(), REAL_T1, sapling()])("does not count space or line breaks before or after %#", (address) => {
    for (const text of wrap(address)) expect(classifyAddress(text), JSON.stringify(text)).toEqual(classifyAddress(address));
  });

  it("hands back an address with the space gone", () => {
    for (const text of wrap(unified())) expect(classifyAddress(text).shareable).toBe(unified());
  });

  it("refuses space or a line break inside it, as when a message wrapped it", () => {
    const at = (i: number, gap: string) => `${unified().slice(0, i)}${gap}${unified().slice(i)}`;
    for (const gap of [" ", "\n", "\r\n", "\t", "\u00a0"]) {
      expect(classifyAddress(at(40, gap)), JSON.stringify(gap)).toMatchObject({ kind: "unrecognised", why: "inside_space" });
    }
    expect(classifyAddress(`${unified()} ${unified()}`)).toMatchObject({ kind: "unrecognised", why: "inside_space" });
    for (const wrapped of [`${REAL_T1.slice(0, 20)} ${REAL_T1.slice(20)}`, `${sapling().slice(0, 30)}\n${sapling().slice(30)}`, `${testnetUnified().slice(0, 50)}  ${testnetUnified().slice(50)}`]) {
      expect(classifyAddress(wrapped)).toMatchObject({ kind: "unrecognised", why: "inside_space" });
    }
  });

  it("says a sentence is no address, rather than blaming its spaces", () => {
    for (const sentence of ["hello there", "my address is below", `my address is ${unified()}`, `Address: ${unified()}`, "t is for tea"]) {
      expect(classifyAddress(sentence), sentence).toMatchObject({ kind: "unrecognised", why: "prefix" });
    }
  });
});

describe("classifyAddress: characters", () => {
  const replaceAt = (address: string, index: number, character: string) => `${address.slice(0, index)}${character}${address.slice(index + 1)}`;

  it.each(["b", "i", "o", "1", "B", "-", "_", ".", "!"])("a unified address with %j in it is not recognised", (character) => {
    expect(classifyAddress(replaceAt(unified(), 60, character))).toMatchObject({ kind: "unrecognised", why: character === "B" ? "mixed_case" : "characters" });
  });

  it.each(["0", "O", "I", "l", "+", "/", "_"])("a transparent address with %j in it is not recognised", (character) => {
    expect(classifyAddress(replaceAt(REAL_T1, 20, character))).toMatchObject({ kind: "unrecognised", why: "characters" });
  });

  it.each([
    ["a zero-width space", "\u200b"],
    ["a letter that only looks like one (Cyrillic \u0430)", "\u0430"],
    ["a full-width digit", "\uff12"],
    ["the Kelvin sign, which folds to k", "\u212a"],
    ["an emoji", "\u{1f600}"],
    ["a control character", "\u0001"],
    ["a null", "\u0000"],
  ])("%s inside an address is not recognised, so what is shared is what was pasted", (_what, character) => {
    for (const address of [unified(), testnetUnified(), REAL_T1, sapling()]) {
      expect(classifyAddress(replaceAt(address, 20, character)).kind).toBe("unrecognised");
    }
    expect(classifyAddress(replaceAt(unified().toUpperCase(), 20, "\u212a"))).toMatchObject({ kind: "unrecognised", suitsPayouts: false, shareable: "" });
  });
});

describe("classifyAddress: never throws", () => {
  it.each([undefined, null, 0, 1, NaN, true, false, {}, [], ["u1"], () => "u1", Symbol("u1"), 10n, new Date(0)])("for %s, which is not text", (input) => {
    expect(() => classifyAddress(input)).not.toThrow();
    expect(classifyAddress(input)).toEqual({ kind: "empty", why: null, suitsPayouts: false, shareable: "" });
  });

  it("for any text at all", () => {
    // A small deterministic generator, so a failure can be repeated.
    let seed = 20_261_019;
    const next = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed;
    };
    const pieces = ["u1", "utest1", "t1", "tm", "zs1", "ztestsapling1", "U1", " ", "\n", "\u200b", "\ud800", "\udfff", "q", "0", "B", "l", "\u00e9", "\u{1f600}", ...BECH32, ...BASE58];
    for (let i = 0; i < 3_000; i += 1) {
      let text = "";
      for (let n = next() % 30; n > 0; n -= 1) text += pieces[next() % pieces.length] ?? "";
      const shape = classifyAddress(text);
      expect(Object.keys(shape).sort()).toEqual(["kind", "shareable", "suitsPayouts", "why"]);
      if (shape.suitsPayouts) expect(shape.shareable).toBe(text.trim().toLowerCase());
      else expect(shape.shareable).toBe("");
      expect((shape.kind === "unrecognised") === (shape.why !== null)).toBe(true);
    }
  });

  it("for a paste of any size, and without taking long over it", () => {
    for (const text of ["u1".repeat(5_000_000), `${"a".repeat(3_000_000)}\n${"b".repeat(3_000_000)}`, " ".repeat(2_000_000), "\u200b".repeat(1_000_000)]) {
      const started = performance.now();
      expect(() => classifyAddress(text)).not.toThrow();
      expect(performance.now() - started).toBeLessThan(1_000);
    }
    expect(classifyAddress("u1".repeat(5_000_000))).toMatchObject({ kind: "unrecognised", why: "length" });
  });
});

describe("classifyAddress: what it hands back", () => {
  it("is the address, trimmed and in small letters, and no other text from the paste", () => {
    const shape = classifyAddress(`\n  ${unified().toUpperCase()}\t `);
    expect(shape.shareable).toBe(unified());
    expect(JSON.stringify(classifyAddress("nonsense that is not an address"))).not.toContain("nonsense");
    expect(JSON.stringify(classifyAddress(REAL_T1))).not.toContain(REAL_T1);
    expect(JSON.stringify(classifyAddress(sapling()))).not.toContain(sapling());
  });
});
