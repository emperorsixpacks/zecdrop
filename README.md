# ZecDrop

**Private amounts. Public accountability.** Confidential batch payouts on Zcash.

Pay many people from one funded campaign. Anyone can verify, from chain data alone, how much was funded, how much
entered the shielded pool, in how many outputs, and what it cost. Nobody but each recipient (and an auditor
holding a viewing key) can see who got what, and only the auditor can confirm the outputs match the payout list.

> Built for **ZECATHON**, track **Shielded Payments**. **Status: under construction.** Nothing below is a
> finished feature unless it is marked *works today*.

**Live demo:** <https://zecdrop-site.vercel.app> is the public receipt viewer, with the real 8-recipient testnet
receipt bundled as a sample. The operator, which holds the keys, runs on your own computer: there is no wallet to
connect. To test it yourself, see [`docs/JUDGES.md`](docs/JUDGES.md): check the real payout with the key-less verifier,
or run the whole flow on a fake chain. A real testnet run is in [`docs/runbooks/testnet-demo.md`](docs/runbooks/testnet-demo.md).

## How it works

Each batch is **one Zcash transaction**: transparent funds in → N shielded outputs (with memos) out, in the Ironwood pool (new value can no longer enter Orchard since NU6.3).
The protocol makes the *net value entering the shielded pool* public while every output stays encrypted, so:

| Public | Hidden |
|---|---|
| Funding address and total, per-batch totals, fee, txids, batch size | Recipient addresses, per-recipient amounts, memos |

An auditor receives a **per-campaign viewing key** and can decrypt that campaign only. A salted manifest
commitment on the public receipt lets the auditor check the payout list.

**Honest limits:** a batch of one reveals that person's amount, and equal payouts make every amount derivable
from the public total. ZecDrop avoids singleton batches and warns at review time.
Read the full list in [`docs/PRIVACY_BOUNDARY.md`](docs/PRIVACY_BOUNDARY.md).

## Architecture

```
operator (local, holds keys)  ──►  Zcash network  ◄──  verifier (hosted, no keys)  ──►  public receipt page
        ▲                                                       ▲
   web UI + auditor (local)                              anyone, e.g. a judge
```

Rust workspace on `librustzcash` (`drop-core`, `drop-zcash`, `drop-chain`, `drop-verify`, `drop-operator`,
`drop-verifier`) and a React web app in `web/`. Decisions are in [`docs/ADR/`](docs/ADR), requirements in
[`openspec/`](openspec). Optional funding from any asset via NEAR Intents is planned
([ADR 0004](docs/ADR/0004-near-intents-optional-funding.md)).

## Status

Updated 2026-10-18. "Verified" means the lead ran the tests and probed the behaviour. The public testnet runs are
listed in the table below; no transaction has been sent to mainnet.

| Piece | State |
|---|---|
| Domain core (`drop-core`): money, CSV import, batch planner, fee policy, salted manifest commitment, resumable engine | built and tested |
| Ironwood batch builder (`drop-zcash`): one transparent input to N shielded outputs, decryptable by the campaign key | built, tested, and **accepted by public testnet** (one 3-recipient batch, mined at height 4,478,065; [ADR 0001](docs/ADR/0001-single-tx-transparent-to-ironwood-batches.md)) |
| Operator (`drop-operator`): local API, encrypted store, mock chain and real-chain mode | built; **ran the full 8-recipient demo on public testnet** (create, detect funding, prove, broadcast, 3 confirmations, settled in about 2 minutes; txid `6e2359182d1d…`) |
| Key-less verifier (`drop-verifier`) and public receipt page | built, hardened, container builds. The public site is live at <https://zecdrop-site.vercel.app> and shows the real 8-recipient receipt from a bundled capture. The hosted verifier runs on a teammate's VPS ([`deploy/vps/`](deploy/vps/README.md)); checked 2026-10-16, a live receipt link for the real batch loads on the site and shows it settled |
| Local audit command | built; reconciled the real 8-recipient campaign (8 of 8 outputs, total equals the public figure, salted commitment recomputed equals the receipt's) |
| Payslips (`drop-verify`, `drop-zcash`, `drop-operator`, `drop-verifier`) | built and tested: one recipient's proof of one output, checkable by anyone with no key. The eight payslips of the real testnet batch verify in CI against the transaction as mined, and the verifier, run locally against public testnet, answered one as verified and a changed copy as invalid. A payslip also opens its output's memo ([`docs/PRIVACY_BOUNDARY.md`](docs/PRIVACY_BOUNDARY.md), "Payslips") |
| Mainnet | the code runs on mainnet behind `--allow-mainnet`, a confirmation variable, a 0.1 ZEC cap per campaign and start-up checks of the node (network, upgrade, Ironwood tree); tested offline at mainnet parameters and read-only against the real mainnet node's data. **No mainnet payout has been made yet** ([`docs/runbooks/mainnet-run.md`](docs/runbooks/mainnet-run.md)) |
| NEAR Intents funding | wired into the operator: a live price preview works on testnet (a dry quote, creates nothing); the mainnet quote and status paths are built and tested with a fake service but **never exercised against the real one** |
| Security review | one independent review done; fixes in progress ([`docs/SECURITY.md`](docs/SECURITY.md)) |

Scale: one batch carries up to 330 payouts. Building and proving 330 payouts took 2 minutes 22 seconds on a laptop, the
transaction is 1 MB, and the network fee is 0.01655 ZEC ([`docs/BENCHMARKS.md`](docs/BENCHMARKS.md)).

Known limits: campaigns larger than one batch need a funding-split step that is not built; released wallets probably
cannot sync current testnet (NU7), so the recipient side is shown with our own tooling.

## Develop

```bash
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
python3 -I scripts/spec_drift.py
cd web && npm ci && npm run lint && npm run typecheck && npm test && npm run build
```

Contributor and agent rules: [`AGENTS.md`](AGENTS.md). Testnet by default. Not audited; do not use with
significant funds.

## Demo data

`examples/demo-recipients.testnet.csv` lists eight testnet addresses that belong to the project's own throwaway dev
wallet, with their amounts and memos. It is public on purpose, so anyone can reproduce the demo. That means the demo
campaign's hidden amounts are not secret; it demonstrates the mechanism, not privacy for these particular payouts.
No key material is in the repository.

## Build window

ZecDrop was written during the ZECATHON build window; third-party libraries are used as dependencies and generated
code is declared in `PROVENANCE.md` files.

## License

MIT OR Apache-2.0 — see [`LICENSE-MIT`](LICENSE-MIT) and [`LICENSE-APACHE`](LICENSE-APACHE).
