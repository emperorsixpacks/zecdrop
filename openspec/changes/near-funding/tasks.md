# Tasks — near-funding

- [x] Confirm ZEC appears in `GET /v0/tokens`; record its asset id in `docs/LEARNINGS.md`
- [x] Library: dry quote first, a live request only constructible from a matching dry response (REQ-FUND-001, crate `drop-near`)
- [ ] Operator wiring: quote to the campaign's transparent address (REQ-FUND-001; REQ-FUND-001 stays `planned` until this exists)
- [x] Status parsing with all 7 documented states plus Unknown (never treated as success)
- [ ] Operator wiring: status polling
- [x] Mark Funded only on observed UTXO (REQ-FUND-002)
- [ ] Manual-funding path remains the default
