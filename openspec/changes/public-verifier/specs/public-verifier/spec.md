# public-verifier

### REQ-VER-001 — Recompute public totals from chain data
Status: implemented
The verifier SHALL, for every batch, resolve input values and check `t_in = t_out + net_into_pool + fee` with
`fee ≥ 0`, and SHALL report a mismatch as a failed batch rather than hiding it. It SHALL report the fee and SHALL
NOT assert that the fee equals a fixed per-action rate (librustzcash charges 5,000 per action, Zebra's mempool needs
1,000). It SHALL NOT claim that the shielded value reached third parties; that is the auditor's check.

### REQ-VER-002 — The verifier holds no keys
Status: implemented
The hosted verifier SHALL NOT depend on the crate that decodes or holds viewing and spend keys and unified addresses
(`zcash_keys`) or on any storage or password-encryption crate, and SHALL reject any request that carries a viewing
key. Transitive protocol libraries (`orchard`, `sapling-crypto`, `zip32`) necessarily remain because they parse
transactions; they contain key types, but no application code passes keys into them. A structural test SHALL assert
the dependency closure (`cargo metadata`), and a negative test SHALL show a UFVK-shaped input is refused and never
logged.

### REQ-VER-003 — Confirmation depth
Status: implemented
A batch SHALL be reported final only at or above a configured confirmation depth; below it, it SHALL be reported as
pending, and the campaign SHALL NOT be reported Settled.

### REQ-VER-004 — Receipts are bound to a funding address
Status: implemented
The verifier SHALL derive, for every batch, the transparent address its input spends from, SHALL return the single
common address as `funding_address` (null when it cannot be established), and SHALL report a `mixed_funding_sources`
finding, which fails the receipt, for every batch whose address differs from the first known one. `campaign_id`
SHALL remain documented as an unverified label. A batch funded from a campaign's change address therefore reads as
mixed; the funding-split design never chains from change.

