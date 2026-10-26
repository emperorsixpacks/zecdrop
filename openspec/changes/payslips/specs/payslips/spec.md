# payslips

### REQ-PAY-001 — A payslip proves one output and no other
Status: implemented
Given a transaction and a payslip, the check SHALL succeed only if the transaction's id is the payslip's, the payslip names an
action that exists in its Ironwood bundle, and the note rebuilt from the payslip's receiver, amount and `rseed` (with the
action's own `rho` and the bundle's note version, neither chosen by the payslip) has the commitment the action publishes. It
SHALL need no key, SHALL fail on any change to the amount, receiver, `rseed`, action index or transaction id, and SHALL NOT
learn anything about any other output. The check's errors SHALL be fixed text that echoes nothing of the payslip, and a negative
test SHALL show that no other recipient's address or amount appears in a payslip or in any answer.

### REQ-PAY-002 — Payslips are issued locally, only from a key that opens the output
Status: implemented
The operator SHALL issue a payslip for every Ironwood output of a campaign's confirmed batches that the campaign's key opens,
SHALL verify each payslip with the key-less check before writing it, SHALL write one owner-only file per payout row and print
no address, amount, memo or key, and SHALL refuse a campaign of another network than the one it was started for. A recipient
SHALL be able to issue their own payslips from their own incoming viewing key.

### REQ-PAY-003 — A payslip can be checked offline
Status: implemented
The operator binary SHALL check a payslip against a transaction given as a file, with no store, no key and no node, and
SHALL state what a successful check does not prove. With a node it SHALL also report the confirmation depth with the receipt's
rule.

### REQ-VER-006 — The hosted verifier checks a payslip on request
Status: implemented
The hosted verifier SHALL answer a `POST /v1/payslip` with a JSON body of at most 1 KiB by running the key-less check and
reporting the outcome, the confirmation depth and what the check does not prove. It SHALL refuse anything but POST on that
route, SHALL refuse a body that carries a viewing-key marker, SHALL use the same limiter, timeout and lookup budget as receipts,
SHALL NOT log or echo the body, the receiver, the amount or the `rseed` (a negative test SHALL show none of them in any log line,
answer or error), and SHALL allow cross-origin POSTs only from the configured origin.
