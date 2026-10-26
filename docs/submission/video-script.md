# Two-minute demo video — script and shot list

**Status: DRAFT (refreshed 2026-10-18). Two versions.** Use **B** if the real mainnet payout happened and a recipient's wallet
showed it (`docs/runbooks/mainnet-run.md`); otherwise use **A**. Keep claims inside `docs/PRIVACY_BOUNDARY.md`, say plainly
what is real money and what is not, and never show footage of the practice chain while saying "mainnet".

Goal: a judge understands the product, sees it work with real money in a real wallet, and hears the honest limits, in 2:00.

## Version B — with the real mainnet payout (about 235 words)

| Time | Screen | Voice-over (about 150 words per minute) |
|---|---|---|
| 0:00–0:12 | Title, then a public block-explorer page of an airdrop with a sorted amounts column | "A public payout publishes who got how much. Sorted by amount, that list is a target list. Zcash can hide it, but then nobody can check the payout was honest." |
| 0:12–0:30 | Operator, local, the real mainnet run: "Add the payouts", then "Check the payouts" with the totals, the fee and the privacy notes | "ZecDrop runs on my own computer, so there is no wallet to connect and the keys never leave it. I paste the payouts. Before anything is sent it shows what the public will be able to infer, and warns me when a batch is too small to hide amounts." |
| 0:30–0:58 | The same run: the "Zcash mainnet" header, the campaign's own address, the deposit arriving, "Send 3 payouts" and the sheet with the tick, the timeline to Complete (cut the waiting) | "This is mainnet and real money, a few cents. The campaign has its own address. Funding is public, which is what makes the total checkable. One transaction pays everyone: ZecDrop builds it, checks it itself, and sends it. A few confirmations later, it is complete." |
| 0:58–1:18 | The phone, screen-recorded: the recipient's wallet showing the incoming payment and its memo | "On my phone, Zodl shows my payout and its memo. It cannot show anyone else's. Only a recipient, and an auditor holding the campaign's viewing key, can read an amount." |
| 1:18–1:38 | The public receipt for the mainnet batch on the live site, phone-width window (see "The receipt scene") | "Anyone can open this link. A verifier that holds no keys reads the chain and works out how much entered the shielded pool, in how many outputs, and what it cost. It does not claim the money reached different people." |
| 1:38–1:53 | Terminal: the local audit, count and sum match, the commitment matches [and, only if payslips are built, a payslip checked on the site] | "An auditor with the viewing key checks the count and the sum against the payout list and the commitment on the receipt." [Add only if built: "A recipient can also prove their own payout with a payslip, without revealing anyone else's."] |
| 1:53–2:00 | Closing card with the repository address | "Private amounts, public accountability. ZecDrop, for the Shielded Payments track." |

Say once, in words or as a caption, that the deposit and the total are public by design and that ZecDrop is not audited.

## Version A — testnet only (fallback)

The live run exists (txid `6e2359182d1dc772…`, see `docs/runbooks/testnet-demo.md`). The public site
<https://zecdrop-site.vercel.app> shows it as the bundled sample receipt at `/r/demo?demo=real`. Lines in [brackets] mean
"re-run live on camera".

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:15 | Title, then a public block-explorer page of a normal airdrop with a sorted amounts column | "Every public airdrop publishes a list of who got how much. That list becomes a targeting database. ZecDrop pays many people from one funded campaign without publishing that list." |
| 0:15–0:35 | Operator, local: "Add the payouts" with the demo CSV, then "Check the payouts" with the batch table, totals, fee and the privacy notes | "The operator runs on my own machine and holds the keys. There is no wallet to connect. I import eight payouts. Before sending, ZecDrop shows what the public will be able to infer, and warns when amounts would be derivable, for example a batch of one." |
| 0:35–1:00 | Funding step: the campaign's transparent address, Copy address, the deposit arriving [live]; then "Send 8 payouts" and the sending timeline filling | "The campaign has its own address. Funding is public, which is what makes the total accountable. Now one transaction per batch: transparent funds in, shielded outputs out." |
| 1:00–1:25 | Public receipt, phone-width window: the live link or the sample (see "The receipt scene") | "Anyone can open this page. It shows, from chain data, how much entered the shielded pool, how many outputs, and the fee. It does not claim the money reached different people. That needs the auditor." |
| 1:25–1:45 | Terminal: `recipient_view` prints one recipient's amount and memo and notes it cannot see the others [live] | "A recipient decrypts only their own amount and memo. On testnet, released wallets cannot sync yet, so I show it with our own tool." |
| 1:45–2:00 | Local audit output: count and sum match, manifest commitment matches [live]; closing card with the repo URL | "An auditor with a campaign viewing key checks count and sum against the payout list. Private amounts, public accountability. ZecDrop, for the Shielded Payments track." |

## The receipt scene

The hosted verifier is deployed (a teammate's VPS, checked 2026-10-16), so the receipt can be a live lookup. Say which it is
on camera; never imply a live chain lookup when it is the bundled copy.

- **Mainnet (Version B):** open the link the run produced:
  `https://zecdrop-site.vercel.app/r/mainnet-run?network=mainnet&tx=<txid>&commitment=<commitment>&declared_total=<zat>`. It
  needs the verifier to serve mainnet (`deploy/vps/README.md`). Open it once before recording. The page reads "Settled" with the
  payouts and the fee in ZEC.
- **Testnet live lookup:** open the shareable link for the real batch:
  `https://zecdrop-site.vercel.app/r/real-8?network=testnet&tx=6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955&commitment=698ec02d7e72ec60a11f5a6e176288bf4a27e86304dfe75330bfb82051b976f8&declared_total=500000`. Say "this page just asked
  the verifier, which read the chain." The page reads "Settled: 8 payouts, 0.005 TAZ, fee 0.00045 TAZ".
- **Copy (fallback if the verifier is unreachable):** open `https://zecdrop-site.vercel.app/r/demo?demo=real` and say "this is
  a saved copy of the verifier's answer for the real transaction."

## Prepare before recording

- **Version B:** screen-record the real run as it happens (the operator window only, not the browser chrome: the operator's
  token is in the address bar), and the phone's screen while the payment arrives (Do Not Disturb on, no notifications from
  other apps; hide the wallet's balance if it offers that; use a harmless memo text). The recovery phrase never appears.
  Recipient addresses are public receiving addresses and may show; amounts of the other recipients are not on the phone.
- **Version A:** a funded campaign address, the demo CSV (`examples/demo-recipients.testnet.csv`), a second browser profile for
  the public page. Pre-run once off-camera to warm the proving key (the first build is slower): proving took about 20 s for 8
  payouts, and the batch settled about two minutes after the send (testnet blocks are about 25 s apart). Do not wait for
  confirmations on camera: cut to the timeline's end state.
- Mainnet blocks are about 75 s apart, so depth 3 takes about four minutes: cut it.
- Use a small window zoom so text is legible at 720p. Hide bookmarks, tokens and any terminal history with keys.
- Never show the seed file, a viewing key, the operator token or the passphrase. Keep the URL fragment of the operator link out of
  frame.
- Footage of the practice chain (the fake one the guided tour uses) is for the tour and for Version A's operator scenes only,
  and only if the voice-over says it is a practice run. It must not stand in for the mainnet run.

## Cut list if time runs over

Drop the opening explorer page first, then the audit scene (keep it in the README). The optional NEAR Intents funding row is
not in the script on purpose: on testnet it only shows a price preview, and the mainnet quote and status paths have never run
against the real service. Mention it only in the description, with that limit.
