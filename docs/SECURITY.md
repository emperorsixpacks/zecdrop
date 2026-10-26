# Security model

Not audited. Hackathon-grade software: use testnet or small amounts. Privacy limits are in `PRIVACY_BOUNDARY.md`.

## Assets

| Asset | Where it lives | Rule |
|---|---|---|
| Seed / spend keys | `drop-operator` process memory + encrypted file | Never serialized to JSON, logs or the API; zeroized on drop (REQ-SEC-001) |
| Recipient list (addresses, amounts, memos) | Operator's local store | Encrypted at rest with a passphrase (REQ-SEC-002); never sent to the verifier |
| Campaign UFVK | Given to the auditor out of band | Never sent to a hosted service (REQ-VER-002); audit runs locally (REQ-AUD-001) |
| NEAR 1Click JWT | Operator env var | Never committed, never sent to the browser |
| Salt for the manifest commitment | Operator store | 32 bytes from OS randomness |
| Shielded deposit address wallets (testnet, `--zcash-devtool`) | One zcash-devtool wallet per payout under `<state-dir>/inbox/` | Its phrase and the identity it is encrypted to are derived from the operator's seed and reach zcash-devtool on stdin (the identity, for `init` alone, in a 0600 file deleted at once). Its wallet database (the inbox's viewing keys, notes and amounts) is **not encrypted**: each wallet directory is 0700, and the PCZT files a transaction is built from are deleted after use and at start-up (REQ-FUND-005, REQ-PRIV-004) |

## Actors and what they can do

| Actor | Can | Cannot |
|---|---|---|
| Public / judge | Read receipt, recompute totals | See any recipient, amount or memo |
| Hosted verifier | Serve receipts from chain data | Hold keys; receive a UFVK; see the manifest |
| Auditor (UFVK) | Decrypt every output of one campaign account | Spend; see other campaigns; see the campaign's shielded deposit address (a different seed) |
| Recipient | Read own amount and memo in their wallet | See other recipients |
| Operator | Everything for their campaigns | — |

## Threats and mitigations

- **Double-pay on crash/retry:** built tx persisted before broadcast; resume re-broadcasts stored bytes;
  each batch is bound to specific funding outpoints so consensus rejects a second spend (REQ-RES-001).
- **Wrong network / mainnet by accident:** testnet default; mainnet needs an explicit flag and confirmation.
- **Malformed or hostile import (CSV):** strict parser, all errors reported, no silent truncation (REQ-IMP-001).
- **Verifier lies or is spoofed:** receipts are recomputable by anyone from public chain data; the page links
  txids to independent explorers.
