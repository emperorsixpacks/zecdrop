# operator-app

### REQ-SEC-001 — Seed never leaves the process
Status: implemented
The seed and spend-key types SHALL NOT implement `Serialize` or `Debug`-print their contents and SHALL be zeroized on
drop. A negative test SHALL show no seed bytes in any API response or log line.

### REQ-SEC-002 — Local store encrypted at rest
Status: implemented
Recipient lists, memos and the manifest salt SHALL be stored encrypted with a key derived from a passphrase. A
negative test SHALL show sentinel addresses and amounts are absent from the raw store file.

### REQ-OPS-001 — Testnet by default
Status: implemented
The operator SHALL default to testnet and SHALL require an explicit flag (`--allow-mainnet`) and a confirmation (the
environment variable `ZECDROP_CONFIRM_MAINNET`) to run on mainnet, and SHALL refuse the mock chain and a seed file on
mainnet.

### REQ-OPS-002 — Local API is not exposed
Status: implemented
The operator API SHALL bind to loopback and require a per-run bearer token; requests without it SHALL be refused. Inside a
container, and only when told it runs in one (`--container`, testnet only), it MAY bind the container's own unspecified address,
for a port published on the host's loopback address only (REQ-RUN-001, amended by `run-it-yourself`).
