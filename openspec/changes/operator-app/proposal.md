# operator-app

## Why
The operator holds the money and the secrets. Its defaults and storage decide whether the privacy story is real.

## What
`drop-operator`: local HTTP API + embedded web UI; wallet seed handling; encrypted local store (campaigns, manifest,
ledger); SSE progress; testnet-by-default network handling; the sandbox build used for the hosted demo.

## Approach
Bind to loopback with a per-run bearer token. Seed and recipient list encrypted at rest with a passphrase. The
sandbox build uses a throwaway testnet key with a spend cap and says so in the UI.

## Risks
KDF parameters and local-API auth are open items in `docs/SECURITY.md`.
