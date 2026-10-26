# Submission description (draft)

**Status: DRAFT, refreshed 2026-10-24.** The shielded deposit address ran on public testnet on 2026-10-24 (below). The first testnet run was done on 2026-10-08; the requirement and test counts were re-checked on 2026-10-24 on the branch that adds the shielded deposit address (`feat/shielded-inbox`), and the live site and the hosted verifier after the redeploy on 2026-10-20 (every check of `check-hosted.mjs` passed: the real receipt settled, the real payslip verified, a changed copy refused). Remaining [brackets] are links; delete a sentence rather than overclaim. Project name: **ZecDrop** (64 characters maximum). Track: **Shielded Payments**.

## One-line

Confidential batch payouts on Zcash: everyone can check the total, each person can prove their own payout, and only the
auditor you choose sees the list.

## Short (about 600 characters)

ZecDrop pays many people in one shielded Zcash transaction, then gives each party its own view of it. Everyone can check
the total, the fee and the count from chain data, with a verifier that holds no key, and can see whether the deposit came
out of the shielded pool. Each person paid can prove their own payout with a payslip, and nobody else's. An auditor you
choose gets that payout's viewing key and reconciles the whole list. A payer can fund it from a shielded wallet through the
payout's own shielded address. Only the payer's own computer holds the keys. Built in Rust on librustzcash with a React
interface; runs end to end on public testnet.

## Long

**The problem.** A public airdrop or payout publishes its allocation list. Sorting it by amount gives attackers a
ready-made target list. Existing private payment tools hide everything, which makes a payout impossible to account for.

**One payout, four views.** ZecDrop gives every party exactly the view it needs of the same transaction. *Everyone*: the
total, the fee, how many were paid and whether the deposit came out of the shielded pool, from the receipt link, with no key.
*Each person paid*: their own payout, proved to anyone with a payslip that says nothing about the others. *An auditor you
choose*: the whole list of that payout, with its viewing key, which opens no other payout. *You, the payer*: everything, on
your own computer, where the keys stay.

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
carry IDs and are tied to tests by a drift check: all 50 are implemented and each has a covering test (773 Rust tests; 2,963
web unit tests and 579 tests in a real browser). The web app (React, Tailwind) has no wallet connection on purpose: the operator
holds the keys on the user's own machine, and the public site holds none: it checks receipts and payslips, helps a recipient
share an address, and simulates a payout (below). Funding from another coin through NEAR Intents is an optional stretch, wired into the operator.

**Demonstrated.** A real 8-recipient campaign ran end to end on public Zcash testnet through the operator: funding detected from
chain, proof (about 20 s), broadcast, three confirmations, settled in about two minutes. Transaction `6e2359182d1dc772…` (height
4,478,289). A separate key-less verifier recomputed the public totals from chain data (0.005 TAZ into the shielded pool in 8
outputs, 0.00045 TAZ fee, one funding address) and rejects a wrong declared total. The local audit reconciled all 8 outputs
against the payout list and the salted commitment, and each recipient's key decrypted exactly its own payout. On 2026-10-24 the
same 8 recipients were paid by a payout funded through its own shielded address, with nothing done by hand: the payer paid that
address shielded to shielded, the operator moved exactly the funding (`6e677bc5…`), and the batch `af8adf80…` settled. A freshly
started verifier answers it settled, *shielded*, with no findings; its 8 payslips verify; the audit reconciles 8 of 8; and the
payout's viewing key opens none of the transactions into or out of the shielded address. A send-back of what was left over, on a
second payout, reached the payer's shielded wallet. A mainnet run has not been done.

**Payslips.** A recipient can prove one output of a public batch to a third party without a viewing key and without revealing any
other recipient. A payslip carries the transaction id, the output's position, the recipient's receiver, the amount and the note's
secret; the key-less check rebuilds the note and compares its commitment with the one the transaction publishes. The eight payslips
of the real testnet batch each open exactly their own output (a test checks them against the transaction as mined), and the
verifier, run locally against public testnet, answered one as verified and a copy with one zatoshi changed as invalid. A payslip
is a bearer document and also opens its output's memo, so a hosted check shows the verifier the receiver, the amount and the memo's
key; the offline command does not.

