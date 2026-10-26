# security-review-fixes

## Why
An independent read-only review (2026-10-07) found no critical or high issues but several medium and low ones, some
confirmed by running the code. Two of them (stranded funds on exact funding, account reuse across stores) affect the
live demo and the product's own claims, so they are fixed before any public release.

## What
Fixes for the findings listed in `docs/SECURITY.md` ("Independent review"). This change adds no new requirement IDs:
each fix tightens an existing requirement (REQ-TX-001, REQ-AUD-002, REQ-SEC-001/002, REQ-OPS-002, REQ-VER-001/002,
REQ-RES-001, REQ-PRIV-001/002, REQ-IMP-001) and carries tests tagged with those IDs.

## Scope decisions
- Not fixed: a lying node or man-in-the-middle can fake a mismatch or a UTXO. This is the documented node-trust
  assumption (`docs/PRIVACY_BOUNDARY.md`); self-hosting the node is the mitigation.
- Not built: a hosted operator sandbox (see ADR 0002 and `docs/SECURITY.md`).
- The demo CSV is public by design; the README says the demo amounts are therefore not secret.

## Risks
Receipt binding (funding address in the public receipt) is a contract change: Rust goldens, the verifier and the web
schema must move together.
