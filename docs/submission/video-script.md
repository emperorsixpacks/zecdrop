# Two-minute demo video — script and shot list

**Status: DRAFT, ready to record.** The live run exists (txid `6e2359182d1dc772…`, see `docs/runbooks/testnet-demo.md`); the public
sample page `/r/demo?demo=real` shows it. Lines in [brackets] mean "re-run live on camera". Keep claims inside `docs/PRIVACY_BOUNDARY.md`.

Goal: a judge understands the product, sees it work on a real chain, and hears the honest limits, in 2:00.

| Time | Screen | Voice-over (about 150 words per minute) |
|---|---|---|
| 0:00–0:15 | Title, then a public block-explorer page of a normal airdrop with a sorted amounts column | "Every public airdrop publishes a list of who got how much. That list becomes a targeting database. ZecDrop pays many people from one funded campaign without publishing that list." |
| 0:15–0:35 | Operator wizard: paste the demo CSV; the review step shows batch table, totals, fee and the privacy warnings | "The operator runs locally and holds the keys. I import eight payouts. Before sending, ZecDrop shows what the public will be able to infer. It also warns when amounts would be derivable, for example a batch of one." |
| 0:35–1:00 | Fund step with the campaign's transparent address; the faucet or an exchange sends; the progress bar fills [live] | "The campaign has its own address. Funding is public, which is what makes the total accountable. Now one transaction per batch: transparent funds in, shielded outputs out." |
| 1:00–1:25 | Public receipt page for the real transaction [live], opened on a phone-width window | "Anyone can open this page. It recomputes, from chain data alone, how much entered the shielded pool, how many outputs, and the fee. It does not claim the money reached different people. That needs the auditor." |
| 1:25–1:45 | Terminal: `recipient_view` prints one recipient's amount and memo and notes it cannot see the others [live] | "A recipient decrypts only their own amount and memo. On testnet, released wallets cannot sync yet, so I show it with our own tool." |
| 1:45–2:00 | Local audit output: count and sum match, manifest commitment matches [live]; closing card with repo URL | "An auditor with a campaign viewing key checks count and sum against the payout list. Private amounts, public accountability. ZecDrop, for the Shielded Payments track." |

## Prepare before recording

- A funded campaign address, the demo CSV (`examples/demo-recipients.testnet.csv`), a second browser profile for the public page.
- Pre-run once off-camera to warm the proving key (first build is slower) and to know the real timings: expect about
  1.25 s of proving per payout, so 8 payouts take about 10 s.
- Use a small window zoom so text is legible at 720p. Hide bookmarks, tokens and any terminal history with keys.
- Never show the seed file, a viewing key, the operator token or the passphrase. Blur the URL fragment of the operator link.

## Cut list if time runs over

Drop the closing explorer comparison first, then the recipient step (keep it in the README).
