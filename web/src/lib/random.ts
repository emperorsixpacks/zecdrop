// Random bytes for the page: the lucky split of a payout list. They come from the
// browser's cryptographic generator; a test can pass its own source instead.

/** `length` random bytes. */
export type RandomBytes = (length: number) => Uint8Array;

export const browserRandom: RandomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));
