# near-funding

## Why
Operators hold many assets, not only ZEC. Funding from any asset removes a manual swap step (stretch; ADR 0004).

## What
In the operator: quote → deposit address → status polling via the NEAR Intents 1Click API, with the destination
set to the campaign's **transparent** address.

## Approach
`GET /v0/tokens` to discover the ZEC asset id at runtime; `POST /v0/quote` with `dry: true` first; poll
`GET /v0/status`. Funded means the UTXO is observed on chain.

## Scope decision
Stretch. Cut first if the schedule slips. Not claimed as a Cross-Chain submission.

## Risks
ZEC may not be listed; JWT needed; third-party availability.
