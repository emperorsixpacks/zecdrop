# Tasks — near-funding

- [x] Confirm ZEC appears in `GET /v0/tokens`; record its asset id in `docs/LEARNINGS.md`
- [x] Library: dry quote first, a live request only constructible from a matching dry response (REQ-FUND-001, crate `drop-near`)
- [x] Operator wiring: dry quote, then live quote, to the campaign's transparent address (REQ-FUND-001) — verified: mainnet-only gates (testnet campaigns get 409 not_applicable), dry before live, confirmation header, no JWT leak; the live-quote and status calls have NEVER been exercised against the real service (mainnet needed), shapes come from the docs
- [x] Status parsing with all 7 documented states plus Unknown (never treated as success)
- [x] Operator wiring: status polling (SUCCESS reads as 'verify on chain', never 'funded'; unknown reads as 'investigate')
- [x] Mark Funded only on observed UTXO (REQ-FUND-002)
- [x] Manual-funding path remains the default
