# Demo data (TESTNET)

## `demo-recipients.testnet.csv`

Eight demo recipients for a testnet campaign.

- **Addresses:** testnet Unified Addresses with an Orchard receiver. They are ZIP-32 accounts
  9000–9007 of the dev seed, a range kept apart from campaign accounts, which start at 0.
- **Amounts:** varied, summing to exactly **0.005 TAZ**, so the review step raises no
  uniform-batch warning.
- **Memos:** `ZecDrop demo payout N`.

It is one batch of 8. At 5,000 zat per action the fee is 45,000 zat, so the first run needs
**0.00545 TAZ** at the campaign's transparent funding address.

**Safe to commit:** the file holds public addresses, amounts and memos only, with no seed, spending
key or viewing key. `crates/drop-zcash/tests/demo_recipients_csv.rs` checks this on every
`cargo test`. It also imports the file with the real Zcash address codec.

Regenerate it (deterministic for a given dev seed):

```sh
cargo run -p drop-zcash --example demo_recipients
```

This needs the dev seed at `~/.zecdrop-dev/testnet.seed` (mode 0600, outside the repo), created
once by `spikes/single-tx-builder/port-0.31`'s `gen-testnet-wallet`. The seed is never printed.

## Seeing a payout as a recipient

Released wallets cannot sync testnet today: they predate NU7, which testnet already runs. For
the demo, the recipient side is shown with drop-zcash itself:

```sh
cargo run -p drop-zcash --example recipient_view -- <n: 1-8> <txid> [endpoint]
```

It fetches the transaction through `drop-chain`, by default from `https://testnet.zec.rocks:443`.
It decrypts with demo recipient `n`'s incoming viewing key and prints three things:

- the amount and memo addressed to that recipient;
- what anyone can see: the total paid into the Ironwood pool, the output count, the fee and the
  change;
- what the recipient cannot see: the other outputs' amounts, recipients and memos.

It prints no seed and no keys.

**Safety:**
- Testnet only.
- The dev seed controls the campaign *and* these demo recipients; never fund it with anything but
  faucet TAZ.
- Never copy it into the repo.
