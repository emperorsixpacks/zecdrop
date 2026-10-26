# Learnings

Pitfalls and measured facts. Format: symptom → cause → fix → prevention. Newest first.

## 2026-10-07 — The first transaction design targeted a pool that no longer accepts new value

- **Symptom:** The plan and ADR 0001 specified transparent inputs → Orchard outputs. Nothing flagged it; an offline
  build of that shape would have succeeded.
- **Cause:** The design came from pre-NU6.3 knowledge. A builder constructs a transaction without checking
  consensus rules. ZIP-258 (Draft, but active on mainnet from 3,428,143 and testnet from 4,134,000) states that no
  new value may enter the Orchard pool; ZIP-326 forbids wallets sending to external Orchard receivers.
- **Fix:** Outputs go to the Ironwood pool (V6 transactions). ADR 0001 and ADR 0005 rewritten; receipt fields are
  `shielded_actions` + `pool`.
- **Prevention:** Before locking a transaction shape, read the *current* network-upgrade ZIPs and confirm activation
  on an explorer. Treat an offline spike as proof of **construction and decryption only**. Consensus validity is
  confirmed only by broadcasting on testnet; that broadcast is the gate between spike and build.

## 2026-10-08 — The full product path ran on public testnet: 8 recipients, create to settled in about 2 minutes

- **Run:** real operator (`--lightwalletd-url https://testnet.zec.rocks:443`, dev seed, default state dir), campaign c-d8d4d52029a4
  from `examples/demo-recipients.testnet.csv`: funding detected from the swept coin (12,410,000 zat), start at 12:51:02,
  batch built and broadcast at 12:51:22 (the Halo 2 proof for 8 recipients took about 20 s), confirmed at depth 1, 2, 3 by
  12:53:10 (about 25 s per block on NU7), settled. txid `6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955`, mined at 4,478,289, 28,284 bytes, V6 on NU7.
