# Privacy boundary

What ZecDrop hides, what it does not, and who must be trusted. UI and README copy must match this file.
Status: the transaction shape is confirmed on public testnet (ADR 0001, 2026-10-08, txid
`50fb88e0…a3e3`). Not yet checked on mainnet, not independently audited.

## The mechanism in one paragraph

Each batch is one Zcash transaction: transparent inputs → N Ironwood outputs (+ transparent change).
The transaction exposes the **net value entering the Ironwood pool**; individual outputs stay encrypted.
With no real shielded spends in the batch, consensus forces `outputs + fee + change = inputs`.

## What the public can verify, and what only an auditor can

Source: the spike's measured results (`spikes/single-tx-builder/RESULTS.md`) and a real testnet batch whose public
totals the verifier recomputed from chain data (`fixtures/testnet-ironwood-batch/`).

**Anyone, from chain data alone:** how much transparent value left the funding address, that exactly that
amount minus the fee entered the shielded pool in this transaction (the binding signature makes the number
unforgeable), how many shielded outputs there are, the fee, and the change. These add up exactly:
`t_in = t_out + net_into_pool + fee`.

**Not the public:** that the shielded value reached *N distinct third parties* matching a payout list. A
payout to the operator's own address, an output built without the campaign's outgoing viewing key, or a
hidden shielded spend all look identical to the public. The public cannot tell a dummy spend from a real one.

**The auditor closes that gap.** With the campaign UFVK they recover every output and check that the count equals
the public action count and that the sum equals the public `net_into_pool`. Any mismatch means a hidden spend,
a hidden output or an unrecoverable output. This is why REQ-AUD-001 reports differences instead of rounding them
away.

**Possible hardening (not built):** setting `enableSpendsIronwood = 0` would let consensus *prove* a batch has no
shielded spends. It needs custom transaction assembly.

## Payslips: one recipient's proof of one output

A payslip lets one recipient show a third party that one output of a public transaction paid them an amount, without
a viewing key. It holds the transaction id, the position of the output in the transaction's Ironwood bundle, the
recipient's Orchard receiver, the amount and the note's `rseed`. Anyone can check it against the chain with no key: the
check rebuilds the note with the action's own `rho` and the bundle's note version and compares its commitment with the
one the transaction publishes (REQ-PAY-001). The operator issues payslips from the campaign's key (REQ-PAY-002); a recipient
can issue their own with their incoming viewing key.

