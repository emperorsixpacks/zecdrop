# payslips

## Why
A batch's receipt proves totals and a recipient can read their own output, but a recipient has no way to show a third party
("a landlord, a bank, an auditor") that one output of one public transaction paid them a stated amount without handing over
a viewing key, which would reveal everything the key opens. Payroll, remittances and grants all need that proof, and it is
the part of ZecDrop that no other private-payment tool in this track is likely to offer.

## What
A **payslip** is a small JSON document for one output: the transaction id, the output's action index, the recipient's Orchard
receiver, the amount and the note's `rseed`. Anyone can check it against the chain with no key: the check rebuilds the note
with the action's own `rho` and the bundle's note version and compares its commitment with the `cmx` the transaction
publishes. A match shows that this action's output note is exactly (receiver, amount); it shows nothing about any other output.

- the operator issues the payslips of a campaign from the campaign key, locally (`drop-operator payslips`);
- anyone checks one offline (`drop-operator verify-payslip`), and the hosted verifier checks one on request (`POST /v1/payslip`,
  REQ-VER-006) for the people who accept its cost, below;
- the public receipt page has a box to check a payslip.

## Approach
`drop-verify` gets the key-less check and the `Payslip` type; `drop-zcash` (which holds keys) issues payslips from a UFVK or a
recipient's own IVK, and runs every payslip it issues through the verifier's own check before returning it. The verifier's
dependency closure does not change (REQ-VER-002 stays true: no key crate, no storage crate).

## Scope decisions
- **A payslip is a bearer document and it opens the memo.** The `rseed` fixes the note's ephemeral key (ZIP 212), so whoever
  holds a payslip can read that one output's memo as well as the receiver and amount. A hosted check therefore shows the verifier
  all of that. The operator's offline `verify-payslip` has no such cost, and the page says so next to the box. The hosted check
  keeps REQ-VER-002 ("holds no keys") true but is a new kind of request, so it is its own requirement, with a negative test that
  nothing of the payslip is logged or echoed.
- **Not built:** a check in the browser (WASM), a payslip without the memo (it would need the commitment's randomness instead of
  the `rseed`, which the pinned `orchard` crate does not expose), proof that the presenter controls the receiver, and payslips for
  batches paid before this change from a viewing key the operator no longer has.
- The pinned crates are pre-release (`NoteVersion::V3`, ZIP 2005): a final specification could change the check.

## Risks
- Users may read a payslip as proof of identity or of unspent funds. The check's answer and the page list what it does not prove.
- A service that checks payslips holds secrets for as long as it takes to answer: the hosted check must not log or echo the body.
