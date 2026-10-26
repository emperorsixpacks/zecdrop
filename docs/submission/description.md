# Submission description (draft)

**Status: DRAFT, refreshed 2026-10-15.** The testnet run below was done on 2026-10-08; the test counts and the live site were re-checked on 2026-10-15. Remaining [brackets] are links only; delete a sentence rather than overclaim. Project name: **ZecDrop** (64 characters maximum). Track: **Shielded Payments**.

## One-line

Confidential batch payouts on Zcash: private amounts, public accountability.

## Short (about 600 characters)

ZecDrop pays many people from one funded campaign in a single shielded transaction per batch. Anyone can verify from
chain data how much entered the shielded pool, in how many outputs, and at what fee. Only each recipient, and an
auditor holding a per-campaign viewing key, can see who got what. The operator runs locally and holds the keys; a
separate key-less verifier serves a public receipt page. Built in Rust on librustzcash with a React interface.

## Long

**The problem.** A public airdrop or payout publishes its allocation list. Sorting it by amount gives attackers a
ready-made target list. Existing private payment tools hide everything, which makes a payout impossible to account for.

**What ZecDrop does.** One transaction per batch spends transparent funds into shielded outputs with memos. The
protocol makes the net value entering the shielded pool public and every output amount hidden, so a key-less
verifier can recompute `funded = change + shielded + fee` from chain data alone. An auditor with the campaign's
viewing key recovers every output and checks the count and the sum against the public figures and against a salted
commitment to the payout list.

**What it does not claim.** The public cannot tell that outputs reached distinct third parties; only the auditor can.
A batch of one reveals that person's amount, and equal payouts make every amount derivable, so the planner avoids
singleton batches and the review step warns. The recipient count of a batch is public. Details:
`docs/PRIVACY_BOUNDARY.md`.

**How it is built.** Rust workspace on librustzcash: a chain-agnostic domain core with a resumable, crash-safe
engine; a local operator service with an encrypted store; a transaction builder using the Ironwood pool; a key-less
verifier whose dependency closure is checked by a test to contain no key-decoding or storage crate. Requirements
carry IDs and are tied to tests by a drift check in CI: all 29 are implemented and covered by tests. The web app (React, Tailwind)
has no wallet connection on purpose: the operator holds the keys on the user's own machine, and the public site only views
and checks receipts. Funding from another coin through NEAR Intents is an optional stretch, wired into the operator.

**Demonstrated.** A real 8-recipient campaign ran end to end on public Zcash testnet through the operator: funding detected from
chain, proof (about 20 s), broadcast, three confirmations, settled in about two minutes. Transaction `6e2359182d1dc772…` (height
4,478,289). A separate key-less verifier recomputed the public totals from chain data (0.005 TAZ into the shielded pool in 8
outputs, 0.00045 TAZ fee, one funding address) and rejects a wrong declared total. The local audit reconciled all 8 outputs
against the payout list and the salted commitment, and each recipient's key decrypted exactly its own payout. A mainnet run has
not been done.

**Honest limits.** Not audited (one independent code review was done; see `docs/SECURITY.md`). Testnet-first; nothing has
run on mainnet. Campaigns larger than one batch need a funding-split step that is not built. NEAR Intents funding shows a
live price preview on testnet and creates nothing; its mainnet quote and status paths have only run against a fake service.
Released wallets probably cannot sync current testnet, so the recipient side is shown with our own tool. The public site
answers the real receipt from a bundled copy, because the hosted verifier is not deployed yet; the verifier itself is in the
repository and builds as a container.

**Links.** Repository: [url]. Demo: <https://zecdrop-site.vercel.app> (the public receipt viewer; open the sample receipt for
the real 8-recipient run). Video: [url].

**Build window.** All code in this repository was written during the ZECATHON build window; third-party
libraries are dependencies, and generated or fetched protocol files are recorded in PROVENANCE.md files.
