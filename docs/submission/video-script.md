# Two-minute demo video — script and shot list

**Status: DRAFT, ready to record (refreshed 2026-10-15).** The live run exists (txid `6e2359182d1dc772…`, see
`docs/runbooks/testnet-demo.md`). The public site <https://zecdrop-site.vercel.app> shows it as the bundled sample receipt at
`/r/demo?demo=real`. Lines in [brackets] mean "re-run live on camera". Keep claims inside `docs/PRIVACY_BOUNDARY.md`.

Goal: a judge understands the product, sees it work on a real chain, and hears the honest limits, in 2:00.

| Time | Screen | Voice-over (about 150 words per minute) |
|---|---|---|
| 0:00–0:15 | Title, then a public block-explorer page of a normal airdrop with a sorted amounts column | "Every public airdrop publishes a list of who got how much. That list becomes a targeting database. ZecDrop pays many people from one funded campaign without publishing that list." |
| 0:15–0:35 | Operator, local: "Add the payouts" with the demo CSV, then "Check the payouts" with the batch table, totals, fee and the privacy notes | "The operator runs on my own machine and holds the keys. There is no wallet to connect. I import eight payouts. Before sending, ZecDrop shows what the public will be able to infer, and warns when amounts would be derivable, for example a batch of one." |
| 0:35–1:00 | Funding step: the campaign's transparent address, Copy address, the deposit arriving [live]; then Start and the sending timeline filling | "The campaign has its own address. Funding is public, which is what makes the total accountable. Now one transaction per batch: transparent funds in, shielded outputs out." |
| 1:00–1:25 | Public receipt, phone-width window: the sample receipt on the live site (see "The receipt scene" below) | "Anyone can open this page. It shows, from chain data, how much entered the shielded pool, how many outputs, and the fee. It does not claim the money reached different people. That needs the auditor." |
| 1:25–1:45 | Terminal: `recipient_view` prints one recipient's amount and memo and notes it cannot see the others [live] | "A recipient decrypts only their own amount and memo. On testnet, released wallets cannot sync yet, so I show it with our own tool." |
| 1:45–2:00 | Local audit output: count and sum match, manifest commitment matches [live]; closing card with the repo URL | "An auditor with a campaign viewing key checks count and sum against the payout list. Private amounts, public accountability. ZecDrop, for the Shielded Payments track." |

## The receipt scene

The hosted verifier is deployed (a teammate's VPS, checked 2026-10-16), so the receipt can be a live lookup. Say which it is
on camera; never imply a live chain lookup when it is the bundled copy.

- **Live lookup (use this):** open the shareable link for the real batch:
  `https://zecdrop-site.vercel.app/r/real-8?network=testnet&tx=6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955&commitment=698ec02d7e72ec60a11f5a6e176288bf4a27e86304dfe75330bfb82051b976f8&declared_total=500000`. Say "this page just asked
  the verifier, which read the chain." The page reads "Settled: 8 payouts, 0.005 TAZ, fee 0.00045 TAZ". Open it once
  before recording to be sure the VPS is up.
- **Copy (fallback if the verifier is unreachable):** open `https://zecdrop-site.vercel.app/r/demo?demo=real` and say "this is
  a saved copy of the verifier's answer for the real transaction."

## Prepare before recording

- A funded campaign address, the demo CSV (`examples/demo-recipients.testnet.csv`), a second browser profile for the public page.
- Pre-run once off-camera to warm the proving key (first build is slower) and to know the real timings: proving took about
  20 s for 8 payouts, and the batch was settled about two minutes after Start (testnet blocks are about 25 s apart).
  Do not wait for confirmations on camera: cut to the timeline's end state.
- Use a small window zoom so text is legible at 720p. Hide bookmarks, tokens and any terminal history with keys.
- Never show the seed file, a viewing key, the operator token or the passphrase. Blur the URL fragment of the operator link.

## Cut list if time runs over

Drop the opening explorer page first, then the recipient step (keep it in the README).
The optional NEAR Intents funding row is not in the script on purpose: on testnet it only shows a price preview, and the
mainnet quote and status paths have never run against the real service. Mention it only in the description, with that limit.
