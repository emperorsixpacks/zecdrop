# shielded-funding

## Why
A campaign's deposit address is transparent on purpose: the public deposit is what lets anyone check the total (ADR 0001). What
the deposit *spends* is the payer's choice, and it decides whether the payer is on the chain. Paid from a shielded balance, the
deposit transaction has no transparent input, so it names no address of the payer's: the chain shows only that this amount came
out of the shielded pool. Paid from a transparent address, that address is public and tied to the campaign for good. Today
nothing says so: the funding screen asks only for the exact amount, the receipt does not say what the deposit spent, and the
privacy boundary called the funder's address public as if there were no choice. Our own two testnet batches show both kinds: the
3-person batch was funded straight from the faucet's shielded wallet, and the 8-person batch from a sweep of that run's change.

## What
- **The receipt says where the deposit came from** (REQ-VER-007): `funding_source` is `shielded`, `transparent` or `null`, read
  from the deposit transaction the verifier already fetches to resolve the inputs' values.
- **The funding screen asks for a shielded deposit and says what arrived** (REQ-FUND-004): before a deposit it asks the payer to
  pay from a shielded balance and says why; once a deposit is seen, at any depth, the operator classifies it the same way and
  the page says which kind it was. A transparent deposit is stated plainly and never blocks the payout: by then it is on the chain.

## Approach
`drop-core` gets the `FundingSource` type and the rule that combines several deposits into one answer; `drop-verify` gets the
key-less classifier, a function of a deposit's bytes. The verifier classifies the deposits it already loads (no new request).
The operator fetches the deposit transaction by id from the node it already uses (over a connection of its own, so a slow read
never holds up the look at a funding address), which already knows the funding address it watches, checks that the bytes hash
to the id, classifies it with the same function and keeps the answer in memory, keyed by
the deposit's txid, beside the address and progress caches it already has. Nothing is added to the store: the answer is public
chain data that can be read again after a restart, and the store's row tags stay as they are.

## Scope decisions
- **The rule is about inputs, not about the payer.** `shielded` means the deposit transaction has no transparent input, so its
  value came out of a shielded pool and it names no address; it does not say who paid. `transparent` means it spent at least one
  transparent coin (a coinbase input counts as one); the address may be the payer's, a swap service's or the campaign's own
  change, and the receipt never names it.
- **One step back.** The deposit is the transaction that created the batch's input. A batch funded by a transaction of the
  campaign's own (a sweep of its change, or the funding split, which is not built) therefore reads as `transparent`, which is
  true of that transaction; a funding split, once built, will have to look one step further.
- **Not a finding.** A transparent deposit is a privacy fact about a valid campaign, so it does not touch the phase: a campaign
  funded from a transparent address still settles.
- **Receipt level, not per batch.** A real campaign is one batch. Several deposits combine to `transparent` if any is known to be
  transparent, `shielded` if all are known and shielded, and `null` otherwise.
- **The key is optional in the web schema.** The site's receipt schema refuses unknown keys, so the verifier that adds the key is
  deployed after the site that accepts it; a receipt from an older verifier, without the key, still renders, with no line.
- **The mock chain and practice mode.** The mock chain has no deposit transaction; `fund-observed` may declare a source for the
  browser tests, and says nothing otherwise. Practice mode simulates a shielded deposit, under its banner.
- **Not built:** refusing a transparent deposit, or a hint before the deposit about which balance a wallet will spend (the
  operator cannot see the payer's wallet); hiding the amount (it is the public total).

## Risks
- "Shielded" could be read as "untraceable". The amount and the time are public, so a payer who shields coins just before paying,
  or pays an unusual amount, can still be linked by amount and timing. The privacy boundary says so, and the copy says only what
  the transaction shows: it names no address.
- A NEAR Intents deposit is transparent (the swap's address, not the payer's). The page says the deposit spent transparent funds,
  never that it was the payer's address.
