/** What handing out a campaign viewing key means. This is the operator's own
 * sentence (DISCLOSURE_WARNING in crates/drop-operator/src/commands.rs); a test
 * compares the two word for word, so the page cannot soften it. It is shown
 * BEFORE the key is requested; the operator's reply carries it again and that
 * copy is shown next to the key. */
export const DISCLOSURE_WARNING =
  "A campaign viewing key lets its holder see every payout of this campaign: each recipient address, amount and memo. Giving it away cannot be undone, and anyone it reaches can keep it forever. Share it only with the auditor you intend, over a channel you trust.";

/** How long a revealed key stays on screen before it is hidden again. */
export const KEY_VISIBLE_MS = 120_000;
