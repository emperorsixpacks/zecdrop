# A move from a payout's shielded deposit address (public chain data only)

`543ae84065e8767db1c91eda188bc09e2ec5b692425e7842481fad4b99b95f23/` is the first move from a ZecDrop inbox
(docs/ADR/0006-shielded-inbox.md), made by hand on public testnet on 2026-10-24 (Checkpoint A) through the operator's own
modules (`crates/drop-operator/examples/inbox_spike.rs`): zcash-devtool built from upstream with `scripts/zcash-devtool/zecdrop.patch`
signed it, and `drop_zcash::InboxKeys::check_move` checked its bytes before they were broadcast through `testnet.zec.rocks:443`.
It was mined at height 4,537,003 (branch `77190ad9`).

What happened, all on testnet:
1. A 2-person payout (`c-69df9236f35c`, declared 100,000 zatoshi, funding required 115,000) was created on a real operator.
2. Its inbox (an Orchard-only Unified Address of its own wallet) was paid 130,000 zatoshi from a shielded wallet, shielded to
   shielded. That payment is not named here: naming it would publish what the inbox keeps off the record, which payment fed
   which payout.
3. At 11 confirmations the move was built, checked and sent: this transaction.
4. The operator's funding poller saw its output at the payout's funding address `tmHWPvYdJcXfuthNsHz4oUkTJVFUPdqbFma`
   and funded the payout with `funding_source: shielded`; the payout was then sent.

Shape: no transparent input; 2 Ironwood actions (one spends the 130,000-zatoshi note, nullifier
`7b4dfbc865cbfe01e1254b8769f0e5a4b66500272a28aa3c58baddbf090f1e30`; the other is padding); value balance 130,000 leaving the
pool; one P2PKH output of exactly 115,000 to the funding address; fee 15,000 (3 ZIP 317 logical actions); no change; expiry
4,537,042. V6 transaction.

| File | Content |
|---|---|
| `move-tx.hex` | the transaction exactly as zcash-devtool extracted it and the operator checked and broadcast it; byte for byte what `GetTransaction` returns for it |
