# Tasks — payslips

Tick only after the work is verified (tests run, behaviour probed). Evidence goes after "— verified:".

## drop-verify, drop-zcash
- [x] P1 `Payslip`, `verify_payslip`, `check_payslip` (key-less) (REQ-PAY-001) — verified: unit and integration tests on the real mined testnet batch and the fixtures (nothing made up opens any action; every changed field, action index and transaction id fails; no other recipient in a payslip or an answer); the verifier's dependency closure is unchanged (157, 250 and 225 packages) and the no-keys test passes
- [x] P2 `issue_payslips` (campaign UFVK) and `payslips_with_ivk` (a recipient's key), every payslip self-verified (REQ-PAY-002) — verified: 19 tests (a recipient issues their own; another campaign's key issues nothing; a one-recipient batch is padded and only the real output gets a payslip; the rseed opens that output's memo and no other)

## drop-operator
- [x] P3 `payslips --campaign <id> --out-dir <dir>`: confirmed batches only, one 0600 file per row, nothing printed (REQ-PAY-002) — verified: a settled campaign on the in-memory node gets one owner-only file per payout in payout order, each verifying with no key; nothing for a batch that is not final or over an existing directory; another seed or another network is refused; the output names no address, memo or amount
- [x] P4 `verify-payslip --tx <file> --payslip <file>`, optional node for the depth (REQ-PAY-003) — verified: the binary checks two files with no passphrase, store or node and lists what it does not prove; a changed payslip, another transaction, a junk file and an oversized file are refused with words that echo nothing; against a node a young batch is PENDING

## drop-verifier
- [x] P5 `POST /v1/payslip` (REQ-VER-006) — verified: in-process tests (verified, pending, not found, invalid; only POST with at most 1 KiB; no viewing key; the unconfigured network refused before any chain call; an outage is a 503; nothing of a payslip in any answer or log line; a JSON POST allowed cross-origin only from the configured origin)

## web
- [ ] P6 The receipt page's box: paste or load a payslip, a sample for the real testnet batch, what it does not prove, the cost of a hosted check

## docs
- [ ] P7 `docs/PRIVACY_BOUNDARY.md`: what a payslip reveals and proves; README, JUDGES, description
- [ ] P8 Demo payslips for the real 8-recipient testnet batch (throwaway dev keys)
