// What a pasted Zcash address LOOKS like, from how it starts, the characters it uses and how long it is.
//
// This is a check of shape only. It does not decode the address or test its checksum, so it cannot tell a
// real address from a made-up one of the same shape: the payer's tool (the operator's address codec) is the
// real check, and the page says so. It runs in the page and keeps nothing: it reads a string and returns a
// value, never throws, and hands the address back only for a shape that suits a payout.
//
//   u1…               a unified address on mainnet: real money
//   utest1…           a unified address on testnet: test coins only
//   t1… t3… tm… t2…   a transparent address (mainnet, testnet): it shows every payment publicly
//   zs1… ztestsapling1…   a Sapling address: an older shielded kind

export type AddressKind = "empty" | "mainnet_unified" | "testnet_unified" | "transparent" | "sapling" | "unrecognised";

/** The first thing that is off about something that is not recognised. */
export type UnrecognisedWhy = "inside_space" | "mixed_case" | "characters" | "length" | "prefix";

export interface AddressShape {
  kind: AddressKind;
  /** Only for "unrecognised". */
  why: UnrecognisedWhy | null;
  /** Whether a payout can pay an address of this shape: a unified address, mainnet or testnet. */
  suitsPayouts: boolean;
  /** The address to share or copy: trimmed, and in lower case (Bech32 is the same address in either case).
   * Empty unless the shape suits a payout. */
  shareable: string;
}

/** The core accepts an address of at most this many bytes (`MAX_ADDRESS_BYTES`, crates/drop-core/src/recipient.rs). */
export const MAX_ADDRESS_CHARS = 1024;

// A unified address with one shielded receiver is 106 characters on mainnet and 110 on testnet, and one with
// every receiver there is today is 213; the bounds are loose on purpose, so a real one is never turned away.
const UNIFIED_MIN = 100;
// A Sapling address is 78 characters on mainnet and 88 on testnet. A transparent one is 35.
const SAPLING = { min: 70, max: 100 } as const;
const TRANSPARENT = { min: 34, max: 36 } as const;

/** A Bech32 string after its prefix: lower case, without the letters b, i and o and without the digit 1. */
const BECH32_DATA = /^[02-9ac-hj-np-z]*$/u;
/** Base58 as Zcash writes a transparent address: no 0, O, I or l. */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]*$/u;

interface Bech32Rule {
  kind: "mainnet_unified" | "testnet_unified" | "sapling";
  prefix: string;
  min: number;
  max: number;
}

const BECH32_RULES: readonly Bech32Rule[] = [
  { kind: "testnet_unified", prefix: "utest1", min: UNIFIED_MIN, max: MAX_ADDRESS_CHARS },
  { kind: "mainnet_unified", prefix: "u1", min: UNIFIED_MIN, max: MAX_ADDRESS_CHARS },
  { kind: "sapling", prefix: "ztestsapling1", ...SAPLING },
  { kind: "sapling", prefix: "zs1", ...SAPLING },
];

/** Mainnet pay-to-key-hash and pay-to-script-hash, then the testnet ones. */
const TRANSPARENT_PREFIXES: readonly string[] = ["t1", "t3", "tm", "t2"];

const NOTHING: AddressShape = { kind: "empty", why: null, suitsPayouts: false, shareable: "" };

const not = (why: UnrecognisedWhy): AddressShape => ({ kind: "unrecognised", why, suitsPayouts: false, shareable: "" });

/** Whether `text` starts the way some kind of address does. */
function startsLikeAnAddress(text: string): boolean {
  const lower = text.toLowerCase();
  return BECH32_RULES.some((rule) => lower.startsWith(rule.prefix)) || TRANSPARENT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** What `input` looks like. Leading and trailing space and line breaks do not count. Never throws. */
export function classifyAddress(input: unknown): AddressShape {
  if (typeof input !== "string") return NOTHING;
  const text = input.trim();
  if (text === "") return NOTHING;
  // Before anything reads it: no address is this long, and a paste can be any size.
  if (text.length > MAX_ADDRESS_CHARS) return not("length");
  // A space inside something that starts like an address is a message that wrapped it; inside anything else it is a
  // sentence, which is no address however it is spaced.
  if (/\s/u.test(text)) return not(startsLikeAnAddress(text.replace(/\s+/gu, "")) ? "inside_space" : "prefix");
  // An address is plain printable ASCII. Anything else (a zero-width space, a letter that only looks like one) is
  // refused before case is folded, so what is shared is always exactly what was pasted, in lower case.
  if (!/^[\x21-\x7e]+$/u.test(text)) return not("characters");

  const lower = text.toLowerCase();
  for (const rule of BECH32_RULES) {
    if (!lower.startsWith(rule.prefix)) continue;
    // Bech32 is written all in small letters or all in capitals (a QR code often has capitals), never mixed.
    if (text !== lower && text !== text.toUpperCase()) return not("mixed_case");
    if (!BECH32_DATA.test(lower.slice(rule.prefix.length))) return not("characters");
    if (text.length < rule.min || text.length > rule.max) return not("length");
    const unified = rule.kind !== "sapling";
    return { kind: rule.kind, why: null, suitsPayouts: unified, shareable: unified ? lower : "" };
  }

  // Base58 is case-sensitive: a capital T is not the start of a transparent address.
  if (TRANSPARENT_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    if (!BASE58.test(text)) return not("characters");
    if (text.length < TRANSPARENT.min || text.length > TRANSPARENT.max) return not("length");
    return { kind: "transparent", why: null, suitsPayouts: false, shareable: "" };
  }

  return not("prefix");
}
