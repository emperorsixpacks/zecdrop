// What the funding screen says about a payout's shielded deposit address (REQ-FUND-008, docs/ADR/0006-shielded-inbox.md). It
// follows docs/PRIVACY_BOUNDARY.md: paid from a shielded wallet, the deposit names no address of the payer's, and the public
// step is made by ZecDrop; the total stays public, which is the point. Never that the payer is hidden. Tests import it.

export const INBOX_WORDING = {
  /** The ask, after the amount: "Send 0.0013 TAZ …". */
  ask: "from your shielded wallet to this payout's own shielded address.",
  /** The "?" beside the ask. */
  why: [
    "ZecDrop then moves exactly the funding to the payout's public address, a few minutes later. That public step is what lets anyone check the total.",
    "The move's network fee is in the amount shown. Pay it in one payment or in several.",
    "Your wallet never pays a public address, and the public step is made by ZecDrop, not your wallet. Its amount and time are public, like any deposit's.",
  ],
  whyLabel: "About the shielded address",
  copyLabel: "Copy shielded address",
  qrLabel: "QR code for this deposit: the payout's shielded address and the amount",
  qrCaption: "Scan with a Zcash wallet on your phone: it fills in this shielded address and the amount.",
  preparing: "Setting up this payout's shielded address…",
  unavailable: "This payout's shielded address can't be used right now. The operator keeps trying. You can pay the public address instead.",
  waiting: "No deposit seen yet. This page checks again every few seconds.",
  shortTail: "Payments to this address add up.",
  dustTail: "so what is left over can come back to you.",
  scheduledWhy: "The short random wait keeps the move from lining up in time with your payment.",
  movingTail: "The payout is funded once it is confirmed.",
  unused: "This payout is being funded at its public address, so its shielded address is not used.",
  orchardTail: "arrived in the Orchard pool, which a move can't spend. Pay from a wallet that sends Ironwood.",
  publicInstead: "Pay the public address instead",
  /** After the payout is funded from the shielded address. */
  movedFrom: "Moved here from this payout's shielded address.",
  leftTail: "is left in this payout's shielded address.",
  /** Sending what is left back (REQ-FUND-007). */
  returnHeading: "Send it back",
  returnWhy: "Everything in this payout's shielded address, less a small network fee, goes to a shielded address of yours.",
  returnLabel: "Your shielded address",
  returnButton: "Send it back",
  returnConfirm: "This can't be undone. Send it all to the address above?",
  returnYes: "Yes, send it back",
  returnSent: "Sending it back, in transaction",
} as const;
