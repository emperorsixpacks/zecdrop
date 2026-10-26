# campaign-core

## Why
Everything else depends on a chain-agnostic domain: strict money handling, import, batch planning, a resumable
engine and a receipt type that cannot leak. It must be testable without a node.

## What
`drop-core`: zatoshi amounts, CSV import, batch planner (with singleton avoidance), ZIP-317 fee math, salted
manifest commitment, ledger, resumable engine, public receipt type, privacy warnings, campaign phases.

## Approach
Ports (`Distributor`, `Ledger`, `AddressCodec`) keep the crate free of zcash dependencies; `drop-zcash` implements
them. The engine is a headless state machine that emits serializable progress events, so the UI never owns
execution state and resume derives from ledger + chain.

## Out of scope
Anything that touches keys, transactions or the network (see `spike-single-tx-builder`, `operator-app`).

## Risks
The batch-size ceiling comes from relay policy and proving cost and is unknown until the spike; the planner takes
it as a parameter.
