// The note a payout carries to the person it pays: a ZIP-302 text memo, at most 512 bytes of UTF-8, the same limit
// the importer checks (`MAX_MEMO_BYTES`, crates/drop-core/src/recipient.rs). It is counted in bytes, not in
// characters: an accented letter takes two and most emoji take four.

/** The importer refuses a memo longer than this many bytes. */
export const MAX_MEMO_BYTES = 512;

const encoder = new TextEncoder();

/** How many bytes `text` takes as UTF-8. */
export function memoBytes(text: string): number {
  return encoder.encode(text).length;
}