**It proves** that action *i* of that transaction creates a note worth that amount for that receiver, and nothing about any
other output. **It does not prove** who the person is or that whoever presents it controls the receiver (a payslip is a
bearer document: anyone who holds it can present it); the memo (the commitment does not cover it); that the transaction is
mined or final (the check reports the confirmations); that the funds are unspent; or that the transaction belongs to a
given campaign (compare its id with the campaign's public receipt).

**It costs the recipient** more than it looks. The holder learns the receiver and the amount, and the `rseed` also fixes
the note's ephemeral key (ZIP 212), so **the holder can read that one output's memo as well**. Checking a payslip on the
hosted verifier (`POST /v1/payslip`, REQ-VER-006) hands all of that to the service for the length of the request: it never
logs or echoes the body, but whoever runs it can see it. Check offline (`drop-operator verify-payslip --tx <file>`)
when that matters. Not built: a payslip without the memo, a proof that the presenter controls the receiver, and a check in
the browser.

**As a link or a QR code** (REQ-PAY-004). The site's payslip page can make a link, `/payslip#payslip=…`, or a QR code of it, so a
recipient can hand a payslip to someone on a phone. The payslip sits only after the `#`, which a browser never sends to a server:
opening the link or scanning the code does not tell the host what it holds. The page reads it once, takes the fragment out of the
address bar and out of its own history entry at once, puts the payslip in the box and checks nothing until asked. Making a link
sends nothing anywhere, and the page keeps it nowhere. Still, a link **is** the whole payslip in an address: whoever has it has
the receiver, the amount and the key to the memo and can present it as their own, and a chat app, a notes app or a browser that
syncs its history may keep what was sent or opened. The page's own history entry is cleaned; a browser's separate record of the
visit is outside the page's control and may keep the full link. The page says all this where a link is made and where one is
opened. Send a link only to the person the payment is to be proved to.

## Practice mode: a simulation, not a payout

The site's "Try a practice payout" runs the operator's own screens against a simulation inside the page (REQ-DEMO-001). It reads no
chain and makes no request to an operator, a verifier or a node; the one thing it fetches is its own code, a static file from the
page's origin. Its state is in memory, so reloading starts over, and it leaves one flag in the tab's session storage that goes when
the tab does. Every screen says it is a simulation, and every simulated transaction id and list fingerprint begins with the bytes
of the word "practice", so none can be taken for a chain's and none gets an explorer link. Its totals and fees are the real
arithmetic for the list, but nothing in it is evidence about any chain, and it is no part of what ZecDrop proves. Because it
reads no chain it cannot check a payslip, or show a receipt it did not make.

## Public (anyone can see, and the verifier recomputes)

| Item | Why it is public |
|---|---|
| Campaign funding address (transparent), funding amount, funder's inputs | Transparent by design: this *is* the public total |
| Per-batch net value into the pool, fee, txid, timing | Balance rule of the protocol |
| Shielded action count per batch | Visible in the tx; ≈ recipient count (padded to ≥ 2) |
| Transparent change outputs | Visible; shows remaining balance |
| Salted manifest commitment | Published on the receipt |

## Hidden from the public

Recipient addresses · per-recipient amounts · memos · which output belongs to whom.

## Known leaks and limits (honest list)

1. **Derivable amounts.** A batch's public net value equals the sum of its outputs. A batch of **one** reveals
   that recipient's exact amount. A batch of N **equal** amounts reveals every amount (total ÷ N). Amount
   privacy therefore comes from *variation*; uniform airdrops get no amount privacy. The planner avoids
   singleton batches (REQ-PLAN-003) and the review step warns (REQ-PRIV-003).
2. **Two-recipient batches.** Each party can infer the other's amount from the public total and their own.
3. **Small anonymity set.** With few recipients the public total bounds every amount tightly.
4. **Funding is linkable.** The funder's transparent address and amount are public. Swapping funds in via NEAR
   Intents adds a public, transparent leg (NEAR lists ZEC as transparent-address-only).
5. **Fee and action count fingerprint the batch size** even if the receipt omitted it. The action count equals the
   recipient count exactly for batches of two or more. Padding to a fixed bucket hides it, at the cost of one
   fee and about 1.25 s of proving per padding action (an option, not built).
6. **Network metadata.** The node/indexer the operator talks to learns which transactions are fetched and
   broadcast; the hosted verifier learns which receipts are viewed. Mitigation: self-host, or Tor (planned, optional).
7. **Viewing-key disclosure is irreversible and total for that account.** An auditor with the campaign UFVK sees
   every output of that account, **including recipient addresses, amounts and memos**, forever. Scoping is per
   campaign (one ZIP-32 account per campaign); there is no revocation.
8. **The operator sees everything** (recipient list, amounts, memos) and holds the spend key.
9. **Recipients' later behaviour** (spending, exchange deposits) is out of scope.
10. **A payslip discloses its output's receiver, amount and memo to whoever holds it** (and to a hosted verifier that checks
    it, and to anything that carries a link or QR code of it). See "Payslips" above.

## Trust assumptions

- The operator's machine is not compromised (holds seed and the plaintext recipient list).
- The chain data source is honest (Zebra/Zaino/lightwalletd). A lying node can fake a receipt. Mitigation:
  point the verifier at your own node; header-chain verification is a possible follow-up.
- The Zcash protocol and the `librustzcash` implementation are sound. This project has had no independent audit.

## Non-goals

Hiding that a campaign exists · hiding the funder · mixing/anonymity-set growth beyond the Zcash pool ·
custodial hosting of user keys (the hosted sandbox uses a throwaway testnet key and says so).