**What the deposit spent.** The campaign's deposit address is transparent on purpose: the public deposit is the checkable total.
What the deposit spends is the payer's choice. Paid from a shielded balance, it names no address of theirs; paid from a
transparent one, that address is public and tied to the campaign for good. The operator's funding screen asks for a shielded
deposit and says which kind arrived, and the public receipt says it too (`funding_source`), read by the key-less verifier from the
deposit transaction itself and stated by kind only, never the address. The amount and the time stay public either way. On our real
testnet runs the verifier answers *shielded* for the first batch, funded straight from the testnet faucet's shielded wallet, and
*transparent* for the 8-recipient batch, funded from a sweep of the first batch's change.

**A shielded address for each payout.** On testnet the operator can also give each payout a shielded address of its own (a
zcash-devtool wallet per payout, run as a separate process and built from upstream with our own patch). The payer pays it from a
shielded wallet, in one payment or several. Once the payment is confirmed, after a random wait, the operator moves exactly the
funding to the payout's public address, in one transaction it checks from its raw bytes before storing and sending it: its shape,
its fee, and that what it spends equals what it pays plus the fee and any change. The payer's wallet never pays a public address,
the public step is made by ZecDrop rather than by their wallet, and anything left over can be sent back to a shielded address.
The payout's viewing key, the auditor's, sees none of it. What it does not hide: the total is public by design, so a payer who
shields exactly that amount just before paying can still be matched by amount and time; the random wait helps, it does not hide.

**Everyday use.** Two ways in: *Personal* (money home to family, gifts, a shared pot) and *Organisation* (payroll, grants,
airdrops), each showing only what that payer needs. A personal payer needs no spreadsheet: they type the people they pay one at a
time and can split a total evenly or as a "lucky split" of random shares, which, unlike equal shares, cannot be worked out from
the public total; the page writes the same list the importer reads, so the importer stays the one check. Once a payout is
settled, the payer's own screen gives each person their payslip as a link or a QR code, issued by the operator from the
transaction it stored before broadcast (checked against the real 8-recipient testnet campaign: 8 of 8 verify). The screens are
made for a phone first. A recipient who has never used Zcash opens the site's "get paid" page:
it names one wallet, says which address to copy, checks the shape of the address in the browser (the shape only) and offers to
share it; it makes no request and stores nothing. The operator shows each deposit as a QR code holding the funding address and
the exact amount, for a phone wallet to scan. A payslip can be sent as a link or a QR code; the payslip sits after the link's `#`,
which a browser never sends to a server. Anyone can press "Try a personal payout" or "Try an organisation payout" on the site and run the operator's own screens
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
Released wallets probably cannot sync current testnet, so the recipient side is shown with our own tool, and the shielded
address was paid from a zcash-devtool wallet of our own. The shielded address runs on testnet only; its wallet database (its
viewing keys, notes and amounts) is protected by file permissions, not encrypted like the operator's store. The hosted
verifier runs on a single teammate's server, so live receipt links and hosted payslip checks depend on that server and on the
public testnet node it reads; the same verifier is in the repository and runs from one Docker command.

**Links.** Repository: [url]. Demo: <https://zecdrop-site.vercel.app> (the public site: receipts, payslips, the get-paid page and practice mode; [this link](https://zecdrop-site.vercel.app/r/real-8?network=testnet&tx=6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955&commitment=698ec02d7e72ec60a11f5a6e176288bf4a27e86304dfe75330bfb82051b976f8&declared_total=500000) checks the
real 8-recipient run live). Video: [url].

**Build window.** All code in this repository was written during the ZECATHON build window; third-party
libraries are dependencies, and generated or fetched protocol files are recorded in PROVENANCE.md files. zcash-devtool is not in
the repository: a script builds it from upstream source at a pinned commit, with a patch written for ZecDrop
(`scripts/zcash-devtool/PROVENANCE.md`).
