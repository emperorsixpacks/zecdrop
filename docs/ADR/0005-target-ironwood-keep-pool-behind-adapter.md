# 0005 — Target the Ironwood pool; keep the pool behind the adapter

Status: Accepted (supersedes the earlier "pool-agnostic design" draft, which assumed Orchard)
Date: 2026-10-07

## Context

NU6.3 introduces the Ironwood pool (ZIP-258, Draft) and forbids new value entering the Orchard pool. Verified from
the ZIP text and an explorer: NU6.3 is active on mainnet and testnet. **NU7 (ZIP-259, Draft) is already active on
public testnet** (activation 4,465,026; verified with a live `GetLightdInfo`: branch `77190ad9`), while mainnet is
still on NU6.3 (`37a5165b`) with no NU7 height set. NU7 brings per-pool action limits (ZIP-218: 330 actions per pool
per transaction and per block; from Zebra source, via the spike) and invalidates V4 transactions.

## Decision

New outputs go to Ironwood. Pool selection stays inside `drop-zcash` and `drop-verify`; the planner, ledger,
engine, receipt and UI see only `shielded_actions` and a `pool` field (`ironwood` | `orchard`). The batch size
limit is a caller parameter, never a baked-in constant.

## Consequences

- A further pool or limit change touches `drop-zcash` and `drop-verify`, not `drop-core` or the UI.
- Testnet and mainnet are on different upgrades today. The builder must pick the branch id from the live tip and
  network parameters, and must be tested at both a testnet NU7 height and a mainnet NU6.3 height. Mainnet may move
  to NU7 later; re-check before any mainnet run.
- `max_outputs_per_batch` must stay at or below 330 on networks with NU7 active (a constant in one place).
- `drop-core` fee math takes a `FeePolicy`: the ZIP-317 text says 5000 zat per action, while Zebra main
  (`zebra-chain/src/transaction/unmined/zip317.rs`) uses `MARGINAL_FEE = 1_000`.
