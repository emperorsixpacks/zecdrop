# Tasks — mobile-onboarding

Tick only after the work is verified (tests run, behaviour probed). Evidence goes after "— verified:".

## web: the get-paid page
- [x] G1 `/get-paid`: wallet, address, shape check, share; no request and no storage (REQ-ONB-001) — verified: unit tests spy on fetch, XMLHttpRequest, sendBeacon, WebSocket, Image, window.open, storage, cookies, history and the console while an address of every shape is pasted and shared; the e2e counts the requests the loaded page makes (none) under the hosted CSP; the classifier is tested at every edge length, in odd characters and with fuzzed input; phone width, both themes, axe clean

## web: scan to fund, share proof
- [ ] Q1 A QR code for the funding request beside the funding address (REQ-FUND-003)
- [ ] Q2 Payslip as a link and a QR code; the fragment is read once and removed (REQ-PAY-004)

## web: practice mode
- [ ] D1 A simulated operator in the page behind a visible practice flag; labelled on every screen; no network (REQ-DEMO-001)
- [ ] D2 A whole practice payout at phone width, from the home page to the simulated receipt

## docs
- [ ] X1 `docs/PRIVACY_BOUNDARY.md` (payslip links), `docs/JUDGES.md`, README, the submission description
