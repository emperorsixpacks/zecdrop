# Runbook — testnet demo run

**Status: executed end to end on 2026-10-08** (campaign `c-d8d4d52029a4`, txid
`6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955`, mined at height 4,478,289). The exact flags live in the
operator's crate docs, "Running a campaign on testnet" (`crates/drop-operator/src/lib.rs`); `drop-operator --help` is
authoritative. Testnet only; no real funds.

## Prerequisites

- Rust toolchain (the workspace builds on 1.92), `protoc`, Node 22.
- A throwaway dev seed at `~/.zecdrop-dev/testnet.seed` (mode 0600, never in the repo). The spike's `gen-testnet-wallet`
  creates it. Back it up outside the repo if you care about leftover testnet coins.
- A passphrase of at least 12 characters for the encrypted store, passed as `ZECDROP_PASSPHRASE` (never as an argument).
- Testnet coins at the campaign's **transparent** (`tm…`) address. The Valar Group faucet
  (<https://faucet.testnet.valargroup.dev>) accepts a transparent address and pays 0.125 TAZ per IP per day, **from its shielded
  wallet**: its payout has no transparent input, so the funding screen and the receipt say the deposit came from the shielded
  pool (checked 2026-10-23: the first batch's deposit `daa6b06c…8e2e`). A sweep of earlier change, as funded the 8-recipient run,
  is a transparent deposit and is shown as one.
  The operator watches only the **funding** address, so leftover change at the change address must be swept back with
  `live-batch sweep` before a second campaign can use it.

## Steps (what was run)

1. **Check the network.** `testnet.zec.rocks:443` reports chain `test` and branch `77190ad9` (NU7). Public testnet is
   on NU7; mainnet is still on NU6.3. Released wallets probably cannot sync current testnet.
2. **Start the operator against the real chain** (testnet default; the link is printed once, with the token in the URL
   fragment):
   `--lightwalletd-url https://testnet.zec.rocks:443 --seed-file ~/.zecdrop-dev/testnet.seed --db <store> --web-dir web/dist`.
   The first campaign for a seed gets account 0; the account registry (`~/.zecdrop`) is keyed by a seed fingerprint.
3. **Create the campaign** with `examples/demo-recipients.testnet.csv` (8 addresses, 0.005 TAZ in total). Expect a fee of
   45,000 zat and a required funding of 545,000 zat; no privacy warnings (the amounts differ).
4. **Funding is detected** from the funding address once the coin is 3 confirmations deep (picked up within one poll).
5. **Start.** Proving takes about 20 s for 8 recipients (about 1.25 s per payout); the batch is then broadcast and reaches
   depth 3 in about 80 s (testnet blocks are about 25 s apart on NU7). The campaign shows `settled`.
6. **Check it independently:** fetch the transaction from the node; start `drop-verifier` and request
   `/v1/receipt?network=testnet&tx=<txid>&declared_total=500000&commitment=<hex>` (expect `settled`, no findings, the
   funding address); a wrong declared total must report `declared_total_mismatch`.
7. **Audit** (local, key never printed):
   `export-ufvk --campaign <id> --i-understand-this-is-irreversible | audit --campaign <id> --ufvk-stdin --receipt-commitment <hex>`
   with identical `--db`, `--seed-file`, `--state-dir` and `--lightwalletd-url` on both commands. Expect "8 of 8 public
   actions", "8 of 8 rows confirmed", the recomputed commitment equal to the receipt's, and `RESULT: reconciled`.
8. **Recipient view** (our tool, since released wallets cannot read testnet):
   `cargo run -p drop-zcash --example recipient_view -- <1..8> <txid>`.

## Safety

- Never paste the seed, a viewing key, the operator token or the passphrase into chat, issues or screenshots.
- Mainnet needs `--allow-mainnet` and `ZECDROP_CONFIRM_MAINNET=I-UNDERSTAND`; this runbook does not use it. A mainnet run is in
  [`mainnet-run.md`](mainnet-run.md).
- If a batch is stuck, restart the operator with the same passphrase: the engine resumes from its ledger and re-sends the
  stored bytes; it never rebuilds the transaction.
- The audit and key-export commands print no key. The store, the seed file and the registry are mode 0600.