- **Checked independently:** a raw `GetTransaction` call; a fresh hosted verifier (settled, funding address `tmU6c1a…`,
  net 500,000, fee 45,000, 8 Ironwood actions; a false declared total fails with `declared_total_mismatch`); the full
  `audit` (8 of 8 outputs, payout list 8 of 8, recomputed salted commitment equals the receipt's); all 8 recipients
  decrypt exactly their own amount and memo; the SSE event stream carries no recipient data.
- **Friction found:** `export-ufvk` correctly refuses without `--i-understand-this-is-irreversible`; the audit CLI prints amounts
  without the TAZ unit; a damaged store now exits before printing any link.
- **Still unproven:** mainnet; multi-batch campaigns (needs the funding split); released wallets reading testnet notes.

## 2026-10-08 — The default testnet explorer lags the chain; ZecBlock follows it

- **Symptom:** `testnet.zcashexplorer.app` stopped at block 4,331,234 while the chain was at 4,478,066+, so it reports
  "Transaction Not Found" for our real batch (mined at 4,478,065). A judge clicking "Explorer" on the receipt would see an error.
- **Cause:** a third-party explorer that is not keeping up with the NU7 testnet (the first research had already
  noticed its stale tip).
- **Fix:** default testnet links point to ZecBlock (`testnet.zecblock.com`, reached via a 301 from `testnet.cipherscan.app`).
  Verified: `/tx/<txid>` shows CONFIRMED at #4,478,065 with 119 confirmations, typed SHIELDED; `/address/…` and
  `/block/…` return 200. Its detail panel loads with client-side JavaScript.
- **Prevention:** re-check the explorer links with `web/scripts/check-explorer-links.mjs` before submitting; treat any
  explorer as a lagging third party, never as the source of truth (the verifier reads the node directly).

## 2026-10-08 — The operator only watches the campaign's funding address, so batch change must be swept back

- **Symptom:** after the first live batch, 12,420,000 zat of change sat at the campaign's *change* address. The operator
  detects deposits by polling UTXOs of the *funding* address only (`real.rs`), so that coin was invisible to a second
  campaign run.
- **Fix (testnet, done):** `drop_zcash::build_sweep` spends the change address's UTXOs to the funding address in a
  transparent-only transaction (txid `9070aee0…f272`, height 4,478,106, 207 bytes, fee 10,000 zat = the 2-action
  grace minimum). Verified on chain: one UTXO of 12,410,000 zat at the funding address, change address empty.
- **Consequence:** change is not automatically reusable. A product follow-up is a "reclaim leftover funds" action in the
  operator; today it is a library helper plus a spike tool.

## 2026-10-08 — Zebra's "already mined" rejection text was not what we assumed

- **Symptom:** the security review suspected that a broadcast that timed out after the node accepted it would be retried,
  rejected, and wrongly recorded as Failed. A live re-send of the mined batch proved the old recognised wording list
  would NOT have matched.
- **Cause:** we guessed the node's error wording. Real text (code -1, from `testnet.zec.rocks`, Zebra 7.0.0-rc.0):
  "any transaction with the same effects will be rejected from the mempool until a chain reset: transaction was
  committed to the best chain". The same prefix also wraps `Expired`, `DuplicateSpend` and `RandomlyEvicted`, so the
  prefix alone must not count as "known". The in-mempool wording is "transaction already exists in mempool".
- **Fix:** after ANY refusal, `broadcast` asks the node whether it has the txid (mempool or mined) and treats that as
  success whatever the wording; the observed strings are pinned in tests, with the same-prefix look-alikes pinned as NOT known.
- **Prevention:** never rely on error-message wording for a safety decision; ask the node for state. Capture real
  wording from a live node, not from memory.

## 2026-10-08 — First live batch: the network accepts transparent → Ironwood (testnet)

- **Observed:** a V6 transaction on NU7 (`0x77190ad9`) with one P2PKH input (12,500,000 zat), three Ironwood outputs
  (10,000 + 20,000 + 30,000 zat, 512-byte memos, campaign OVK) and a transparent change output (12,420,000 zat) was
  broadcast through `testnet.zec.rocks`, accepted immediately, in the mempool within a second, mined after 31 s at
  height 4,478,065. txid `50fb88e02e7f4b0f3b3b658f50b09b12ea973d8c3697f8bad4c59e41075ea3e3`. The lead fetched it back with a raw `GetTransaction` call: 12,503 bytes, version 6.
- **Recomputed from the fetched bytes:** `t_in = t_out + net_into_pool + fee` (12,500,000 = 12,420,000 + 60,000 + 20,000).
  The campaign UFVK recovered 3 outputs summing to the public 60,000; recipient 1's key read its own amount and memo.
- **What this settles:** the anchor from `GetTreeState` at the tip is accepted, the fee (5,000 per logical action) is
  accepted, and a change output is fine. ADR 0001 is now proven on testnet.
- **What it does not settle:** mainnet (still NU6.3), larger batches, and released wallets reading the notes.
- **Faucet:** the Valar Group faucet paid a transparent address 0.125 TAZ; the coin appeared at the address after a few
  minutes, and `GetAddressUtxos` lagged `GetTaddressBalance` by about a block.

## 2026-10-07 — NEAR Intents: ZEC is listed, but mainnet-only; a dry quote needs no JWT

- **Facts (observed):** `GET https://1click.chaindefuser.com/v0/tokens` needs no auth and returns 204 assets, six of them
  "ZEC": native `nep141:zec.omft.near` (blockchain `zec`, 8 decimals) plus bridged ZEC on NEAR, Solana, Starknet and
  Aptos. A `dry: true` quote works without a JWT and answers HTTP 201 (the docs say 200) with no deposit address; the
  server added an `appFees` entry (20 bps) by itself. Prices are mainnet prices; there is no testnet ZEC.
- **Consequences:** matching the symbol would pick the wrong asset, so `find_zec` matches the blockchain. NEAR funding
  can never fund a testnet campaign; on testnet it can only show a dry quote. The ZEC leg requires a mainnet
  transparent address.
- **Prevention:** never send a non-dry quote or a deposit from tests; the crate makes a live request constructible only
  from a matching dry response.

## 2026-10-07 — Public testnet is already on NU7; released wallets probably cannot sync it

- **Symptom:** The spike reported "NU7 weeks away on testnet" (from an explorer tip of 4,331,234).
- **Cause:** The explorer lagged. A direct gRPC `GetLightdInfo` to `testnet.zec.rocks:443` (verified) reports chain
  `test`, branch `77190ad9` (NU7), lightwalletd v0.5.4, Zebra 7.0.0-rc.0. `zec.rocks:443` (mainnet) reports
  `37a5165b` (NU6.3), Zebra 6.3.0.
- **Consequences:** (1) a builder on the stable crate train stamps NU6.3's branch id and would be rejected on testnet,
  so the 0.31 pre-release train is required, not optional; (2) the NU7 limit of 330 actions per transaction applies
  on testnet now; (3) per a research report (source-based, not tested live), Zodl SDKs and zcash-devtool lock
  `zcash_protocol` 0.10.5, which has no testnet NU7 height, so they likely fail to sync testnet, while mainnet works.
- **Fix:** Pre-release train; read the live tip and branch from `GetLightdInfo`; recipient-side checks on testnet use
  our own IVK decryption.
- **Prevention:** Read chain state from a live node, not an explorer. Test the builder at both a testnet NU7 height
  and a mainnet NU6.3 height.

## 2026-10-07 — "Anyone can verify the campaign paid out exactly what it was funded" overclaimed

- **Symptom:** README and AGENTS.md said the public can verify the campaign paid out exactly what it was funded.
- **Cause:** The public can verify `t_in = t_out + net_into_pool + fee`, but cannot tell a dummy shielded spend from a
  real one, nor an output to a third party from an output back to the operator. The spike's own analysis lists this.
- **Fix:** Wording now says the public verifies how much entered the shielded pool, in how many outputs, at what fee;
  the auditor confirms count and sum against the payout list (REQ-AUD-001).
- **Prevention:** Every "anyone can verify X" claim must name what a key-less verifier can actually compute.

## 2026-10-07 — Stable librustzcash train does not resolve beside `sha2 0.11`, and does not know NU7

- **Symptom:** `zcash_primitives` 0.30.1 pins `crypto-common =0.2.0-rc.1`; `zcash_transparent` 0.10.0 pins
  `bip32 =0.6.0-pre.1`. Cargo cannot select a version next to `drop-core`'s `sha2 0.11`. The stable train also has no
  NU7 height (testnet 4,465,026), so it would keep stamping NU6.3's branch id after NU7.
- **Fix:** Use the 0.31 pre-release train, exact-pinned, lockfile committed (see ADR 0001).
- **Prevention:** Resolve the full dependency set in the spike, before domain crates choose their own crypto crate versions.

## 2026-10-07 — Fee constant differs between the ZIP text and Zebra

- **Symptom:** ZIP-317 text says `marginal_fee = 5000`; Zebra main's `zip317.rs` has `MARGINAL_FEE = 1_000`.
- **Cause:** Implementation and spec diverged; the reason is not documented in the code.
- **Fix:** Fee math takes a `FeePolicy` parameter (REQ-PLAN-002). Paying above a node's minimum is accepted;
  paying below is not, so default to the higher value unless the node is known.
- **Prevention:** Never hard-code protocol constants in the domain crate.

## 2026-10-07 — Unverified assumption removed: "100,000-byte relay cap"

- **Symptom:** An early search summary suggested a `MAX_STANDARD_TX_SIZE` of 100,000 bytes.
- **Cause:** Bitcoin-derived constant assumed for Zcash.
- **Fix:** A research pass reports Zebra has no such constant (hard limit is the ~2 MB block size) and that NU7
  (ZIP-218, Draft) plans 330 actions per pool per transaction. **Both are unverified by this project.** Batch size
  is a caller parameter; the spike measures proving time and size.
- **Prevention:** Mark secondary-source facts as unverified in the doc that uses them.
