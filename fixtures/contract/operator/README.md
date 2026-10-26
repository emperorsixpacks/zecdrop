# Operator API fixtures

Real responses from `drop-operator --mock-chain`, captured by
`scripts/capture-operator-fixtures.mjs`. Do not edit by hand: regenerate with

    cargo build -p drop-operator
    node scripts/capture-operator-fixtures.mjs          # rewrite
    node scripts/capture-operator-fixtures.mjs --check  # verify they are current

`index.json` lists every response file with its request and HTTP status.
`csv/` holds the SENTINEL inputs (fake addresses, amounts and memos). The web
tests parse every file here with strict schemas and assert that no sentinel
address, amount or memo appears in any response.

Random values are normalised so reruns are byte-identical: campaign ids
(`c-000000000001`, ...), txids (`a0a0...`, `a1a1...`) and manifest commitments
(`e0e0...`, ...), each in order of first appearance; `created_at` becomes
1700000000 + (campaign number - 1). List responses are sorted by id, because the
server returns campaigns created in the same second in arbitrary order. The
funding txid (`cdcd...`) is chosen by the script.

`golden/` is NOT written by this script. The operator's own Rust test
(`crates/drop-operator/tests/api_contract.rs`) writes it: the real handlers
answering for an in-memory real-chain backend, so it holds the shapes only a real
chain produces. No real node has been involved. This script leaves it alone.

Not capturable with the mock chain: the run states `halted` and `stalled` and
the batch state `failed` (taken from the Rust source), and everything only a real
chain produces, which is in `golden/`: a non-null `funding_address` and
`funding_progress`, `wallet_matches: false`, the answer of `audit-ufvk-export`
(`warning`, `campaign_id`, `network`, `ufvk`), and the errors
`needs_funding_split`, `wrong_wallet_seed`, `chain_unavailable`,
`confirmation_required` and `dev_only`. On the mock chain a campaign always has
`wallet_matches: true`, `funding_address: null` and `funding_progress: null`, and
`funding_source` is null unless `fund-observed` declared one (`fund-declared-source.json`).
None of these shapes has been seen from a real node.
