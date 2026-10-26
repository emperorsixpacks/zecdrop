# Operator API goldens (real-chain mode)

Responses of `drop-operator` running over the real Zcash backend (an in-memory node and
test-only keys), pinned by `crates/drop-operator/tests/api_contract.rs`. The test fails when the
operator's answer drifts from these files; after an intended change, rewrite them with

    UPDATE_GOLDEN=1 cargo test -p drop-operator --test api_contract

`index.json` lists every file with the request, the HTTP status and what the state means. Files
hold the response body only. Values that would be random or derived from a key are replaced by
obvious placeholders (campaign id `c-000000000001`, `created_at` 1700000000, commitment `e0e0...`,
funding address `tFAKE...`, outpoint `cdcd...:0`, viewing key `uviewFAKE...`); no real address or
key is written, and the test fails if one would be.

These complement the mock-chain captures one directory up (`scripts/capture-operator-fixtures.mjs`),
which cannot show non-null `funding_address` / `funding_progress`, a wallet that does not match,
or the real-mode errors.
