# ZECATHON — rules, submission checklist, open questions

Source: rules text and submit-form screenshot supplied by the project owner (2026-10-07).
The official site is behind a sign-in wall; nothing here was read from it directly.

## Rules (as supplied)

1. One person registers and submits; the prize goes to that account. Building with others is allowed.
2. All code is written during the build window. Libraries are fine; existing products are not.
3. Open source at submission. A private repo made public on Oct 28 counts.
4. One submission per account, entered in exactly one track.
5. Submissions stay sealed until judging opens; editable until the deadline.
6. Organisers and judges cannot enter.

## Deadline

**Oct 28, 2026 · 23:59 UTC** (submit form). Internal target: submitted by **Oct 21**.

## Track

**Shielded Payments** ($15,000; also eligible for the $20,000 Grand Prize).
Track text: "Point of sale, payroll, remittance, subscriptions. Money that moves without publishing who paid whom."

## Submit-form checklist

| Field | Status | Notes |
|---|---|---|
| Registered | done | |
| Project name (≤ 64 chars) | decided | `ZecDrop` (confirmed by the owner) |
| Track | open | Shielded Payments |
| Description | draft | `docs/submission/description.md`, refreshed 2026-10-15; the repository and video links are still blank |
| Code repository | open | `JemIIahh/zecdrop`, private until the public flip; `main` is still the initial import, the work is on `near-funding-and-redesign` |
| A working demo | partly | site live at <https://zecdrop-site.vercel.app> and checked on 2026-10-16: a shareable link (in `docs/JUDGES.md`) asks the hosted key-less verifier, which a teammate runs on a VPS (`deploy/vps/`), and shows the real 8-payout receipt live. The VPS must stay up through judging. A hosted operator sandbox is not built, see ADR 0002 |
| A two-minute demo video | script ready | `docs/submission/video-script.md`; not recorded |
| Repo public by Oct 28 | open | tick the box; run the pre-flip checklist below |
| Project submitted | open | |

## Pre-flip checklist (before making the repo public)

- [x] No seeds, mnemonics, UFVKs, JWTs or `.env` in any commit (full history scanned 2026-10-15: only placeholder test keys and "TEST ONLY" test seeds; the only tracked dotfile is `web/.env.example`). Re-scan after any new commit.
- [x] README says all code was written in the build window.
- [ ] `PROVENANCE.md` present for generated code (present in `web/` and `crates/drop-chain/`); no file copied from another project (the owner confirms this one).
- [x] LICENSE-MIT and LICENSE-APACHE present.
- [ ] README commands work from a clean clone.

## Open questions

- Judging criteria: the owner believes none are published. Treat them as **unknown**; optimise for what the
  submit form asks for (working demo, two-minute video, description, public repo).
- Whether a **testnet** demo is acceptable is **unknown**; the supplied rules do not forbid it. Build
  testnet-first. Without published criteria, plan a small mainnet run only if time allows after the demo is solid.
- Testnet ZEC is **not needed yet**. The owner will supply it when the first live run needs it (after the spike).
- A competing submission, "ZPayroll" (private payroll on Orchard), was reported by one search summary.
  Unverified. Positioning is "verifiable confidential payouts", not payroll.
