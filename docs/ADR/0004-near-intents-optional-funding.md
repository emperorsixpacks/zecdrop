# 0004 — NEAR Intents is an optional funding path, not the headline

Status: Accepted (stretch scope)
Date: 2026-10-07

## Context

NEAR Intents' 1Click API can swap many assets into ZEC. Its chain-support page lists Zcash as
"Partially supported — transparent addresses only". Cross-Chain is a separate hackathon track.

## Decision

Offer "fund from any asset" as progressive enhancement: quote with `dry: true`, then a real quote whose
recipient is the campaign's **transparent** address, show the deposit address, poll status. A campaign is
**Funded only when the UTXO is observed on chain**, never because the swap API says `SUCCESS` (REQ-FUND-002).
Manual funding always works. Not part of the pitch's main claim.

## Consequences

- The funding leg is public and linkable (already public by design).
- A third-party dependency and a JWT (reduces fees by 0.25% per NEAR docs) for a stretch feature; it is cut first
  if time runs short.
- The ZEC asset id is discovered at runtime from `GET /v0/tokens`; unconfirmed whether it is listed today.
