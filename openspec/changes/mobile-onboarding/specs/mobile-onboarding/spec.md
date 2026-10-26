# mobile-onboarding

### REQ-ONB-001 — The get-paid page keeps the recipient's address on the recipient's device
Status: planned
The "get paid" page SHALL check the shape of a pasted address and offer to share it entirely in the browser: it SHALL make no
request to any server, SHALL store nothing (no cookie, no local or session storage), SHALL say that its check is of shape only
and not a guarantee that the address is valid, and SHALL tell a person that a transparent address does not suit payouts. A
negative test SHALL show that no request is made and no storage is written when an address is pasted, checked and shared.

### REQ-FUND-003 — The funding QR code asks for exactly the deposit
Status: planned
Where the operator shows a campaign's funding address on a real chain, the page SHALL also show a QR code that encodes exactly the
ZIP-321 request the wallet link carries (the funding address and the required amount, nothing else), SHALL draw it dark on light in
both themes so a scanner can read it, and SHALL NOT show one when there is no funding address or the amount is not a positive whole
number of zatoshi. A test SHALL decode the rendered code and compare what it holds with the link.

### REQ-PAY-004 — A payslip link carries the payslip only in its fragment
Status: planned
A payslip link SHALL hold the payslip only after the `#` of the address, so that a browser does not send it to any server. The page
that opens such a link SHALL load the payslip into the paste box, SHALL remove the fragment from the address bar before anything
else happens, SHALL NOT check the payslip until the visitor asks, and SHALL say plainly that whoever holds the link holds the
payslip (its receiver, its amount and the key to its memo). A negative test SHALL show that the payslip appears in no request
address, no header, no storage and no log line, other than the body of the check the visitor asked for.

### REQ-DEMO-001 — Practice mode is simulated in the browser and says so on every screen
Status: planned
Practice mode SHALL run the operator's screens against a simulation inside the page. It SHALL make no network request to any
operator, verifier or node, SHALL keep its state in memory only, SHALL mark every screen as a simulation and never show a simulated
figure, id or address as if it were chain data, and SHALL leave nothing behind after the page closes except a flag saying it is on.
A negative test SHALL show that no request leaves the page during a whole practice payout.
