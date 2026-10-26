// What a receipt says about where its deposit came from (REQ-VER-007). It follows docs/PRIVACY_BOUNDARY.md, "Where the deposit
// came from": what the deposit transaction shows (whether it names an address), never who paid. Tests import it.

export const RECEIPT_SOURCE_WORDING = {
  /** Under the funding address in the money-flow strip. */
  flowShielded: "Deposit out of the shielded pool",
  flowTransparent: "Deposit from transparent funds",
  /** The "?" on that station. */
  flowHelp:
    "The verifier read the deposit itself. Paid from a shielded balance, it names no address it came from; its amount and time are public either way. It never says who paid.",
  /** In the "Funding address" section. */
  heading: "What the deposit spent",
  shielded: "Funded from the shielded pool.",
  shieldedMore: "The deposit names no payer address. Its amount and time are public, like every deposit's.",
  transparent: "Funded from transparent funds.",
  transparentMore: "The address they came from is public, and the chain ties it to this campaign.",
  unknown: "Where the deposit came from could not be established.",
} as const;
