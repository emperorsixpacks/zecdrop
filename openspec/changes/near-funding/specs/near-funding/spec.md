# near-funding

### REQ-FUND-001 — Quote to the transparent campaign address
Status: implemented
Funding via NEAR Intents SHALL request a dry quote before a real one, SHALL set the recipient to the campaign's
transparent address, and SHALL handle every documented status (PENDING_DEPOSIT, KNOWN_DEPOSIT_TX, PROCESSING,
SUCCESS, INCOMPLETE_DEPOSIT, REFUNDED, FAILED).

### REQ-FUND-002 — Funded only when seen on chain
Status: implemented
A campaign SHALL be marked Funded only when the funding UTXO is observed on chain at the required depth, never
solely because the swap API reports SUCCESS.
