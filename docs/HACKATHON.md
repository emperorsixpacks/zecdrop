# ZECATHON — rules, submission checklist, open questions

Source: rules text and submit-form screenshot supplied by the project owner (2026-10-07).
The official site, <https://thezecathon.com/>, keeps its rules, tracks and schedule behind a sign-in wall. Its public page
(read 2026-10-16) confirms only this: a Zcash privacy hackathon, a 30-day build, a $100,000 prize pool, 5 tracks, one account
per project, and submissions sealed until judging. It does **not** state the track names or prizes, the deadline, the
submission requirements, the team rules or the judging criteria, so everything below about those is still from the owner's
screenshot and **unverified**. Re-check the deadline and the rules inside the signed-in area before submitting.

## Rules (as supplied)

1. One person registers and submits; the prize goes to that account. Building with others is allowed.
2. All code is written during the build window. Libraries are fine; existing products are not.
3. Open source at submission. A private repo made public on Oct 28 counts.
4. One submission per account, entered in exactly one track.
5. Submissions stay sealed until judging opens; editable until the deadline.
6. Organisers and judges cannot enter.

## Deadline

**Oct 28, 2026 · 23:59 UTC** (submit form). The owner's target is to submit around **Oct 25-26**.

## Track

**Shielded Payments** ($15,000; also eligible for the $20,000 Grand Prize).
Track text: "Point of sale, payroll, remittance, subscriptions. Money that moves without publishing who paid whom."

## Submit-form checklist

| Field | Status | Notes |
|---|---|---|
| Registered | done | |
| Project name (≤ 64 chars) | decided | `ZecDrop` (confirmed by the owner) |
| Track | open | Shielded Payments |
| Description | draft | `docs/submission/description.md`, refreshed 2026-10-20; the repository and video links are still blank |
| Code repository | open | `JemIIahh/zecdrop`, private until the public flip; `main` holds all the current work, merged through pull requests (#2 and #3, 2026-10-19); PR #4 (a list without a spreadsheet, payslips on the payer's screen, personal and organisation views) is open; the live site was redeployed from `main` on 2026-10-20 |
| A working demo | partly | site live at <https://zecdrop-site.vercel.app> and checked on 2026-10-16: a shareable link (in `docs/JUDGES.md`) asks the hosted key-less verifier, which a teammate runs on a VPS (`deploy/vps/`), and shows the real 8-payout receipt live. The VPS must stay up through judging. A hosted operator sandbox is not built, see ADR 0002 |
| A two-minute demo video | script ready | `docs/submission/video-script.md`; not recorded |
| Repo public by Oct 28 | open | tick the box; run the pre-flip checklist below |
| Project submitted | open | |

## Pre-flip checklist (before making the repo public)

- [x] No seeds, mnemonics, UFVKs, JWTs or `.env` in any commit (full history scanned 2026-10-15: only placeholder test keys and "TEST ONLY" test seeds; the only tracked dotfile is `web/.env.example`). Re-scan after any new commit.
- [x] README says all code was written in the build window.
- [ ] `PROVENANCE.md` present for generated code (present in `web/` and `crates/drop-chain/`); no file copied from another project (the owner confirms this one).
- [x] LICENSE-MIT and LICENSE-APACHE present.
- [x] README commands work from a clean clone (2026-10-16, a fresh clone of `main` at `9714d8a`: fmt, clippy, 642 Rust tests, spec drift 29 of 29, web install, lint, typecheck, 1882 unit tests and build all passed; the Playwright e2e suite was not part of this run).

## Open questions

- Judging criteria: the owner believes none are published. Treat them as **unknown**; optimise for what the
  submit form asks for (working demo, two-minute video, description, public repo).
- Whether a **testnet** demo is acceptable is **unknown**; the supplied rules do not forbid it. Build
  testnet-first. Without published criteria, plan a small mainnet run only if time allows after the demo is solid.
- Testnet ZEC is **not needed yet**. The owner will supply it when the first live run needs it (after the spike).
- A competing submission, "ZPayroll" (private payroll on Orchard), was reported by one search summary.
  Unverified. Positioning is "verifiable confidential payouts", not payroll.
