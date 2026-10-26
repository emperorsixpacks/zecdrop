# 0006 — A shielded deposit address in front of the public one ("the inbox")

Status: Accepted (owner, 2026-10-24)
Date: 2026-10-24

## Context

A payout's funding address is transparent on purpose: what lands there is the public total anyone can check (ADR 0001). Paying
it from a shielded balance keeps the payer's address off the chain (REQ-FUND-004), but the payer's wallet still sends to a
transparent address, the public deposit is built by that wallet at the moment it pays, and it must be one deposit of the whole
amount. The owner decided to give every payout a shielded deposit address of its own, in front of the transparent one.

Spending a shielded note needs a wallet: finding the note by trial decryption, keeping its witness in the note commitment tree
current, tracking what is spent. ZecDrop has none (the batch builder spends transparent coins only). zcash-devtool, the Zcash
developers' wallet tool, does all of it; its librustzcash wallet crates are pinned at git `eb38d7a`, which cannot share a build
with ZecDrop's crates.io pre.1 pins, and its `zcash_client_sqlite` links a different rusqlite (both link sqlite3).

## Decision

- **zcash-devtool as a separate process**, built by `scripts/zcash-devtool/build.sh` from upstream `b532d4cd` with
  `scripts/zcash-devtool/zecdrop.patch`, written for ZecDrop: `pczt sign` signs Ironwood spends from the wallet's own seed,
  `pczt create`/`create-max` take `--ironwood-only`, and `pczt extract` takes `--tx-out`. Nothing in ZecDrop's pinned crates,
  its batch builder or its deployed verifier changes. Checked first: ZecDrop's pre.1 parser reads devtool-built V6 Ironwood
  spends, so the public verifier can read the move.
- **One wallet per payout**, account 0 of a BIP 39 phrase derived from the operator's seed and the payout's ZIP 32 account
  (`crates/drop-operator/src/inbox/keys.rs`): the seed alone recovers every inbox, each payout is isolated, and the payout's own
  account (whose viewing key goes to an auditor) never sees it. The wallet is set up from the phrase on stdin and checked (its
  account's Orchard incoming viewing key must be the operator's own derivation) before its address is shown.
- **The move:** once the payer's notes are spendable (10 confirmations) and after a random delay, one transaction pays exactly
  the funding to the payout's funding address, from Ironwood notes only, change back to the inbox. The operator checks its raw
  bytes with its own parser before storing or sending it (`drop_zcash::InboxKeys::check_move`: shape, fee, and value conservation
  by nullifier), stores the raw bytes before broadcast, sends exactly those bytes through drop-chain, and re-sends them until
  mined. From there the payout runs unchanged; the move has no transparent input, so the receipt reads `shielded`.
- **Send back** what is left to a shielded address, checked the same way, only when no move can happen.

## Exceptions to the invariants (AGENTS.md)

- **Invariant 1** (no real shielded spends): holds for every batch. The move and the send-back are separate transactions that
  spend that payout's inbox notes only.
- **Invariant 3** (a built transaction is stored before broadcast; resume re-sends, never rebuilds): holds for the move. It is
  rebuilt only after the wallet has scanned past its expiry height with its notes still unspent, so it can never be mined.
- **Invariant 4** (spend keys never leave the operator process): holds for the operator's seed and every payout's own keys.
  Each inbox's derived seed is handed to the pinned zcash-devtool on this machine, on stdin, and kept only encrypted to an age
  identity derived from the operator's seed (given on stdin to sign; in a 0600 file, deleted at once, for `init` alone).
- **ADR 0001** (the low-level Builder, the framework only for chain data): batches are unchanged; the framework, inside
  zcash-devtool, is used for the inbox wallet only.

## Consequences

- One more transaction per payout: a ZIP 317 fee (15,000 zatoshi for one or two notes) and the wait for 10 confirmations plus
  the delay, said on screen. The payer is asked for the funding plus that fee.
- The total stays public, so a payer who shields that exact amount just before can still be matched by amount and time; the
  delay and "shield well before" help, and the docs say so.
- Plain on disk: zcash-devtool's database (the inbox's viewing keys, notes and amounts); 0700 throughout, PCZT files deleted.
- Network metadata: setting a wallet up tells the server its birthday, and each sync asks about the inbox account's (unused)
  transparent addresses. The payer's deposit transaction is never fetched by id.
- Ironwood-only spends send their change to Ironwood after the upgrade (`zcash_client_backend` change strategy), so the move
  has no Orchard part.
- An external CLI: pinned commit, our patch, a start-up check of our flags, fixed error kinds (its own output is never shown or
  logged), the database read-only.
- Later: the move could create one exact output per batch, the funding split that would lift the one-batch limit.
