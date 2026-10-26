# mainnet-run

## Why
ZecDrop has only ever run on public testnet, and the code refuses mainnet on purpose (`MainnetDisabled` in the
operator's chain setup and in `ZcashDistributor::new`). For the hackathon the two biggest gaps are a real mainnet payout and a
real wallet receiving it. A small, capped, attended mainnet run closes both, but only if the things that differ on mainnet
(or can drift) are checked by the code instead of by hope.

## What
Allow a real chain on mainnet behind the existing gate (`--allow-mainnet` plus `ZECDROP_CONFIRM_MAINNET=I-UNDERSTAND`)
and add the guards a first real-money run needs:

- a funding cap per mainnet campaign (REQ-OPS-003);
- one network per store, and a start-up check of the node before the operator shows its link (REQ-OPS-004);
- a self-check of every built batch and a cross-check of the node's branch id before anything is stored or sent
  (REQ-TX-004);
- a verifier that serves both networks from one process, with a clear refusal for one it does not serve (REQ-VER-005).

REQ-OPS-001 keeps its meaning; its wording is corrected to name the gate that is actually implemented.

## Approach
`ZcashDistributor::new` keeps refusing mainnet keys. `ZcashDistributor::new_for_mainnet` needs a `MainnetPermit`, which only
the operator creates after its gate has passed. The node's branch id is compared with what the pinned librustzcash
parameters derive for the next block, because the pinned crates know no mainnet NU7 height (a decision on the mainnet
height is due 2026-10-20, target activation 2026-11-05): after that upgrade this build must refuse, not mis-stamp.

## Scope decisions
- Not built: a seed export (the backup is a copy of the encrypted store, proven by re-deriving the first campaign's funding
  address from the copy; this keeps REQ-SEC-001 and invariant 4 unchanged), a mainnet sweep or reclaim command, multi-batch
  funding split, NEAR Intents on mainnet, and any change to the receipt contract.
- The public pages still say mainnet is untested until a run has actually happened; those sentences are pinned by tests
  and change in the same commit as the first real mainnet receipt.

## Risks
- The first broadcast of our bytes to mainnet is unproven. Offline proofs and the many real mainnet transparent-to-Ironwood
  transactions lower the odds; a rejection strands the funded amount (capped) and ends that campaign.
- Adding mainnet to the hosted verifier makes its start-up depend on a second node (it fails closed).
