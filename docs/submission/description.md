# Submission description (draft)

**Status: DRAFT, refreshed 2026-10-20.** The testnet run below was done on 2026-10-08; the requirement and test counts were re-checked on 2026-10-20 from a clean checkout of `main` at `6f0b2b6`, and the live site and the hosted verifier after the redeploy on 2026-10-20 (every check of `check-hosted.mjs` passed: the real receipt settled, the real payslip verified, a changed copy refused). Remaining [brackets] are links; delete a sentence rather than overclaim. Project name: **ZecDrop** (64 characters maximum). Track: **Shielded Payments**.

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
carry IDs and are tied to tests by a drift check: all 41 are implemented and each has a covering test (702 Rust tests; 2,835
web unit tests and 546 tests in a real browser). The web app (React, Tailwind) has no wallet connection on purpose: the operator
holds the keys on the user's own machine, and the public site holds none: it checks receipts and payslips, helps a recipient
share an address, and simulates a payout (below). Funding from another coin through NEAR Intents is an optional stretch, wired into the operator.

**Demonstrated.** A real 8-recipient campaign ran end to end on public Zcash testnet through the operator: funding detected from
chain, proof (about 20 s), broadcast, three confirmations, settled in about two minutes. Transaction `6e2359182d1dc772…` (height
4,478,289). A separate key-less verifier recomputed the public totals from chain data (0.005 TAZ into the shielded pool in 8
outputs, 0.00045 TAZ fee, one funding address) and rejects a wrong declared total. The local audit reconciled all 8 outputs
against the payout list and the salted commitment, and each recipient's key decrypted exactly its own payout. A mainnet run has
not been done.

**Payslips.** A recipient can prove one output of a public batch to a third party without a viewing key and without revealing any
other recipient. A payslip carries the transaction id, the output's position, the recipient's receiver, the amount and the note's
secret; the key-less check rebuilds the note and compares its commitment with the one the transaction publishes. The eight payslips
of the real testnet batch each open exactly their own output (a test checks them against the transaction as mined), and the
verifier, run locally against public testnet, answered one as verified and a copy with one zatoshi changed as invalid. A payslip
is a bearer document and also opens its output's memo, so a hosted check shows the verifier the receiver, the amount and the memo's
key; the offline command does not.

**Everyday use.** The screens are made for a phone first. A recipient who has never used Zcash opens the site's "get paid" page:
it names one wallet, says which address to copy, checks the shape of the address in the browser (the shape only) and offers to
share it; it makes no request and stores nothing. The operator shows each deposit as a QR code holding the funding address and
the exact amount, for a phone wallet to scan. A payslip can be sent as a link or a QR code; the payslip sits after the link's `#`,
which a browser never sends to a server. Anyone can press "Try a practice payout" on the site and run the operator's own screens
against a simulation inside the page: nothing is sent anywhere, every screen says it is a simulation, and nothing in it is
evidence about any chain. The menu is one capsule at the top of the screen, and it always shows the network: quiet on testnet,
loud on mainnet, marked in practice mode. Checked in Chromium at phone width, down to 320 pixels, in light and dark; not yet tried
with a physical phone's camera, a real share sheet, a real wallet or a screen reader.

**Scale.** One batch carries up to 330 payouts. Creating the transaction for 330 payouts, including the zero-knowledge proof that
lets the network check it without seeing who gets what, took 142 seconds on a laptop; the transaction is 1 MB and
the network fee is 0.01655 ZEC (`docs/BENCHMARKS.md`).

**Honest limits.** Not audited (one independent code review was done; see `docs/SECURITY.md`). Testnet-first; no transaction has been
sent to mainnet. The code can run there behind an explicit gate, a 0.1 ZEC cap per campaign and start-up checks of the node, and is
tested offline at mainnet parameters and read-only against the real mainnet node's data, but that is not a payout. Campaigns larger than one batch need a funding-split step that is not built. NEAR Intents funding shows a
live price preview on testnet and creates nothing; its mainnet quote and status paths have only run against a fake service.
Released wallets probably cannot sync current testnet, so the recipient side is shown with our own tool. The hosted
verifier runs on a single teammate's server, so live receipt links and hosted payslip checks depend on that server and on the
public testnet node it reads; the same verifier is in the repository and runs from one Docker command.

**Links.** Repository: [url]. Demo: <https://zecdrop-site.vercel.app> (the public site: receipts, payslips, the get-paid page and practice mode; [this link](https://zecdrop-site.vercel.app/r/real-8?network=testnet&tx=6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955&commitment=698ec02d7e72ec60a11f5a6e176288bf4a27e86304dfe75330bfb82051b976f8&declared_total=500000) checks the
real 8-recipient run live). Video: [url].

**Build window.** All code in this repository was written during the ZECATHON build window; third-party
libraries are dependencies, and generated or fetched protocol files are recorded in PROVENANCE.md files.
