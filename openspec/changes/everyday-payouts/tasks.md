# Tasks — everyday-payouts

Tick only after the work is verified (tests run, behaviour probed). Evidence goes after "— verified:".

## web: a list without a file
- [ ] L1 The people list on the payouts step: address, amount, note; add and remove; row problems; import kept (REQ-IMP-002)
- [ ] L2 Split a total evenly (exactly equal shares) or at random (exact sum, at least half an even share, never all equal) (REQ-IMP-002)
- [ ] L3 Practice mode fills the list with the example people; the campaigns page and the home page stop asking for a CSV

## operator: payslips for the payer's page
- [ ] S1 Issue a settled campaign's payslips from the stored transaction bytes, sharing the CLI's matching (REQ-PAY-005)
- [ ] S2 `GET /api/campaigns/{id}/payslips`: disclosure header, mock chain and unsettled refused, payout-list order, nothing logged (REQ-PAY-005)
- [ ] S3 The contract captures and goldens include the route; the practice server answers it like the mock operator

## web: payslips on the payer's screen
- [ ] P1 A Payslips section on a settled campaign: ask, list, send one person's payslip as a link or a QR code, hide again (REQ-PAY-005)

## docs
- [ ] X1 `docs/PRIVACY_BOUNDARY.md`, `web/DESIGN.md`, `docs/runbooks/mainnet-run.md`; the tour's pictures retaken
- [ ] X2 README, `docs/JUDGES.md`, the submission description (with the docs patch that waits for the site's redeploy)
