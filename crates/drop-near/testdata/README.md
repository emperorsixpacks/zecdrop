# drop-near test data

| File | Source |
|---|---|
| `tokens-excerpt.json` | **Captured** from `GET https://1click.chaindefuser.com/v0/tokens` on 2026-10-07 (no auth). It has 6 of the 204 entries, unchanged: native ZEC, bridged ZEC on NEAR and Solana (to show `find_zec` must match blockchain `zec`), and USDC/wNEAR |
| `quote-dry-response.captured.json` | **Captured**: `POST /v0/quote` with `dry: true` and **no JWT**, on 2026-10-07. The server answered HTTP **201**. The request was EXACT_OUTPUT 545,000 zat of native ZEC to a dummy mainnet `t1` address (hash160 of all `0x11` bytes, no known key), paid from USDC on NEAR. A dry quote creates no deposit address and moves no funds. The server added the `appFees` entry itself |
| `quote-live-response.from-docs.json` | **Hand-written from the docs, not captured.** It is shaped like a non-dry quote response (with `depositAddress`), from docs.near-intents.org "Request a swap quote". No live quote was ever requested |
| `status-*.from-docs.json` | **Hand-written from the docs, not captured.** One file per documented status, from "Check swap execution status", plus one undocumented status to test the `Unknown` mapping |
