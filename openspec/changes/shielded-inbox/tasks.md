# Tasks — shielded-inbox

Tick only after the work is verified (tests run, behaviour probed). Evidence goes after "— verified:".

## build and keys
- [ ] B1 zcash-devtool built from upstream `b532d4cd` with ZecDrop's own patch; the operator refuses an unpatched binary (REQ-FUND-005)
- [ ] B2 Each inbox's phrase and the identity it is encrypted to, derived from the operator's seed, pinned by test vectors; the wallet set up from them on stdin and checked before its address is shown (REQ-FUND-005, REQ-PRIV-004)

## the move and send-back
- [ ] M1 The check of every inbox transaction, from its raw bytes: shape, fee, value conservation (REQ-FUND-006, REQ-FUND-007)
- [ ] M2 Checkpoint A: a real inbox on testnet, paid from a shielded wallet, moved by hand through the check, funds a real payout
- [ ] M3 The operator's inbox engine: setup, sync, the move's timing and guards, one move per inbox stored before broadcast, re-sent, rebuilt only after expiry, final once mined (REQ-FUND-006)
- [ ] M4 Send-back (REQ-FUND-007)

## operator API and web
- [ ] A1 `inbox` on the campaign answer, read from memory; the send-back route; error codes; goldens (REQ-FUND-008)
- [ ] W1 The funding screen leads with the inbox and says what it holds; the public address as the fallback (REQ-FUND-008)

## real run and docs
- [ ] R1 A real 8-person testnet payout funded through the inbox: receipt `shielded`, payslips verify, the audit reconciles, the payout's viewing key cannot see the inbox (REQ-PRIV-004)
- [ ] X1 ADR 0006, PRIVACY_BOUNDARY, SECURITY, AGENTS (invariant exceptions, the devtool build), README, JUDGES, the testnet runbook, DESIGN, LEARNINGS, PROVENANCE, the video script
