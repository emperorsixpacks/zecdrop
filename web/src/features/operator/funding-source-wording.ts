// What the funding screen says about where a deposit came from (REQ-FUND-004). It follows docs/PRIVACY_BOUNDARY.md, "Where the
// deposit came from": it says what the deposit transaction shows (whether it names an address), never who paid, and it never
// holds the payout up. Tests import it, so a change here is a change to what they check.

export const FUNDING_SOURCE_WORDING = {
  /** Before any deposit: the ask, then why. */
  ask: "Pay from your shielded balance.",
  askWhy: "Then the deposit names no address of yours. A transparent address would sit on the chain beside this payout, for good.",
  /** The "?" beside the ask. */
  askMore: [
    "The amount and the time are public either way. If your coins are transparent, shield them well before you pay, not just before.",
    "A swap through NEAR Intents always arrives from a transparent address: the swap's, not yours, but public.",
  ],
  /** A deposit seen, at any depth, that spent no transparent coin. */
  shielded: "From the shielded pool: the deposit names no address of yours. Its amount and time are public.",
  /** The same on the mock chain or in practice mode, where the deposit is pretend. */
  shieldedPretend: "From the shielded pool (pretend): the deposit would name no address of yours. Its amount and time would be public.",
  /** A deposit that spent a transparent coin: said plainly, and never a reason to stop. */
  transparentTitle: "This deposit came from transparent funds",
  transparent: "Where it came from is public and now tied to this payout, which can't be undone. You can still send; next time, pay from a shielded balance.",
  transparentPretend: "In a real payout, where it came from would be public and tied to the payout for good. Next time, pay from a shielded balance.",
} as const;
