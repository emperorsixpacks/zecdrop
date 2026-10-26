# campaign-core

### REQ-AMT-001 — Strict ZEC parsing and formatting
Status: implemented
The system SHALL parse decimal ZEC strings with at most 8 fractional digits into `Zatoshi(u64)` and SHALL reject
empty, negative, exponent-notation, 9+ decimal, separator-containing, non-ASCII-digit and over-`MAX_MONEY` input.
`format_zec` SHALL be the exact inverse of `parse_zec`.

### REQ-AMT-002 — Checked totals
Status: implemented
Sums of amounts SHALL use checked arithmetic; overflow or a total above `MAX_MONEY` SHALL be an error, never a
wrap or saturation.

### REQ-IMP-001 — CSV import reports every error
Status: implemented
CSV import SHALL require an `address,amount[,memo]` header, tolerate BOM, CRLF, quoted fields and `;` delimiters,
report **all** row errors with 1-based line numbers, reject duplicate addresses and memos over 512 bytes, and
SHALL NOT silently truncate or skip rows.

### REQ-PLAN-001 — Deterministic, lossless batching
Status: implemented
`plan_batches` SHALL place every recipient in exactly one batch, preserve input order, respect the per-batch
maximum, and produce batch totals that sum to the campaign total, deterministically.

### REQ-PLAN-002 — ZIP-317 fee estimate
Status: implemented
The fee SHALL equal `marginal_fee × max(grace_actions, logical_actions)` zatoshi, where both constants come from a
caller-supplied fee policy (the ZIP-317 text says 5000 and 2; Zebra main uses 1000 and 2), with logical actions
computed per ZIP-317 for the batch's shielded actions and transparent inputs/outputs. Test vectors SHALL cover both
policies.

### REQ-PLAN-003 — No singleton batches
Status: implemented
The planner SHALL NOT produce a batch of one recipient unless the whole campaign has one recipient, because the
public net value of such a batch equals that recipient's amount.

### REQ-MAN-001 — Salted manifest commitment
Status: implemented
The commitment SHALL be SHA-256 over a domain-separated, length-prefixed canonical encoding including a 32-byte
random salt; changing any row, order, salt or campaign id SHALL change it.

### REQ-LED-001 — Idempotent, conflict-safe ledger
Status: implemented
Recording the same built transaction twice SHALL be a no-op; recording a different transaction for a batch that is
already Built, Broadcast or Confirmed SHALL be rejected as a conflict.

### REQ-RES-001 — Resume never rebuilds or double-pays
Status: implemented
The engine SHALL persist a built transaction (txid and raw bytes) before broadcasting it and, after a crash, SHALL
re-broadcast the stored bytes rather than rebuild; Confirmed batches SHALL be skipped; the campaign SHALL be
Settled only when every batch has reached the required confirmation depth.

### REQ-PRIV-001 — Public receipt cannot carry recipient data
Status: implemented
The public receipt type SHALL have no field for recipient address, per-recipient amount or memo, and its JSON key
set SHALL equal an explicit allow-list (top level: campaign_id, network, funding_address, declared_total,
fee_total, batches, manifest_commitment, phase, findings; per batch: index, txid, funding_input, net_into_pool, fee,
shielded_actions, pool, confirmations). u64 amounts SHALL serialize as decimal strings.

### REQ-PRIV-002 — Redaction in Debug, Display, errors and events
Status: implemented
Recipient addresses and amounts SHALL NOT appear in `Debug`/`Display` output, error messages or progress events.

### REQ-PRIV-003 — Privacy warnings at review
Status: implemented
The review step SHALL surface warnings for single-recipient campaigns, uniform-amount batches, two-recipient
batches and campaigns under five recipients, carrying only batch index and counts.

### REQ-PHASE-001 — Campaign phases
Status: implemented
A campaign's phase (Draft, AwaitingFunding, Funded, Sending{done,total}, Settled, Failed) SHALL be derived from
ledger and funding state and have a user-language label.
