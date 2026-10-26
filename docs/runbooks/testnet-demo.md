# Runbook — testnet demo run

**Status: executed end to end on 2026-10-08** (campaign `c-d8d4d52029a4`, txid
`6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955`, mined at height 4,478,289), **and funded through the
payout's own shielded deposit address on 2026-10-24** ("Funding through the shielded deposit address", below). The exact flags live in the
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

## Funding through the shielded deposit address

**Executed on 2026-10-24** (docs/ADR/0006-shielded-inbox.md). Testnet only: the operator refuses `--zcash-devtool` on mainnet
and on the mock chain.

1. **Build zcash-devtool** from upstream with ZecDrop's patch: `scripts/zcash-devtool/build.sh` writes
   `target/zcash-devtool/zcash-devtool` (the first build takes a while).
2. **Start the operator** as in step 2, adding `--zcash-devtool target/zcash-devtool/zcash-devtool` (optionally
   `--inbox-poll-secs 20` and `--inbox-move-delay 60..600`, the defaults). It refuses a zcash-devtool without the patch.
3. **Create the campaign** as in step 3. Within a minute *Is it funded?* shows the payout's own shielded address and asks for the
   funding plus the move's fee: 545,000 + 15,000 = 560,000 zat for the demo CSV.
4. **Pay it from a shielded wallet** that can send Ironwood on current testnet, in one payment or several. Released wallets
   probably cannot sync testnet; we used a zcash-devtool wallet of our own (the same build), funded once from another testnet
   wallet, paying with `pczt create --ironwood-only …`, `prove`, `sign`, `combine` and `send`.
5. **Wait.** The screen counts the payment's confirmations to 10, says when the move is due (a random 1 to 10 minutes later),
   then shows the move confirming. The operator's log names the move's txid and nothing else of the inbox. At 3 confirmations
   the funding poller funds the payout, and the screen says "Moved here from this payout's shielded address." with the
   deposit "From the shielded pool". Then continue from step 5.
6. **Check it** as in steps 6 and 7. The payout's own key opens none of the inbox's actions:
   `drop-operator audit-tx --tx <file> --prevouts <file> --account <n> --seed-file …` over the move (`funding-tx.hex` of the
   fixture) recovers 0 of 2 actions.
7. **Send back what is left** (more paid than asked, or a payout funded at its public address while the inbox held notes):
   *Send it back* on the funding screen, or `POST /api/campaigns/{id}/inbox/return` with `{"to": "<a shielded address with an
   Orchard receiver>"}` and the header `X-Zecdrop-Confirm-Send: I-UNDERSTAND`. Everything spendable goes, less the fee.

What ran:
- The 8-person demo payout `c-6207fac6674f`: the move `6e677bc5…70f3` (mined at 4,537,111) moved exactly 545,000; the batch
  `af8adf80…4a12` (mined at 4,537,130) settled. A freshly started verifier: settled, `funding_source: shielded`, no findings;
  the 8 payslips verify; the audit reconciled 8 of 8. Fixtures: `fixtures/testnet-ironwood-batch-8-inbox/`.
- A 2-person payout `c-8b18093b3e47`, paid 230,000 where 130,000 was asked: the move `1ddf0b37…2085` moved exactly 115,000 and
  left 100,000; the send-back `2131eae8…c4b8` (no transparent part, fee 10,000, mined at 4,537,203) gave the payer's shielded
  wallet exactly 90,000, and the screen then said nothing was left.

## Safety

- Never paste the seed, a viewing key, the operator token or the passphrase into chat, issues or screenshots.
- Mainnet needs `--allow-mainnet` and `ZECDROP_CONFIRM_MAINNET=I-UNDERSTAND`; this runbook does not use it. A mainnet run is in
  [`mainnet-run.md`](mainnet-run.md).
- If a batch is stuck, restart the operator with the same passphrase: the engine resumes from its ledger and re-sends the
  stored bytes; it never rebuilds the transaction.
- The audit and key-export commands print no key. The store, the seed file and the registry are mode 0600.
- The shielded deposit addresses' wallets live under `<state-dir>/inbox/` (0700 directories). Their databases hold the inboxes'
  viewing keys, notes and amounts **unencrypted**: never paste or share them.
