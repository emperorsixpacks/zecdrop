# Two-minute demo video — script and shot list

**Status: DRAFT (rewritten 2026-10-23 around one payout, four views; the payer's funding step made real on 2026-10-24).** No mainnet run will be made (owner, final), so this is
the one script. Keep claims inside `docs/PRIVACY_BOUNDARY.md`, say plainly what is real and what is practice, and never show
practice footage while describing the real run.

Goal: in 2:00 a judge sees one payout from the four sides that matter, knows what is real (a real payout on Zcash public
testnet, its live receipt, its payslips, its audit) and what is a simulation (practice mode, for the payer's screens), and
hears the honest limits.

## The script: one payout, four views

What is real: the 8-person testnet payout of 2026-10-24 that was funded through its own shielded deposit address (campaign
`c-6207fac6674f`, batch `af8adf80e3a58378…`, `fixtures/testnet-ironwood-batch-8-inbox/`), its funding screen on the real
operator, its live receipt, its payslips and its audit. What is practice: building the payout list, in practice mode, which says
so on every screen. Lines in [brackets] mean "run live on camera".

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:12 | A public payout list (an explorer page of an airdrop, amounts sorted), then the home page headline | "A public payout publishes who got how much. A private wallet hides the amounts, the total too. ZecDrop does neither: one payout, four views." |
| 0:12–0:22 | **You, the payer.** Practice mode, banner in view: add the people (a *Lucky* split), check them | "This is practice mode, a simulation of the operator. On my own computer the operator holds the keys and sees every address, amount and note." |
| 0:22–0:42 | **Still the payer, now real.** The real operator on testnet (see "The funding scene"): *Is it funded?* with the payout's own shielded address and its QR code; the status line counting confirmations; "Moving…"; then "Funded. Moved here from this payout's shielded address." | "This part is real, on Zcash testnet. The payout has a shielded address of its own. I pay it from my shielded wallet; a few minutes later ZecDrop moves exactly the funding to the public address, and checks that transaction before sending it. My wallet never pays a public address. One transaction pays all eight." |
| 0:42–1:00 | **Everyone.** The live receipt of that payout, phone width (see "The receipt scene"): Settled, 8 payouts, the total and the fee, "Deposit out of the shielded pool" | "Anyone can open its receipt: a verifier that holds no key recomputed the total and the fee from the chain, and saw the deposit came out of the shielded pool. Who got what stays hidden." |
| 1:00–1:20 | **One person.** The payslip page: the real payslip, *Verified* [live]; the copy with one digit changed, refused | "Each person can prove their own payout with a payslip, to a landlord or a bank, and it says nothing about anyone else. Change one digit and it fails." |
| 1:20–1:42 | **An auditor.** The home page sheet switched to *Auditor*; then the terminal audit of the real run: "8 of 8 public actions", "RESULT: reconciled" [live] | "The auditor I choose gets this payout's viewing key, and no other. They reconcile every line against the public total." |
| 1:42–2:00 | The band *Who sees what*; a caption: Zcash testnet, not audited; the repo URL | "One payout, four views: private amounts, public accountability. It runs on Zcash testnet and has not been audited. ZecDrop, for the Shielded Payments track." |

## The funding scene

Film the real operator's funding screen for a fresh testnet payout, following `docs/runbooks/testnet-demo.md`, "Funding through
the shielded deposit address": the screen with the shielded address and its QR code, the status line while the payment
confirms (10 blocks, about 5 to 15 minutes on testnet), "Moving…" after the random wait, and the funded line. Cut the waits;
say on camera that they were cut. Never film the operator's link (its token is in the `#` part), the terminal that starts it,
or the payer's wallet commands.

## The receipt scene

The hosted verifier is deployed (a teammate's VPS, checked 2026-10-16), so the receipt can be a live lookup. Say which it is
on camera; never imply a live chain lookup when it is the bundled copy.

- **Testnet live lookup of the payout funded through its shielded address** (the caption "Deposit out of the shielded pool"
  needs the redeployed verifier; the older one leaves the caption out):
  `https://zecdrop-site.vercel.app/r/c-6207fac6674f?network=testnet&tx=af8adf80e3a58378d4ed4852cfbbb035be5dbd4bde65dab732fa3bf95cd64a12&commitment=ca5ccacaaa467610fb8c0e1a36c364429c9ff91f17403a34ea679292fd73803f&declared_total=500000`.
  The page reads "Settled: 8 payouts, 0.005 TAZ, fee 0.00045 TAZ".
- **Testnet live lookup of the first 8-person batch** (2026-10-08, funded from transparent coins; the payslip page's samples
  are this batch's):
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