- **A wrong or doubled move out of a shielded deposit address:** every transaction zcash-devtool builds for an inbox is
  checked from its raw bytes by the operator's own parser before it is stored or sent: its shape, its fee, and value
  conservation by nullifier (and, for a send-back, where it goes, recovered with the inbox's outgoing viewing key). One move per
  inbox, stored before broadcast and re-sent from those bytes, rebuilt only after its expiry on the scanned chain, never again
  once mined; a fresh look at the funding address just before it; a lock on the inbox directory for the life of the process
  (REQ-FUND-006, REQ-FUND-007).
- **zcash-devtool changes or misbehaves:** built from a pinned upstream commit with ZecDrop's own patch, refused at start-up
  without the patch's flags, run with a timeout and bounded output, its output never put in a log or an error; its wallet
  database is only ever read, read-only.
- **Secrets in git:** `.gitignore` blocks seeds and `.env`; pre-flip history scan (see `HACKATHON.md`).
- **Hosted operator sandbox: NOT BUILT.** An earlier draft promised a hosted sandbox operator with a throwaway key and
  a spend cap. Neither exists. A hosted operator would also need a reverse proxy, which undoes the loopback-only and
  Host-header protections. The judged demo is the hosted key-less verifier plus a recorded local run; any hosted
  operator needs its own design first.

## Open items

Passphrase KDF parameters · local API auth for the embedded operator UI (bind to loopback + per-run token) ·
Tor for chain access · rate limiting on the hosted verifier · the shielded deposit address wallets' databases are protected by
file permissions only, not encrypted like the store.

## Independent review (2026-10-07)

A read-only agent reviewed the code and found no critical or high issues. Findings and their status are tracked in the
OpenSpec change `security-review-fixes`. "Probed" means the lead exercised the real binary or chain; "tests" means the
lead ran the test suite but did not probe the behaviour.

| Finding | Severity | Status |
|---|---|---|
| Exact-amount funding strands coins (builder failed on change < 54 zat, including 0) | medium | fixed, probed with exact, +1, +53, +54 boundary tests |
| ZIP-32 accounts numbered per store, not per seed | medium | fixed, probed: a second store with the same seed gets a new account; the first campaign keeps account 0 |
| Receipts not bound to a campaign | medium | contract landed (`funding_address`, `mixed_funding_sources`); verifier and page being updated |
| Verifier can be tied up by slow or heavy requests | medium | fixed, probed on the real binary (stalled header closed at 3 s; `/health` 4 ms under saturation; overload shed with 503) |
| Store file world-readable and any passphrase accepted | low/medium | fixed, probed (mode 0600; passphrase under 12 characters refused) |
| No Host check; static server served dotfiles and escaping symlinks | low | fixed, probed (421 / 404 / 404; CSP, nosniff and no-referrer present) |
| Plain-text store columns not authenticated | low | fixed, probed: editing the `account` column makes the operator refuse to serve ("stored data is damaged or has been tampered with") |
| Key material copies not all wiped; passphrase stays in the environment | low | partly fixed (our secp256k1 copy wiped, passphrase removed from the environment); library copies cannot be reached |
| Broadcast rejection wording not recognised, so a mined batch could be marked Failed | medium | fixed and the suspicion confirmed live: the old wording list did not match Zebra's real text; broadcast now asks the node for the txid's state |
| Failed batches lost their txid; stored bytes never re-sent | low | fixed, tests |
| Recipient Debug output showed address fragments | low | fixed, tests |
| Lying node can fake a mismatch or a UTXO | low | documented node-trust assumption, not fixed |

Open items from the review fixes:

- **Rollback is not detected.** Store rows are authenticated against edits made outside the operator, but deleting a row,
  or putting back an older complete copy of the store file, is not detected, so a rolled-back ledger could build a batch
  again.
- **Directory fsync after the account registry rename is unverified.** No test can observe it without simulating a
  crash.
- **The operator prints its "open this link" banner before it finishes checking the store**, so a damaged store shows
  a link and then exits with an error. A cosmetic issue.

## Review of the shielded deposit address (2026-10-24)

An independent agent reviewed the inbox read-only: the engine, the transaction checks, the zcash-devtool driver and the
send-back route. It found no way past the checks of a move or a send-back, and no path to a second move. Each finding was
checked against the code and against librustzcash before it was fixed.

| Finding | Severity | Status |
|---|---|---|
| The page could ask for a payment zcash-devtool never spends (5,000 zat or less), and its top-up forgot the fee of the note it adds | medium–high | fixed, tests (a property test: whatever the page asks for, once paid, makes a move possible) |
| After a restart or a failed look at the wallet, the page could offer the public address to a payer who had paid the shielded one | medium | fixed, tests; probed on the real testnet store after a restart |
| A send-back did not check the wallet seed, so another seed's payout could spend this seed's inbox | medium | fixed, tests (without the guard, the test's send-back goes through) |
| A lost wallet directory was never set up again | low | fixed, tests |
| The log named each send-back's transaction | low | fixed, tests |
| A send-back cut short could leave its PCZT files until the next build | low | fixed, tests |

Still open: the inboxes are looked at one at a time, under one lock, so a hung sync delays the others by up to its
300-second timeout; and a funded payout's inbox is synced every ten minutes for as long as the operator runs.
