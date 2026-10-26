# ZecDrop

**Private amounts. Public accountability.** Confidential batch payouts on Zcash.

Pay many people from one funded campaign. Anyone can verify, from chain data alone, how much was funded, how much
entered the shielded pool, in how many outputs, and what it cost. Nobody but each recipient (and an auditor
holding a viewing key) can see who got what, and only the auditor can confirm the outputs match the payout list.

> Built for **ZECATHON**, track **Shielded Payments**. **Status: under construction.** Nothing below is a
> finished feature unless it is marked *works today*.

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

Updated 2026-10-08. "Verified" means the lead ran the tests and probed the behaviour; nothing here has touched a
live network yet except read-only calls.

| Piece | State |
|---|---|
| Domain core (`drop-core`): money, CSV import, batch planner, fee policy, salted manifest commitment, resumable engine | built and tested |
| Ironwood batch builder (`drop-zcash`): one transparent input to N shielded outputs, decryptable by the campaign key | built, tested, and **accepted by public testnet** (one 3-recipient batch, mined at height 4,478,065; [ADR 0001](docs/ADR/0001-single-tx-transparent-to-ironwood-batches.md)) |
| Operator (`drop-operator`): local API, encrypted store, mock chain and real-chain mode | built; **ran the full 8-recipient demo on public testnet** (create, detect funding, prove, broadcast, 3 confirmations, settled in about 2 minutes; txid `6e2359182d1d…`) |
| Key-less verifier (`drop-verifier`) and public receipt page | built, hardened, container builds; the page shows demo data until a real receipt exists |
| Local audit command | built; reconciled the real 8-recipient campaign (8 of 8 outputs, total equals the public figure, salted commitment recomputed equals the receipt's) |
| NEAR Intents funding | library only (dry quotes); not wired into the operator; mainnet-only |
| Security review | one independent review done; fixes in progress ([`docs/SECURITY.md`](docs/SECURITY.md)) |

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

ZecDrop is a new implementation for Zcash,
written during the ZECATHON build window; third-party libraries are used as dependencies and generated code is
declared in `PROVENANCE.md` files.

## License

MIT OR Apache-2.0 — see [`LICENSE-MIT`](LICENSE-MIT) and [`LICENSE-APACHE`](LICENSE-APACHE).
