# shielded-inbox

## Why
A payout's deposit address is transparent on purpose: what lands there is the public total, which anyone can check (ADR 0001,
`docs/PRIVACY_BOUNDARY.md`). Paying it from a shielded balance already keeps the payer's address off the chain (REQ-FUND-004),
but the payer's own wallet still sends to a transparent address, the public deposit is built by that wallet at the moment it
pays, and it has to be one deposit of at least the whole amount. On 2026-10-24 the owner decided to give every payout a shielded
deposit address of its own, in front of the transparent one, built now and carefully (plan, flaws weighed, the decision in
docs/ADR/0006-shielded-inbox.md).

## What
- **A shielded deposit address per payout** (REQ-FUND-005): an Orchard-only Unified Address of a wallet of its own, derived from
  the operator's seed, checked before it is shown.
- **The move** (REQ-FUND-006): once the payer's notes are spendable and after a random delay, the operator moves exactly the
  funding to the payout's transparent funding address, in one transaction it checks with its own parser before storing or
  sending it. From there the payout runs as it always has; the receipt reads `shielded` with no verifier change.
- **Send back** (REQ-FUND-007): what is left goes back to a shielded address, checked the same way.
- **The funding screen leads with the inbox** (REQ-FUND-008) and says what it holds; the public address stays as the fallback.
- **Nothing of the inbox reaches the receipt, the auditor's key or the logs** (REQ-PRIV-004).

## Approach
The inbox wallet is zcash-devtool, run as a separate process, as the pinned librustzcash wallet crates cannot share a build with
ZecDrop's own pins (the pre.1 train, and a different rusqlite linking sqlite3) and the verifier crates must stay key-free. It is
built from upstream at a pinned commit with a small patch of ZecDrop's own, written fresh (`scripts/zcash-devtool/zecdrop.patch`):
Ironwood signing in `pczt sign`, `--ironwood-only` in `pczt create`/`create-max`, and `--tx-out` in `pczt extract`, so the operator
checks the exact bytes it broadcasts. The operator derives each inbox's phrase and the age identity it is encrypted to from its own
seed (`crates/drop-operator/src/inbox/keys.rs`), sets the wallet up and checks it (`inbox/setup.rs`), reads what it holds from the
wallet's database read-only (`inbox/walletdb.rs`), and drives zcash-devtool through a narrow driver (`inbox/devtool.rs`). The check
of every inbox transaction is `drop_zcash::InboxKeys::check_move`/`check_return`. Broadcasting goes through drop-chain, which
tells "already known" from "rejected".

## Scope decisions
- **Testnet only.** Ironwood is a testnet pool; `--zcash-devtool` is refused on mainnet.
- **Exceptions to the invariants (AGENTS.md), approved by the owner on 2026-10-24:** invariant 1 (no real shielded spends) still
  holds for every batch; the inbox's move and send-back are separate transactions spending that payout's inbox notes only.
  Invariant 3 (stored bytes are re-sent, never rebuilt) holds; a move is rebuilt only after its expiry has passed on the scanned
  chain with its notes unspent, so it can never be mined. Invariant 4 (spend keys never leave the operator process) still holds for
  the operator's seed and every payout's own keys; each inbox's derived seed is handed to the pinned zcash-devtool on this machine,
  on stdin, and kept only encrypted to an identity derived from the operator's seed.
- **The payer's deposit transaction is never looked up** by id: the node that watches the funding address would learn which
  payment fed which payout.
- **"shielded" on the receipt now describes the operator's move** for every inbox-funded payout; how the payer filled the inbox is
  not on the receipt, and the privacy boundary says so.
- **Not now:** the move could create one exact output per batch (the missing funding split, which would lift the one-batch
  limit); mock-chain and practice-mode inboxes (their screens and the tour's pictures stay as they are).
