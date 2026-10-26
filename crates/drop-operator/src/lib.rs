//! # drop-operator
//!
//! The local ZecDrop operator service: it holds the wallet seed, keeps the recipient
//! list in an encrypted store, runs the `drop-core` engine against a chain backend,
//! and exposes a loopback-only JSON API with Server-Sent-Events progress, plus the
//! web UI as static files.
//!
//! The chain is a port ([`chain::ChainBackend`]) with two implementations:
//!
//! * a deterministic fake ([`mock::MockChain`], `--mock-chain`) for development and demos;
//! * the real thing ([`real::ZcashBackend`], `--lightwalletd-url https://testnet.zec.rocks:443`),
//!   which funds and pays campaigns on Zcash testnet through a lightwalletd / Zaino server using
//!   `drop-zcash`'s distributor. Public endpoints that were checked are listed in the
//!   `drop-chain` docs; none is built in.
//!
//! ## Real-chain mode
//!
//! * **Wallet.** `drop-operator init-wallet` creates the seed inside the encrypted store (it
//!   prints nothing secret). On testnet only, `--seed-file <path>` reads a development seed
//!   (64 hex characters) from a file that is not readable by others, instead.
//! * **One ZIP-32 account per campaign.** Each campaign has its own transparent funding address
//!   (shown as `funding_address` in the campaign API) and its own viewing key, so one
//!   campaign's key discloses that campaign and no other.
//! * **Funded only when seen on chain.** The operator lists the unspent outputs of the funding
//!   address, on a timer and on `POST /api/campaigns/{id}/check-funding`, and records a deposit
//!   only when it is on the chain at the required depth and covers the declared total plus fees.
//!   `fund-observed` is refused on a real chain. Progress (`funding_progress`) is reported while
//!   a deposit is still shallow.
//! * **One batch per campaign.** The deposit is the batch's funding input and the change returns
//!   to the campaign's change address. A campaign that needs several batches is refused with
//!   `needs_funding_split`: a funding-split transaction (a transparent transaction creating one
//!   exact output per batch, persisted in the ledger) is **not implemented yet**.
//! * **Mainnet** is refused by this build.
//!
//! ## Running a campaign on testnet
//!
//! ```text
//! ZECDROP_PASSPHRASE='a passphrase of 12 or more characters' \
//!   drop-operator --lightwalletd-url https://testnet.zec.rocks:443 \
//!     --seed-file ~/.zecdrop-dev/testnet.seed --db ~/.zecdrop-dev/demo.sqlite \
//!     --web-dir web/dist --poll-interval-ms 5000
//! ```
//!
//! * The passphrase opens (or, for a new file, creates) the store; it is read once and removed
//!   from the environment. `--required-depth` defaults to 3, `--funding-poll-secs` to 15, the
//!   state directory (account registry) to `~/.zecdrop`, the bind address to `127.0.0.1:8787`.
//! * The link `open: http://127.0.0.1:8787/#token=...` is printed only when the operator is
//!   serving: the store has been read and authenticated and the node answered. Open it from the
//!   same machine.
//! * **Create** the campaign (UI or `POST /api/campaigns`): the view shows `funding_address`, its
//!   own transparent address, and `funding_required` (the declared total plus the fee, which is
//!   5,000 zat per logical action: shielded outputs plus one for the transparent side). Phase
//!   `awaiting_funding`, "Waiting for funds". A campaign must fit one batch (at most 330).
//! * **Deposit.** Send to `funding_address`. Every `--funding-poll-secs` (and on
//!   `POST .../check-funding`) the address is listed. While an output is seen but is too small or
//!   not yet `required_depth` deep, `funding_progress` says so (`amount`, `confirmations`,
//!   `required_depth`, `sufficient`). Once one is deep enough and large enough the campaign is
//!   `funded`, "Funded, ready to send", and `funding_progress` is `null`. An output that was
//!   already deep enough counts as soon as the next look finds it.
//! * **Start** (`POST .../start`, returns 202). The run is `running`. The batch stays `planned`
//!   while the proof is made, about 20 seconds for 8 recipients (measured in a live testnet run;
//!   about 9 for 3 in tests); then events `built` and `broadcast` arrive and the batch is `broadcast` with its
//!   `txid`. The proof is made once; a restart resumes from the stored transaction.
//! * **Confirmations.** `waiting` events carry `observed_depth` and `required_depth`, and are
//!   sent once per change, not once per poll; the batch
//!   becomes `confirmed` with `confirmations` 1, 2, 3 as blocks arrive (about 25 seconds apart on
//!   the NU7 testnet, so depth 3 takes about 80 seconds), the phase reads "Sending: 0 of 1 batches confirmed", and at depth 3 it is
//!   `settled`, "Complete: all batches confirmed". If the node stops knowing the transaction, it
//!   is sent again from its stored bytes (a repeated `broadcast` event), a bounded number of
//!   times.
//! * `GET .../receipt` is the public receipt: txid, totals, `funding_address`. Nothing else
//!   about the recipients is on it.
//!
//! ## Auditing
//!
//! `drop-operator audit --campaign <id> --ufvk-stdin --lightwalletd-url <url>` reconciles a
//! campaign's on-chain payouts with its payout list, locally, using the campaign's viewing key
//! ([`audit`]). For every batch it takes the public facts from `drop-verify` (the same code as
//! the hosted verifier), recovers the outputs with the key through `drop-zcash`, and reports:
//!
//! * whether the number of recovered outputs equals the public action count (batches of two or
//!   more recipients; a single-recipient bundle is padded, so its count is "not comparable");
//! * whether the sum of the recovered values equals the public net value into the pool;
//! * which payout-list rows a recovered output confirms (same Orchard receiver, amount and memo),
//!   how many recovered outputs match no row, and whether the salted manifest commitment
//!   recomputed from the confirmed rows equals the receipt's (`--receipt-commitment` overrides
//!   the stored one, for example with the value from a public receipt).
//!
//! Differences are reported as differences, never rounded away. `reconciled` is true only when
//! every batch was found, is final (at the required depth), matches in count and sum, every row
//! is confirmed, nothing unexplained was recovered and the commitment matches. Exit codes: `0`
//! reconciled, `2` the audit ran and found differences, `1` the audit could not run.
//!
//! The key is read from stdin or `--ufvk-file` (at most 4 KiB, never from the command line) and
//! is never logged, stored, printed or sent anywhere; no error repeats it. The report holds
//! counts, public sums, transaction ids and verdicts, and no address, memo or per-recipient
//! amount. The lightwalletd server does learn which transaction ids were fetched.
//!
//! `drop-operator export-ufvk --campaign <id> --i-understand-this-is-irreversible` prints a
//! campaign's key for an auditor: the warning goes to stderr, the key alone to stdout. To audit
//! a campaign you made, pipe one command into the other, so the key is never shown or typed:
//!
//! ```text
//! drop-operator FLAGS export-ufvk --campaign ID --i-understand-this-is-irreversible \
//!   | drop-operator FLAGS audit --campaign ID --ufvk-stdin --receipt-commitment HEX
//! ```
//!
//! `FLAGS` are the same for both: `--db`, `--seed-file`, `--state-dir`, `--lightwalletd-url`
//! (and the same `ZECDROP_PASSPHRASE`). Write them out in each command: a shell that does not
//! split a variable into words (zsh) will not split one that holds them. `HEX` is the manifest
//! commitment on the public receipt. `audit --help` shows the same recipe. Verified end to end
//! on a real testnet campaign: 8 of 8 outputs recovered, 8 of 8 payout rows confirmed, the
//! recomputed commitment equal to the receipt's.
//!
//! `GET /api/campaigns/{id}/audit-ufvk-export` does the same for the UI and needs the header
//! `X-Zecdrop-Confirm-Disclosure: I-UNDERSTAND`; a request without it is refused with the
//! `warning` in the error, and a successful response always carries a `warning` the UI must show
//! before the key leaves the screen.
//!
//! `drop-operator audit-tx --tx tx.hex --prevouts prevouts.json (--ufvk-stdin | --ufvk-file F |
//! --seed-file S --account N)` audits one transaction from files, offline, with no store and no
//! node: it recovers the outputs the key opens and reports whether their number and sum equal
//! what the transaction publishes ([`txaudit`]). It checks no payout list. With `--account`, the
//! key is derived from a testnet development seed and never printed.
//!
//! What has not been exercised: the `audit` command against a live node. The tests use genuine
//! Orchard batch transactions built with test-only keys and an in-memory chain source; a live
//! fixture (a real testnet batch transaction with its campaign key) does not exist yet.
//!
//! ## Hardening
//!
//! * **Account numbers are never reused for a wallet seed** ([`accounts`]). A store can only
//!   number the campaigns it holds, so a small registry outside the store (one file per seed
//!   fingerprint, in `--state-dir`, default `~/.zecdrop`, owner-only) records the highest
//!   account ever handed out and is flushed before the number is used. A crash skips a number
//!   and never reuses one. Lose the directory and the guarantee is gone; keep it with the seed.
//! * **The store file is private and its rows are authenticated** ([`store`]). The file and its
//!   journal are created mode 0600 (and tightened on open); a new store needs a passphrase of
//!   at least 12 characters; `ZECDROP_PASSPHRASE` is removed from the environment once read.
//!   Every `campaigns` and `batches` row carries a tag over all its columns, so editing a
//!   column outside the operator (an account number, a batch state, a commitment) is refused
//!   with `store_corrupt` instead of being believed. Not detected: deleting a row, or putting
//!   back an older copy of the whole file.
//! * **The HTTP surface answers only to itself** ([`guard`]). Requests must carry a loopback
//!   `Host` with the port the server is bound to (DNS rebinding), the static server refuses
//!   dotfiles and anything that resolves outside the web directory, and every response carries
//!   a restrictive Content-Security-Policy, `nosniff` and `no-referrer`.
//! * **Batches are bounded** to what one transaction can pay (`batch_size_too_large`).
//! * **A failed batch keeps its transaction id**, and a broadcast transaction the node stops
//!   reporting is sent again from its stored bytes, a bounded number of times (`drop-core`).
//!
//! ## Requirements
//!
//! | ID | What | Module |
//! |----|------|--------|
//! | REQ-OPS-001 | Testnet by default; mainnet needs a flag and a confirmation | [`config`] |
//! | REQ-OPS-002 | Loopback-only bind and a per-run bearer token | [`config`], [`auth`], [`api`] |
//! | REQ-SEC-001 | The seed never serializes, prints or outlives its owner in memory | [`secret`] |
//! | REQ-SEC-002 | Recipient data, salt and raw transactions encrypted at rest | [`crypto`], [`store`] |
//! | REQ-LED-001 | The store is a conflict-safe `Ledger` | [`store`] |
//! | REQ-RES-001 | A killed run resumes from the ledger without rebuilding | [`state`] |
//! | REQ-PRIV-002 | No recipient data in responses, errors, events or logs | [`api`], [`http`], [`logging`] |
//! | REQ-FUND-002 | Funded only when the deposit is seen on chain at the required depth | [`state`], [`real`] |
//! | REQ-AUD-001 | Local audit reconciles recovered outputs with the public totals | [`audit`] |
//! | REQ-AUD-002 | One ZIP-32 account per campaign; a key recovers nothing from another campaign | [`store`], [`real`], [`audit`] |
//! | REQ-AUD-003 | Manifest commitment recomputed from recovered outputs | [`audit`] |
//! | REQ-PLAN-001 | A batch never exceeds what one transaction can pay | [`api`] |
//!
//! ## Where secrets are
//!
//! * The store passphrase comes from `ZECDROP_PASSPHRASE` or a prompt, never an argument; the
//!   variable is removed from the process environment as soon as it is read.
//! * The seed lives in [`secret::SecretSeed`] (no `Serialize`, redacted `Debug`,
//!   zeroized on drop) and, sealed, in the store.
//! * The API token is printed once, in a URL fragment, and compared in constant time.

#![forbid(unsafe_code)]
#![deny(missing_docs)]
#![deny(clippy::unwrap_used, clippy::expect_used)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

pub mod accounts;
pub mod api;
pub mod audit;
pub mod auth;
pub mod chain;
pub mod codec;
pub mod commands;
pub mod config;
pub mod crypto;
pub mod error;
pub mod events;
pub mod funding;
pub mod guard;
pub mod http;
pub mod logging;
pub mod mock;
pub mod real;
pub mod secret;
pub mod seedfile;
pub mod serve;
pub mod state;
pub mod store;
pub mod txaudit;

/// Number of batches in a stored campaign's plan.
pub(crate) fn api_plan_len(
    record: &store::CampaignRecord,
) -> Result<usize, commands::CommandError> {
    drop_core::plan_batches(record.manifest.rows(), record.max_outputs_per_batch)
        .map(|batches| batches.len())
        .map_err(|_| commands::CommandError::Audit(audit::AuditError::Plan))
}
