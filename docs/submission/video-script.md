# Two-minute demo video — script and shot list

**Status: DRAFT (rewritten 2026-10-23 around one payout, four views).** No mainnet run will be made (owner, final), so this is
the one script. Keep claims inside `docs/PRIVACY_BOUNDARY.md`, say plainly what is real and what is practice, and never show
practice footage while describing the real run.

Goal: in 2:00 a judge sees one payout from the four sides that matter, knows what is real (a real payout on Zcash public
testnet, its live receipt, its payslips, its audit) and what is a simulation (practice mode, for the payer's screens), and
hears the honest limits.

## The script: one payout, four views

What is real: the 8-person testnet batch of 2026-10-08 (txid `6e2359182d1dc772…`, `docs/runbooks/testnet-demo.md`), its live
receipt, its payslips and its audit. What is practice: the payer's screens, in practice mode, which says so on every screen.
Lines in [brackets] mean "run live on camera".

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:12 | A public payout list (an explorer page of an airdrop, amounts sorted), then the home page headline | "A public payout publishes who got how much. A private wallet hides the amounts, the total too. ZecDrop does neither: one payout, four views." |
| 0:12–0:40 | **You, the payer.** Practice mode, banner in view: add the people (a *Lucky* split), check them, the funding step with "Pay from your shielded balance", record the pretend deposit ("From the shielded pool (pretend)"), *Send 8 payouts*, the timeline | "This is practice mode, a simulation of the operator. On my own computer the operator holds the keys and sees every address, amount and note. It asks me to pay the deposit from my shielded balance, so the deposit names no address of mine. One transaction pays all eight." |
| 0:40–1:00 | **Everyone.** The live receipt of the real batch, phone width (see "The receipt scene"): Settled, 8 payouts, the total and the fee | "This one is a real payout on Zcash testnet. Anyone can open its receipt: a verifier that holds no key recomputed the total and the fee from the chain. Who got what stays hidden." |
| 1:00–1:20 | **One person.** The payslip page: the real payslip, *Verified* [live]; the copy with one digit changed, refused | "Each person can prove their own payout with a payslip, to a landlord or a bank, and it says nothing about anyone else. Change one digit and it fails." |
| 1:20–1:42 | **An auditor.** The home page sheet switched to *Auditor*; then the terminal audit of the real run: "8 of 8 public actions", "RESULT: reconciled" [live] | "The auditor I choose gets this payout's viewing key, and no other. They reconcile every line against the public total." |
| 1:42–2:00 | The band *Who sees what*; a caption: Zcash testnet, not audited; the repo URL | "One payout, four views: private amounts, public accountability. It runs on Zcash testnet and has not been audited. ZecDrop, for the Shielded Payments track." |

## The receipt scene

The hosted verifier is deployed (a teammate's VPS, checked 2026-10-16), so the receipt can be a live lookup. Say which it is
on camera; never imply a live chain lookup when it is the bundled copy.

- **Testnet live lookup:** open the shareable link for the real batch:
  `https://zecdrop-site.vercel.app/r/real-8?network=testnet&tx=6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955&commitment=698ec02d7e72ec60a11f5a6e176288bf4a27e86304dfe75330bfb82051b976f8&declared_total=500000`. Say "this page just asked
  the verifier, which read the chain." The page reads "Settled: 8 payouts, 0.005 TAZ, fee 0.00045 TAZ".
- **Copy (fallback if the verifier is unreachable):** open `https://zecdrop-site.vercel.app/r/demo?demo=real` and say "this is
  a saved copy of the verifier's answer for the real transaction."

## Prepare before recording

- **The payer (practice mode):** nothing to set up. Press *Try an organisation payout* on the home page, use the example list or
  a *Lucky* split in the personal view, and keep the practice banner in frame.
- **Everyone:** open the live receipt link once before recording (it should read "Settled: 8 payouts, 0.005 TAZ, fee 0.00045
  TAZ"); if the verifier is unreachable, use the saved copy and say so.
- **One person:** the payslip page loads the real payslip 3 with one button and a changed copy with another.
- **The auditor:** run the audit of `docs/runbooks/testnet-demo.md`, step 7, once before recording; on camera show its output
  only. The command reads the dev seed: never show the seed file, the viewing key or the command's environment.
- Use a small window zoom so text is legible at 720p. Hide bookmarks, tokens and any terminal history with keys.
- Never show the seed file, a viewing key, the operator token or the passphrase. Keep the URL fragment of an operator link out
  of frame.
- Footage of practice mode or the fake chain is for the payer's scene only, and only with the voice-over saying it is a
  simulation.

## Cut list if time runs over

Drop the opening explorer page first, then the terminal part of the audit scene (keep the *Auditor* view of the sheet). The optional NEAR Intents funding row is
not in the script on purpose: on testnet it only shows a price preview, and the mainnet quote and status paths have never run
against the real service. Mention it only in the description, with that limit.
