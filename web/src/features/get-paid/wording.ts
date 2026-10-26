import type { AddressShape, UnrecognisedWhy } from "@/lib/address-shape";

// What the get-paid page says. Plain and short, for someone on a phone who may never have used Zcash. It
// claims only what is true of ZecDrop and of the wallet it names: Zodl is the one wallet whose release notes
// have been read, and nothing here says an address is valid, because the page checks its shape only
// (docs/PRIVACY_BOUNDARY.md, "Hidden from the public"; openspec REQ-ONB-001). copy.test.tsx bans the
// phrases that would claim more.

/** The only link out of the page, and the only place a wallet is named. No app-store link is made up. */
export const ZODL_URL = "https://zodl.com";

export const PROMISE = "To be paid privately, get a shielded wallet and give the payer one address.";

/** Under the promise, small: what the page does not do. */
export const ASSURANCE = "ZecDrop never sees your wallet. Nothing on this page leaves your phone unless you share it.";

/** In step 1: what the wallet is said to do, and where that comes from. Zodl is the one wallet whose release notes have been read. */
export const WALLET_LINE = "Zodl is a Zcash wallet for phones. By its release notes, version 3.8.0 or newer supports the shielded pool that payouts use.";

/** In step 1, behind "More about wallets": what shielded means, and what has and has not been checked. */
export const SHIELDED_NOTE = "Shielded means the receiver and the amount are encrypted on the public chain.";
export const OTHER_WALLETS_NOTE =
  "Other wallets may work, but we have only checked Zodl's release notes. A wallet that cannot receive in the current pool will not show the payout.";

/** Step 2: where to find the address that suits a payout. */
export const COPY_STEP = "In your wallet, open Receive and copy the address that starts with u1.";

/** Step 2: the other kinds of address a wallet may show, one short row each. */
export const OTHER_ADDRESSES: readonly { starts: string; text: string }[] = [
  { starts: "utest1", text: "A testnet address: for test coins, worth nothing." },
  { starts: "t1 or t3", text: "Not for payouts: it shows every payment publicly." },
  { starts: "zs1", text: "An older kind (Sapling). The payout tool asks for the u1 one." },
];

/** Said next to the check, always: what it can and cannot tell. */
export const SHAPE_NOTE =
  "This checks the shape only. It cannot tell whether the address is valid or yours; the payer's tool checks it fully.";

/** Shown while Share and Copy are off, so they do not look broken. */
export const BUTTONS_HINT = "Share and Copy turn on when the address starts with u1 or utest1.";

/** What the share sheet is given: one sentence and the address, as text. */
export function shareText(address: string): string {
  return `My Zcash address for payouts: ${address}`;
}

/** How loud a result is: calm for an address that suits a payout, a warning for the rest, and red only for the
 * one that would publish every payment. */
export type Tone = "default" | "warning" | "destructive";

export interface Described {
  title: string;
  text: string;
  tone: Tone;
}

const RESULT: Record<"mainnet_unified" | "testnet_unified" | "transparent" | "sapling", Described> = {
  mainnet_unified: {
    title: "Looks like a real-money address",
    text: "It starts with u1, the kind a ZecDrop payout can pay.",
    tone: "default",
  },
  testnet_unified: {
    title: "Looks like a testnet address",
    text: "It starts with utest1: a testnet address, for test coins worth nothing. Do not give it to someone paying real ZEC.",
    tone: "warning",
  },
  transparent: {
    title: "Looks like a transparent address",
    text: "It does not suit payouts. A transparent address shows every payment publicly, and ZecDrop payouts are for shielded wallets. In your wallet, copy the address that starts with u1.",
    tone: "destructive",
  },
  sapling: {
    title: "Looks like a Sapling address",
    text: "That is an older kind of shielded address. The payout tool asks for the u1 one, so copy that from your wallet's Receive screen.",
    tone: "warning",
  },
};

/** What is wrong with something that is not recognised, in one sentence. None repeats what was pasted. */
export const WHY_TEXT: Record<UnrecognisedWhy, string> = {
  inside_space: "It has a space or a line break inside. Copy the whole address again.",
  mixed_case: "It mixes capital and small letters. Copy it again without changing anything.",
  characters: "It has a character that no address uses. Copy it again.",
  length: "It is too short or too long for an address. Copy the whole address.",
  prefix: "It does not start like a Zcash address. In your wallet, open Receive and copy the address that starts with u1.",
};

/** The title and the sentence for what a pasted address looks like; null when nothing is pasted. */
export function describeShape(shape: AddressShape): Described | null {
  switch (shape.kind) {
    case "empty":
      return null;
    case "unrecognised":
      return { title: "Not recognised", text: WHY_TEXT[shape.why ?? "prefix"], tone: "warning" };
    default:
      return RESULT[shape.kind];
  }
}

/** What happened after Share or Copy. Closing the share sheet is not here: that is a choice, and says nothing. */
export const FEEDBACK_TEXT = {
  copied: "Address copied.",
  fallback_copied: "Sharing did not work here, so the address was copied instead.",
  copy_failed: "Could not copy. Select the address in the box and copy it yourself.",
} as const;

export type Feedback = keyof typeof FEEDBACK_TEXT;
