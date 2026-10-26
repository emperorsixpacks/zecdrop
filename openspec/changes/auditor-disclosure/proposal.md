# auditor-disclosure

## Why
An auditor must be able to confirm that recipients were paid what the manifest says, without spend authority and
without seeing other campaigns.

## What
One ZIP-32 account per campaign; export that account's UFVK; a **local** audit mode that decrypts the campaign's
outputs and checks them against the manifest and the public totals.

## Approach
Audit runs in the local binary (`drop-operator audit --ufvk …`), never on the hosted verifier. It recovers outputs
via the OVK, sums them, compares to the public net-into-pool, and recomputes the salted manifest commitment.

## Risks
Disclosure is irreversible and reveals addresses, amounts and memos of that account (see `PRIVACY_BOUNDARY.md` §7).
The UI must say so before export.
