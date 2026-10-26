# Tasks — auditor-disclosure

- [x] One ZIP-32 account per campaign (REQ-AUD-002) — verified on the real transaction: account 0 recovers 3 of 3, accounts 1 and 2 recover 0
- [x] UFVK export with an explicit irreversible-disclosure warning (route needs the confirmation header; `export-ufvk` CLI)
- [x] Local audit command: recover outputs, sum, compare (REQ-AUD-001) — verified on the real testnet tx via `audit-tx`: exit 0, 3 of 3, 60000 = public net, reconciled
- [x] Manifest commitment recomputed from recovered outputs (REQ-AUD-003) — verified live: full `audit` on the 8-recipient campaign: 8 of 8 rows confirmed, commitment recomputed equals the receipt's
- [ ] Audit page in `web/` that talks only to the local operator
- [x] Negative test: UFVK of campaign A recovers nothing from campaign B (accounts 1 and 2 recover 0 of 3 on the real transaction)
