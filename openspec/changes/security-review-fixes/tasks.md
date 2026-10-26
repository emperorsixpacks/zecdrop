# Tasks — security-review-fixes

Tick only after the fix is verified by the lead (tests run, behaviour probed).

## drop-zcash / drop-chain (spike agent)
- [x] S1 No change output at 0; fold 1–53 zat into the fee; reconcile fee and public totals (REQ-TX-001) — verified: exact, +1, +53, +54 tests
- [x] S2 Expose the per-transaction action cap constant (`drop_zcash::MAX_IRONWOOD_ACTIONS_PER_TX`)
- [x] S3 Broadcast: on any rejection ask the node for the txid status; keep the txid on failure — verified with a fake node (accepted, mempool, mined, unfamiliar wording, invalid, timeout-after-accept)
- [x] S3b Capture Zebra's exact rejection wording by re-sending a mined tx after the first live broadcast — captured: code -1, "any transaction with the same effects will be rejected from the mempool until a chain reset: transaction was committed to the best chain"; the OLD recognised list did not match it (the suspected bug was real); the same prefix also wraps Expired, DuplicateSpend and RandomlyEvicted, so only the suffix is matched
- [x] S4 Wipe secp256k1 key copies (the library's own signing-set copy is out of our reach); `canonical()` = Orchard-only re-encoding so equal receivers dedupe (REQ-IMP-001)

## drop-verifier (spike agent)
- [x] V1 Timeout outside the limiter with load-shedding; `/health` bypasses it; header-read timeout; connection cap — verified on the real binary: stalled header closed at 3.0 s; /health 4 ms under saturation; 2 served + 4 shed (503)
- [x] V1 Cap upstream prevout fetches per request (`--max-lookups`, 422 `too_many_lookups`)
- [x] V1 Fail closed at startup if the node is unreachable (retry with backoff, then exit 1); refuse `http://` endpoints unless loopback

## drop-operator / drop-core (core agent)
- [x] C1 Seed-keyed account registry; first campaign for a seed keeps account 0 (REQ-AUD-002) — verified on the real binary: store A gets the funded account-0 address, store B with the same seed and state dir gets a different one; registry is 0600 and holds no seed
- [x] C2 Cap `max_outputs_per_batch` at creation (422 `batch_size_too_large` above 330)
- [x] C3 Store files 0600; minimum passphrase length 12; passphrase removed from the environment (REQ-SEC-002) — verified: refusal message, file mode -rw-------
- [x] C4 Host-header allow-list; refuse dotfiles and escaping symlinks; CSP and related headers (REQ-OPS-002) — verified on the real binary: evil Host 421, dotfile/symlink/traversal 404, CSP + nosniff + no-referrer present
- [x] C5 Authenticate plaintext store columns; verify the commitment at load — probed: editing `account` makes the operator refuse to serve; rollback to an older complete store copy is NOT detected (documented)
- [x] C6 Keep the txid in Failed; bounded re-broadcast of stored bytes (REQ-RES-001) — verified by the workspace test run (180 core tests); not probed live
- [x] C7 Recipient Debug shows nothing derived from the address (REQ-PRIV-002) — verified by the workspace test run
- [x] V2 Funding address in the public receipt and a `mixed_funding_sources` finding (REQ-PRIV-001, REQ-VER-004) — verified: real testnet receipt carries tmU6c1a… and settles; a second-funder case fails; unresolved input gives null without failing

## web
- [ ] Update the receipt schema, page and goldens for V2 (page shows the address; schema field becomes required once pinged)
