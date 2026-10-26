# Tasks — mobile-onboarding

Tick only after the work is verified (tests run, behaviour probed). Evidence goes after "— verified:".

## web: the get-paid page
- [x] G1 `/get-paid`: wallet, address, shape check, share; no request and no storage (REQ-ONB-001) — verified: unit tests spy on fetch, XMLHttpRequest, sendBeacon, WebSocket, Image, window.open, storage, cookies, history and the console while an address of every shape is pasted and shared; the e2e counts the requests the loaded page makes (none) under the hosted CSP; the classifier is tested at every edge length, in odd characters and with fuzzed input; phone width, both themes, axe clean

## web: scan to fund, share proof
- [x] Q1 A QR code for the funding request beside the funding address (REQ-FUND-003) — verified: the code is decoded with a reader that did not make it (jsQR, from the SVG's own modules and from real screenshots at 360 and 1280 px, both themes) and equals the wallet link exactly, testnet and mainnet; absent on the mock chain, for an amount of 0 and without an address; black on white in every theme; the library loads only when a code is first drawn; axe clean
- [x] Q2 Payslip as a link and a QR code; the fragment is read once and removed (REQ-PAY-004) — verified: strict decoding (alphabet, canonical spelling, size cap, UTF-8, then the payslip reader); the fragment leaves the address bar and the history entry before any child effect runs, also for a bad link; the payslip is in no storage, console, request address or header, and opening a link never calls fetch (spies in jsdom, a recording server in e2e); the link is not in the page until asked; the QR decodes to the link; mutation checks on the load-bearing lines each failed a named test

## web: practice mode
- [x] D1 A simulated operator in the page behind a visible practice flag; labelled on every screen; no network (REQ-DEMO-001) — verified: the negative test was written first and the design built to pass it (spies on fetch, XMLHttpRequest, sendBeacon, WebSocket, EventSource, IndexedDB and cookies: no call leaves the page, the only storage write is the flag in sessionStorage); one injection point (sendToApi) and no patch of window.fetch; the simulation answers every request of the operator's captured contract with the same statuses, bodies and settled event stream, read by the screens' own strict parsers; simulated ids begin with the bytes of "practice" and get no explorer link; the real operator session is kept apart from the stand-in and the page's cached operator answers are cleared on entry; the hosted CSP is unchanged and a whole practice payout runs under it; mutation checks on the load-bearing lines each failed a named test
- [x] D2 A whole practice payout at phone width, from the home page to the simulated receipt — verified: Playwright at 360 and 1280 px, both themes, banner, axe, no ZEC amount and no overflow on every screen, keyboard-only run, reload starts over, leaving removes everything; also walked by hand at 390 px

## docs
- [ ] X1 `docs/JUDGES.md`, README, the submission description (`docs/PRIVACY_BOUNDARY.md` covers payslip links since Q2)
