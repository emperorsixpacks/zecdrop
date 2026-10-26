# Tasks — everyday-payouts

Tick only after the work is verified (tests run, behaviour probed). Evidence goes after "— verified:".

## web: a list without a file
- [x] L1 The people list on the payouts step: address, amount, note; add and remove; row problems; import kept (REQ-IMP-002) — verified: the text the page writes reads back through the practice port of the importer exactly (notes with commas, quotes, a semicolon and other scripts); the whole app with the captured operator answers: add, remove, focus and the spoken line, problems on the field once left and all of them on Continue (nothing sent), the operator's line errors on the person they are about; a negative test spies on the console, storage, the address bar and every request (only the create call carries the list, and the draft forgets it once the campaign exists); in a real browser against the real operator binary, three people typed in were taken by its importer as written (count and exact total), with no overflow and no axe violation at 320, 360 and 1280 px in both themes; the full Playwright run 553 passed
- [x] L2 Split a total evenly (exactly equal shares) or at random (exact sum, at least half an even share, never all equal) (REQ-IMP-002) — verified: even shares are exactly equal and the remainder left out is said on screen; lucky shares over 7 totals and 25 seeds each add up exactly, none under half an even share and never all equal (an all-equal draw is put right); the real operator gave no equal-amount warning for a lucky split
- [x] L3 Practice mode fills the list with the example people; the campaigns page and the home page stop asking for a CSV — verified: the practice unit and browser tests pass unchanged (the example list, then Continue, gives 8 people and the whole simulated payout); the empty campaigns page offers Start a payout; the home page and the tour say to type in who you are paying

## operator: payslips for the payer's page
- [ ] S1 Issue a settled campaign's payslips from the stored transaction bytes, sharing the CLI's matching (REQ-PAY-005)
- [ ] S2 `GET /api/campaigns/{id}/payslips`: disclosure header, mock chain and unsettled refused, payout-list order, nothing logged (REQ-PAY-005)
- [ ] S3 The contract captures and goldens include the route; the practice server answers it like the mock operator

## web: payslips on the payer's screen
- [ ] P1 A Payslips section on a settled campaign: ask, list, send one person's payslip as a link or a QR code, hide again (REQ-PAY-005)

## docs
- [ ] X1 `docs/PRIVACY_BOUNDARY.md`, `web/DESIGN.md`, `docs/runbooks/mainnet-run.md`; the tour's pictures retaken
- [ ] X2 README, `docs/JUDGES.md`, the submission description (with the docs patch that waits for the site's redeploy)
