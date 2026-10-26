# Spike: single-tx builder (transparent → N shielded payouts) — RESULTS

- **Date:** 2026-10-07 · **Machine:** Apple M1 Pro (10 cores: 8P+2E), 16 GB · **rustc/cargo:** 1.92.0
- **Scope:** the offline spike uses only TEST-ONLY throwaway keys from a public hard-coded seed and
  fabricated funding UTXOs. The live testnet part has its own section (["Phase 2"](#phase-2--live-testnet)):
  its keys come from a dev seed kept outside the repo.
- **Reproduce:**
  - `cargo test --release` runs 11 tests in about 35 s.
  - `cargo run --release` prints the tables; the full run took 22 min.
    `SPIKE_ORCHARD_NU6_2=1` adds the Orchard comparison table and `SPIKE_NS=2,5` limits the N
    values. The raw output quoted below is in [`results-run.txt`](./results-run.txt).
  - `cd port-0.31 && cargo test` runs the same 11 tests on the NU7-aware pre-release crates.

## Verdict: **GO-WITH-CAVEATS** — but the payouts must go to the **Ironwood** pool, not Orchard

**As specified, "transparent → N Orchard outputs" is NO-GO on today's chains.** NU6.3, the
"Ironwood" upgrade, is active on mainnet (since height 3,428,143) and testnet (since 4,134,000).
ZIP-258 makes the Orchard pool outflow-only:

- "No new value may enter the *Orchard pool*" (`valueBalanceOrchard ≥ 0`).
- Every Orchard action must have `enableCrossAddress = 0`.

The pinned crates enforce this. At an NU6.3 height, `add_orchard_output` to a third party fails
with `CrossAddressDisabled` (test `orchard_payouts_are_rejected_from_nu6_3`).

Built at a pre-NU6.3 height, the Orchard variant has `valueBalanceOrchard = −3,000,001` for
N = 2: a **negative** balance, meaning value entering Orchard. The test
`orchard_payouts_still_build_in_nu6_2_epoch` asserts it. Zebra rejects exactly this from NU6.3
with `TransactionError::NegativeOrchardValueBalance` ("the Orchard value balance must be
non-negative from NU6.3 onward"):
- the check is `check::orchard_value_balance_non_negative`
  (`zebra-consensus/src/transaction/check.rs:217-228`, commit `22a88d5`);
- it is called next to `check::orchard_cross_address_disabled` (`zebra-consensus/src/transaction.rs:830-836`).

The Ironwood batch has `valueBalanceOrchard = 0` and `valueBalanceIronwood = −3,000,001`.

**The same pattern works with the Ironwood pool.** The code change is
`add_orchard_output` → `add_ironwood_output`. Recipients keep the same Unified Address, because
Ironwood pays to the UA's Orchard receiver. The table below summarises what the code ran.

| Claim | Result | Evidence |
|---|---|---|
| One tx: 1 P2PKH input → N Ironwood outputs with 512-byte memos, plus transparent change, with no real shielded spends | ✅ V6 tx on branch NU6.3 `0x37a5165b`, N = 2…200 | `results-run.txt` |
| The tx is valid. Halo2 proof, every RedPallas spend-auth signature, the binding signature and the P2PKH ECDSA signature all verify | ✅ every N | `proofs_and_signatures_verify`, `auth_ok` column |
| Anyone can recompute `t_in = t_out + net_into_pool + fee` from tx bytes plus resolved prevouts | ✅ exact. It also matches `Transaction::fee_paid` and the ZIP-317 fee recomputed from public structure | `ironwood_batch_balances_from_public_data_only` |
| `net_into_pool` (−valueBalance) can't be faked | ✅ flipping one bit of valueBalance makes signature validation fail | `tampered_value_balance_is_rejected` |
| A recipient's IVK recovers exactly their own amount and memo | ✅ | `recipients_decrypt_exactly_their_own_output`, `recips` column |
| The auditor, from the campaign UFVK string (`uviewtest1…`), recovers all N outputs, and Σ == `net_into_pool` | ✅ | `auditor_ufvk_recovers_all_outputs_and_sum_matches_pool_delta`, `auditor` column |
| With OVK=None, the sender's UFVK recovers nothing | ✅ 0 outputs after trying all 4 OVKs derivable from the UFVK. Recipients still decrypt and public totals are unchanged | `ovk_none_hides_outputs_from_sender_ufvk` |
| An unrelated IVK learns nothing | ✅ | `unrelated_ivk_learns_nothing` |
| Builds are deterministic for a fixed RNG seed | ✅ byte-identical | `build_is_deterministic_for_a_fixed_rng_seed` |

**Caveats to design for.** Details are in the sections below.

1. **Use the Ironwood pool.** It is mandatory for payments to third parties since NU6.3, and
   address formats are unchanged. Zebra is the only full node that follows NU6.3, because zcashd
   does not implement it (ZIP-258).
2. **NU7 is ALREADY ACTIVE on testnet** (activation height 4,465,026, branch id `0x77190AD9`).
   A live `GetLightdInfo` on `testnet.zec.rocks:443` on 2026-10-07 reported tip 4,475,588 and
   branch `77190ad9`. An earlier draft said "weeks away", based on a stale explorer tip.
   Mainnet is still on NU6.3.
   - The stable crate train used in the main offline tables (`zcash_protocol` 0.10.6) has no NU7
     height. On testnet today it would stamp NU6.3's branch id; `stable_train_does_not_know_nu7`
     shows the mapping. That is a stale branch id (inferred: such transactions are rejected).
   - Only the **pre-release** 0.31 / 0.17 / 0.11 train (zcash_protocol `0.11.0-pre.0`,
     2026-09-30) knows NU7. The spike was ported to it (`port-0.31/`, 5 call-site changes, all
     tests pass) and built a real NU7-branch batch against live testnet state (Phase 2). The
     workspace uses this train.
3. **NU7 per-block limits (ZIP-218).** At most 330 Ironwood actions per block, and at most 330
   shielded actions per block across all pools; block spacing drops to 25 s.
   - This hard-caps N at 330 per tx. Zebra's mempool also rejects a tx that exceeds the budget.
   - A large batch competes for a scarce per-block budget.
   - **There is no 100,000-byte relay limit** in Zebra or in zcashd master (details below), so the
     believed `MAX_STANDARD_TX_SIZE` limit does not apply. If you self-impose it anyway, max N = 30.
4. **The recipient count is public.** `nActionsIronwood` equals N exactly for N ≥ 2. To hide it,
   pad with `BundlePadding { pad_to_minimum: Some(k) }` (k ≤ 255). Each padding action costs one
   marginal fee and about 1.25 s of proving.
5. **The public campaign total equals `net_into_pool` only if** there is no shielded change and
   there are no real shielded spends.
   - With the low-level `Builder` (as here) change is transparent, so the equality holds.
   - `zcash_client_backend` always shields change in this situation (task 6), which would inflate
     the public number.
   - The public cannot tell a dummy spend from a real one, because `Builder` always sets
     `enableSpends = 1`. Setting `enableSpendsIronwood = 0` would let consensus *prove* there are
     no hidden spends, but needs custom assembly (inferred feasible, not built).
   - An auditor can detect hidden outputs: recovered count must equal the action count and
     Σ recovered must equal `net_into_pool`.
6. **Fees.** librustzcash's `zip317::FeeRule::standard()` charges `MARGINAL_FEE = 5_000` zat per
   logical action: `zcash_primitives/src/transaction/fees/zip317.rs:19`, the same in 0.30.1 and
   0.31.0-pre.1. That is what we pay: 5,000 × (N+1) with 1 t-in and 1 t-out. Zebra's mempool now needs only
   1,000 zat per action (`MARGINAL_FEE = 1_000`, `BLOCK_UNPAID_ACTION_LIMIT = 0`), so we overpay
   5×. The verifier should check `fee ≥ 0` and report the fee, not assert `fee == 5000 × actions`.
7. **Dependency clash with the main workspace.** `zcash_primitives` 0.30.1 pins
   `crypto-common = "=0.2.0-rc.1"`, and `zcash_transparent` 0.10.0 pins `bip32 = "=0.6.0-pre.1"`.
   Both conflict with `crates/drop-core`'s `sha2 = "0.11.0"`: cargo fails with
   "failed to select a version for `crypto-common`". The 0.31-pre train drops these pins.
8. **Anchor: confirmed on chain.** The live testnet batch used the real Ironwood anchor from
   `GetTreeState` at the tip, and was mined (see "Live result"). The offline tables used
   `Anchor::empty_tree()`; whether consensus accepts that was never tested, and production code
   uses the real anchor.

## Exact crate versions (all compile on rustc 1.92.0; no MSRV problem)

| crate | version | `rust-version` | note |
|---|---|---|---|
| zcash_primitives | **0.30.1** (2026-08-19) | 1.88 | features `transparent-inputs` (+ default `circuits`, `multicore`) |
| zcash_transparent | **0.10.0** | 1.88 | `transparent-inputs` |
| zcash_keys | **0.16.1** | 1.88 | `orchard`, `sapling`, `transparent-inputs`. `sapling` is set explicitly because zcash_client_backend enables it anyway, and it changes `UnifiedAddress::from_receivers` |
| zcash_address | **0.13.0** | 1.88 | |
| zcash_protocol | **0.10.6** (2026-09-08) | 1.88 | knows NU6.3; NU7 is `None` |
| orchard | **0.15.5** | 1.85.1 | **orchard 0.16.0 (2026-09-30) is not usable with primitives 0.30.x**, which requires `^0.15` |
| zip32 | **0.2.1** | 1.60 | 0.3.0 belongs to the 0.31 train |
| sapling-crypto | **0.7.0** | 1.85.1 | `test-dependencies`, used only for `MockSpendProver`/`MockOutputProver` (never invoked, since there is no Sapling bundle) |
| secp256k1 | 0.29.1 | | used only for the spike's ECDSA verification |
| zcash_client_backend | **0.24.0** | 1.88 | co-resolves with the above; source read for task 6, not called |
| bip32 | =0.6.0-pre.1 | | pinned by zcash_transparent 0.10.0. Also pulls sha2 0.11.0-pre.4, digest 0.11.0-pre.9 and ripemd 0.2.0-pre.4 |

All versions are pinned with `=` in `Cargo.toml`, and `Cargo.lock` is committed alongside.
The next train (all pre-release, 2026-10-01…06) is zcash_primitives 0.31.0-pre.1,
zcash_transparent 0.11.0-pre.1, zcash_keys 0.17.0-pre.1, zcash_address 0.14.0-pre.1,
zcash_protocol 0.11.0-pre.0, orchard 0.16.0, zip32 0.3.0, sapling-crypto 0.9.0,
zcash_client_backend 0.25.0-pre.1, with rand_core 0.10 and secp256k1 0.33.

## Measurements

Ironwood pool, testnet branch NU6.3. Shape: 1 P2PKH input → N Ironwood outputs (each with a
512-byte text memo and the campaign OVK) + 1 P2PKH change output. Times are wall-clock for
`Builder::build`: transparent signing, Halo2 proving and RedPallas signing. The proving key is
cached; building it once takes 3.5–4.4 s and is excluded. `verify` is batch verification of the
proof and all signatures, with the verifying key cached (2.25 s once, excluded).

Measured at testnet height 4,135,000 (NU6.3 epoch, V6 tx). Peak RSS for the whole run was
1.23 GB.

| N | actions | tx bytes | build + prove | fee (zat) | ZIP-317 logical actions | balance eq. + fee checks | proof + sigs verify | verify time | auditor Σ == NET | every recipient decrypts | < 100,000 B |
|---:|---:|---:|---:|---:|---:|:-:|:-:|---:|:-:|:-:|:-:|
| 2 | 2 | 9,348 | 3.0 s | 15,000 | 3 | ✅ | ✅ | 0.02 s | ✅ | ✅ | ✅ |
| 5 | 5 | 18,815 | 6.8 s | 30,000 | 6 | ✅ | ✅ | 0.06 s | ✅ | ✅ | ✅ |
| 10 | 10 | 34,595 | 13.7 s | 55,000 | 11 | ✅ | ✅ | 0.11 s | ✅ | ✅ | ✅ |
| 25 | 25 | 81,936 | 30.4 s | 130,000 | 26 | ✅ | ✅ | 0.24 s | ✅ | ✅ | ✅ |
| *30* | 30 | *97,718* | – | 155,000 | 31 | – | – | – | – | – | ✅ (max) |
| *31* | 31 | *100,874* | – | 160,000 | 32 | – | – | – | – | – | ❌ |
| 50 | 50 | 160,837 | 62.9 s | 255,000 | 51 | ✅ | ✅ | 0.79 s | ✅ | ✅ | ❌ |
| 100 | 100 | 318,637 | 124.6 s | 505,000 (0.00505 ZEC) | 101 | ✅ | ✅ | 0.53 s | ✅ | ✅ | ❌ |
| 200 | 200 | 634,237 | 254.2 s | 1,005,000 (0.01005 ZEC) | 201 | ✅ | ✅ | 2.54 s | ✅ | ✅ | ❌ |

"Balance eq. + fee checks" means all of the following held:
- `t_in == t_out + NET + fee`
- the implied fee equals the builder's fee
- it equals `Transaction::fee_paid`
- it equals the ZIP-317 fee recomputed from public structure

Sizes vary by ±1 byte between builds because the DER-encoded ECDSA signature is 71 or 72 bytes.
The N = 30 and N = 31 rows only built the tx to measure its size; their fee and logical-action
values come from the formula, not from the run output.

**Size model** (least-squares fit, exact to ±1 byte): `bytes = 3,036 + 3,156 × N` for N ≥ 2.
A V6 Orchard-family action is 820 bytes of description, plus a 64-byte spend-auth signature,
plus 2,272 bytes of proof, which comes to 3,156 bytes. The memo is always a fixed 512 bytes inside the 580-byte `encCiphertext`, so memo
content never changes the size.

- **Under 100,000 bytes:** max N = **30** (built: 97,718 bytes). N = 31 is 100,874 bytes.
  zcashd's historical rule was `size < 100,000`.
- **Real ceilings:**
  - Today (NU6.3): the 2,000,000-byte block, which allows about 632 payouts and leaves nothing
    else in the block.
  - From NU7: **330** Ironwood actions per block and per tx (ZIP-218), shared with every other
    shielded tx in the block.
- **Throughput:** about 1.25 s of proving per payout on this laptop, scaling linearly; 100
  payouts take about 2 minutes.
- **Fee:** `5,000 × (N+1)` zat with 1 t-in and 1 t-out (N ≥ 2). For N = 1 the bundle is padded
  to 2 actions, so by the formula the fee is 15,000 (N = 1 was not run).

**Recommendation (inferred, not measured):** cap batches at about 50–100 payouts per tx and
optionally pad to a fixed bucket (e.g. 64). That keeps proving at 1–2 minutes and leaves room in
the post-NU7 block budget. Use several txs for larger campaigns; the public totals still add up
across txs.

**Historical comparison: Orchard pool at a pre-NU6.3 height** (testnet 4,053,000, NU6.2, V5 tx).
This is the shape the original plan assumed. It no longer works at current heights.
- Sizes are identical to Ironwood within 1 byte: 9,347 / 18,814 / 34,595 / 81,935 / 160,837 /
  318,637 / 634,236 bytes for N = 2…200.
- Every correctness check passed.
- Timings for N ≥ 50 in that table are **not comparable**: a parallel compile of the 0.31 port
  ran at the same time.

## Verifier recomputation (key-less, hosted)

Inputs: the raw tx from the chain, plus each `vin[i].prevout` resolved to its `TxOut` from the
chain. A transaction does not carry its input values. `src/lib.rs::public_view` implements this.

```text
T_in   = Σ_i value(resolve(vin[i].prevout))
T_out  = Σ_j vout[j].value
VB     = valueBalanceSapling + valueBalanceOrchard + valueBalanceIronwood   (signed, as encoded)
NET    = −VB                     # value entering the shielded pools; for a ZecDrop batch = −valueBalanceIronwood
FEE    = T_in − T_out − NET      # = T_in − T_out + VB; consensus guarantees FEE ≥ 0
ASSERT   T_in == T_out + NET + FEE   and   FEE ≥ 0

ZIP-317 (public structure only):
  logical = max(⌈Σ|txin bytes| / 150⌉, ⌈Σ|txout bytes| / 34⌉)
          + max(nSpendsSapling, nOutputsSapling) + nActionsOrchard + nActionsIronwood
  conventional_fee = marginal_fee × max(2, logical)   # librustzcash: 5,000; Zebra mempool minimum: 1,000

Publishable per batch tx: NET (campaign amount shielded), nActionsIronwood (= N for N ≥ 2), FEE,
funding prevouts / addresses, change amount.
```

**Why NET can be trusted without keys:** the binding signature proves that the sum of the
actions' value commitments `cv_net` equals the encoded `valueBalance`. Consensus checks it, and
the test `tampered_value_balance_is_rejected` shows that a single flipped bit fails.

**What the verifier cannot learn:**
- individual amounts (each action exposes only a Pedersen commitment `cv_net` and ciphertexts)
- recipients and memos
- which actions are padding
- whether an action secretly spends a real shielded note, or pays back to the operator

So NET is "value moved from transparent into the shielded pool by this tx". It is not, on its
own, proof that NET reached N distinct third parties; that is what the auditor check adds.

**Auditor completeness check** (implemented as `recover_as_auditor` plus the table's `auditor`
column):
- Decode the campaign UFVK.
- Derive its candidate OVKs: Orchard external and internal, plus the two transparent-derived OVKs
  that `select_ovk` uses for transparent-input txs.
- Recover outputs. Require `count == nActionsIronwood` (N ≥ 2) and `Σ value == NET`.
- An output built with OVK=None, or a hidden spend/output pair, breaks one of these equalities.

## Task 6 — zcash_client_backend 0.24.0: can it do this in one tx?

**Yes, contrary to the plan's assumption** (read from source, not executed):

1. `propose_transfer(…, spend_policy: &SpendPolicy, …)` (`data_api/wallet.rs:778-788`) accepts
   `SpendPolicy::…::with_transparent(TransparentSpendPolicy::from_one_address(taddr))`
   (`data_api/wallet/input_selection.rs:549-555, 636-651`). `GreedyInputSelector::propose_transaction`
   then gathers that address's UTXOs (`input_selection.rs:1023-1042`) and returns
   `Proposal::single_step` (`input_selection.rs:2010`); only TEX recipients make it two-step.
   `create_proposed_transactions` → `build_proposed_transaction` sends UA payments through
   `add_ironwood_output` after NU6.3 (`data_api/wallet.rs:2308-2312`).
   `shield_transparent_funds` (`wallet.rs:4021`) is the self-only variant.
2. **But change is always shielded unless the net flows are fully transparent**
   (`fees/common.rs:371-377`; `TransparentChangePolicy` in `fees.rs:85-98`). The campaign's change
   becomes an Ironwood note, so the public `NET` = Σ payouts + change. That breaks the public-total
   property unless the funding UTXO is exact.
   `OvkPolicy::Sender` with transparent inputs uses the transparent-derived OVK
   (`wallet.rs:2140-2152`); `OvkPolicy::Custom` allows a per-campaign OVK.
3. It also needs a synced `WalletRead`/`WalletWrite`/`InputSource` backend (e.g.
   zcash_client_sqlite). **Recommendation:** build batches with the low-level `Builder` (as this
   spike does) for exact control of change, OVK, padding and flags. Use client_backend or
   lightwalletd only for chain data (UTXOs, prevout resolution, anchors).

## Task 7 — Ironwood

Sources were read directly unless marked otherwise. Facts relayed from the research sub-agent
without independent re-checking are marked *(agent-reported)*.

- **What it is:** a **new shielded value pool introduced by network upgrade NU6.3**
  (ZIP-258; ZIP-229 defines the v6 tx format, *(agent-reported)* for ZIP-229).
  - It uses the Orchard protocol: the same Action encoding, the post-NU6.3 Halo2 circuit (shared
    with Orchard), and keys and receivers derived the same way.
  - It has its own note-commitment tree, anchor and pool balance.
  - Notes use plaintext version V3 (lead byte `0x03`). Orchard notes stay V2.
  - It is not NU7, not ZSA, and not a renamed Orchard.
  - It came with a fix: NU6.2 replaced an unsound Orchard circuit (orchard 0.15.5 doc comment for
    `ProtocolVersion::InsecureV1`).
  - Orchard became an outflow-only legacy pool, with ZIP-318 defining denominated
    Orchard→Ironwood migration.
- **Activation:** NU6.3 consensus branch id `0x37A5165B`.
  - **Mainnet:** height 3,428,143. **Active**: tip was 3,509,655 on 2026-10-07 per
    zcashexplorer.app (chain-tip branch `37a5165b`) and blockchair.
  - **Testnet:** height 4,134,000. **Active**: explorer tip 4,331,234, estimated height 4,365,957.
  - The heights match librustzcash `zcash_protocol` 0.10.6 and Zebra `zebra-chain` constants
    (commit 22a88d5).
- **ZIP status:** ZIP-258, ZIP-229, ZIP-318 and ZIP-326 are still marked *Draft*, even though
  NU6.3 is deployed. zcashd does not implement NU6.3, so Zebra is the only validator (ZIP-258).
- **librustzcash support:** yes, in the stable train with no cfg flags.
  - zcash_protocol 0.10.x has `BranchId::Nu6_3`.
  - zcash_primitives 0.29+ has `TxVersion::V6`, `Builder::add_ironwood_output` / `add_ironwood_spend`,
    and the ZIP-317 rule counts Ironwood actions like Orchard ones.
  - orchard 0.15 has `ValuePool::Ironwood` and `BundleVersion::ironwood_v3`.
  - zcash_client_backend 0.24 routes UA payments to Ironwood.
- **Recommended pool for new outputs: Ironwood.** It is effectively mandatory: ZIP-326 says a
  wallet "MUST NOT send funds to any external receiver … in the Orchard pool after NU6.3", and
  consensus rejects it anyway.
- **Address formats:** unchanged. Ironwood pays to the UA's **Orchard receiver** (typecode 0x03):
  - `zcash_keys/src/address.rs:447`: "Ironwood shares the Orchard receiver".
  - ZIP-229: "does not change address structures or encodings" *(agent-reported)*.
  - UFVK/UIVK encodings are unchanged. Our `uviewtest1…` UFVK decrypts Ironwood outputs.
- **Next upgrade, NU7** (ZIP-259, branch `0x77190AD9`):
  - Testnet height **4,465,026** (Zebra `constants.rs:76`; zcash_protocol 0.11.0-pre.0 changelog).
    **Already active on testnet**: a live `GetLightdInfo` reported tip 4,475,588 on branch `77190ad9`.
  - Mainnet height TBD *(agent-reported: "to be set on Oct 20")*.
  - ZIP-218 limits: 330 actions per pool and 330 shielded actions per block in total (Zebra
    `zebra-consensus/src/block.rs:191-197`). The mempool enforces it per tx as well
    (`zebra-consensus/src/transaction.rs:488-497`, `TooManyShieldedActions`).
  - 25-second blocks (`POST_NU7_POW_TARGET_SPACING = 25`).
  - The research agent reported a "tentatively Nov 5th 2026" testnet date from Zebra notes. It
    is superseded: NU7 is already active on testnet.

### Zebra / zcashd size policy (task 5)

- **Zebra** (commit `22a88d5`, 2026-10-07): there is **no** `MAX_STANDARD_TX_SIZE`-like constant.
  A grep for `MAX_STANDARD_TX_SIZE|MAX_TX_SIZE|MAX_TRANSACTION_SIZE|STANDARD_TX_SIZE` finds
  nothing.
  - The only size bound is `MAX_BLOCK_BYTES = 2_000_000` (`zebra-chain/src/block/serialize.rs:24`).
    The tx deserializer is bounded by it.
  - Mempool admission uses the ZIP-317 rules in `zebra-chain/src/transaction/unmined/zip317.rs`:
    `MARGINAL_FEE = 1_000`, `BLOCK_UNPAID_ACTION_LIMIT = 0`, and a minimum fee rate of
    100 zat/kB capped at 1,000.
  - From NU7, ZIP-218 action limits also apply.
- **zcashd** *(agent-reported)*: `MAX_TX_SIZE_BEFORE_SAPLING = 100000` and
  `MAX_TX_SIZE_AFTER_SAPLING = MAX_BLOCK_SIZE`. There is no `MAX_STANDARD_TX_SIZE` in
  `policy.h` on master. The 100 KB limit was a pre-Sapling *consensus* rule.

## Port to the 0.31 pre-release train (NU7-aware)

[`port-0.31/`](./port-0.31) holds the same library on the NU7-aware train: zcash_primitives
0.31.0-pre.1, zcash_transparent 0.11.0-pre.1, zcash_keys 0.17.0-pre.1, zcash_address
0.14.0-pre.1, zcash_protocol 0.11.0-pre.0, orchard 0.16.0, zip32 0.3.0, sapling-crypto 0.9.0,
zcash_client_backend 0.25.0-pre.1, rand_core/rand_chacha 0.10, secp256k1 0.33.

**It compiled, and all 11 tests pass** (`cd port-0.31 && cargo test`). That includes
`ironwood_batch_works_after_nu7_on_0_31_train`: at testnet height 4,466,026 the same code builds a
V6 tx on branch **NU7 `0x77190AD9`** that balances, verifies, and passes the auditor
Σ == NET check.

The port needed five call-site changes:
1. `UnifiedFullViewingKey::transparent()` → `p2pkh()`.
2. `UnifiedFullViewingKey::encode` / `decode` now return typed errors (ZIP-316 Rev 2 encoding).
3. `UnifiedAddress::from_receivers` gained `expiry_height` and `expiry_time` arguments (ZIP-316
   address-expiry metadata).
4. `AccountPubKey::ovks_for_shielding()` returns a `ShieldingOvks` struct instead of a tuple.
5. secp256k1 0.33 uses `ecdsa::verify(&sig, msg, &pk)` instead of a context.

This train also removes the `=`-pinned RustCrypto pre-releases (caveat 7). It is **pre-release**,
so expect API churn before 0.31.0 final.

## Who can scan Ironwood notes (product risk)

These verdicts come from source and changelogs read by a research sub-agent *(agent-reported)*.
I re-checked two lockfiles myself (✔). No end-to-end wallet scan of a live Ironwood note was done.

| Component | Ironwood scanning | Notes |
|---|---|---|
| `zcash_client_backend` 0.24.0 / `zcash_client_sqlite` 0.22.0 | **yes** | Ironwood scanning keys, `ScannedBlock::ironwood`, Ironwood balance and tree tables. lightwallet-protocol v0.5.0 adds `CompactTx.ironwoodActions` and `TreeState.ironwoodTree` |
| Zodl SDKs (`zodl-inc/zodl-swift-wallet-sdk`, `zodl-android-wallet-sdk`) | **yes** from 2.7.0 (Ironwood receive/sync/send); latest 5.0.0 | apps 3.8.0+ (iOS/Android) show Ironwood. ✔ the Swift SDK `main` locks `zcash_protocol` **0.10.5** |
| `zcash-devtool` | **yes** (sync, balance, shield/send into Ironwood) | ✔ `main` locks `zcash_client_backend` 0.24.0 and `zcash_protocol` **0.10.5** |
| lightwalletd v0.5.0+ / Zaino 0.6.0+ | **yes** (serve Ironwood compact actions and tree state) | `testnet.zec.rocks` runs lightwalletd v0.5.4 |

**Risk:**
- On **mainnet** (NU6.3), current wallets can see Ironwood payouts.
- On **testnet**, NU7 is active, but every released wallet stack above locks `zcash_protocol`
  0.10.5, which has no testnet NU7 height. The Swift SDK refuses a server whose branch id differs
  from its own (`compactBlockProcessorWrongConsensusBranchId`). So **testnet recipients probably
  cannot sync in current Zodl or devtool builds** (inferred).
- For testnet demos, show recipient decryption with this repo's tooling (`live-batch verify`,
  `drop_zcash::inspect::decrypt_with_ivk`), or with a wallet built on the 0.25-pre stack.

## Phase 2 — live testnet

**Status (2026-10-08): DONE.** The batch was **mined on public testnet**; details under
["Live result"](#live-result-2026-10-08). The wallet, endpoint, dry run and `drop-zcash` port are
done too.

**Tools** (in `port-0.31/`, same crate train as the workspace):
- `gen-testnet-wallet`
- `live-batch info | probe | treestate [h] | dry-run [--fabricate] | send | verify <txid> | resend <txid>`

**Dev seed:** `~/.zecdrop-dev/testnet.seed`, outside the repo.
- Directory mode 0700, file mode 0600. The file is created with `create_new`, so it is never
  overwritten, and a file readable by group or others is refused.
- The seed is zeroized after use and never printed.
- The campaign is ZIP-32 account 0. The live batch pays demo recipients 1–3, which are accounts
  9000–9002 of the same seed (the demo range in `examples/README.md`).
- Funding (transparent) address: `tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD`. The campaign UFVK is
  printed by the tool but deliberately not recorded here.

**Testnet only:**
- All key and builder code uses testnet parameters.
- `live-batch` refuses a server whose chain name is not `test`/`testnet`.
- It also refuses if the server's branch id differs from the one the crates compute for `tip + 1`.

**Endpoint:** `https://testnet.zec.rocks:443`, **verified** with `GetLightdInfo`:
- vendor "ECC LightWalletD", version v0.5.4, chain `test`;
- consensus branch `77190ad9` (NU7), tip 4,475,588.

Not reachable from here: `lightwalletd.testnet.electriccoin.co:9067` (TCP timeout) and
`testnet.lightwalletd.com` (no DNS).

**Client:** the gRPC client from `zcash_client_backend` 0.25.0-pre.1, with features
`lightwalletd-tonic-transport` and `lightwalletd-tonic-tls-webpki-roots`, over tonic 0.14
(rustls/ring, webpki roots). `TreeState` has an `ironwood_tree` field; the anchor is its root at
the tip.

**Dry run** (`live-batch dry-run --fabricate`: a fake coin, but the live anchor and live height):
- Built a **V6 tx at height 4,475,590 on branch NU7**: 12,504 bytes, 3 Ironwood actions, fee
  20,000 zat.
- Proof and signatures verify locally. Not broadcast.

**`TxFilter.hash` byte order:** `live-batch probe` fetched the tip block's first transaction by its
compact-block txid. It was found with the **internal** byte order (`TxId::as_ref`), not display
order. `get_tx` falls back to the reversed order anyway, and checks the returned txid.

**Broadcast flow** (`live-batch send`):
1. Write the raw bytes to `~/.zecdrop-dev/pending/<txid>.hex` before sending (AGENTS.md
   invariant 3).
2. `SendTransaction`.
3. Poll `GetTransaction` every 15 s until the tx is mined.
4. Re-fetch the tx and resolve its prevouts with `GetTransaction`.
5. Recompute the public totals and verify the proof and signatures.
6. Decrypt with the campaign UFVK and with recipient #1's IVK.
7. Write a public-data-only fixture to `fixtures/testnet-ironwood-batch/<txid>/` (`tx.hex`,
   `prevouts.json`, `expected.json`).

### Live result (2026-10-08)

**Funding and dry run:**
- The faucet coin `daa6b06c262411bad8c962228756fb93895bacf72bc8871e603313f4a32a8e2e:0` (12,500,000 zat)
  was mined at 4,478,055.
- The dry run on the real coin matched the expected numbers: target tip+1, the real Ironwood
  anchor, 10,000 / 20,000 / 30,000 zat out, fee 20,000, change 12,420,000.

**Send:**
- `live-batch send` built txid **`50fb88e02e7f4b0f3b3b658f50b09b12ea973d8c3697f8bad4c59e41075ea3e3`**
  for target 4,478,064. The anchor was `5a97621d…b80e`, from `GetTreeState` at the tip.
- It persisted the raw bytes, then broadcast. `SendTransaction` was accepted (code 0).
- The tx was **mined at height 4,478,065, 31 s later**. On-chain acceptance of the shape is now
  confirmed, no longer inferred.

**Fetched back from the chain:**
- V6 on branch NU7, 12,503 bytes.
- `t_in 12,500,000 = t_out 12,420,000 + net into Ironwood 60,000 + fee 20,000`.
- `valueBalanceOrchard 0`, 3 Ironwood actions; the proof and all signatures verify.

**Decryption:**
- The campaign UFVK recovers 3 outputs summing to 60,000.
- `recipient_view` for each of recipients 1–3 decrypts exactly its own 10,000 / 20,000 / 30,000
  zat and memo, and none of the others.

**Fixture:** `fixtures/testnet-ironwood-batch/<txid>/`.

**Hosted verifier:** a local `drop-verifier` pointed at the same endpoint returned HTTP 200 with
`net_into_pool 60000`, `fee 20000`, `shielded_actions 3`, `pool ironwood`, `findings []` and phase
`settled`.

**Re-send of the mined tx** (`live-batch resend`), verbatim from Zebra via lightwalletd v0.5.4:
code -1, "any transaction with the same effects will be rejected from the mempool until a chain
reset: transaction was committed to the best chain".
- No phrase in the original "already known" list matched it, so drop-chain now asks the node for
  the txid after any refusal.
- It also recognises exactly "transaction was committed to the best chain". The same prefix also
  covers expired, double-spent and evicted transactions, so the prefix alone is not matched.
- A live test re-sends this tx through drop-chain and gets `AlreadyKnown` at height 4,478,065.

### Port into `crates/drop-zcash` (`cargo test -p drop-zcash`: 28 tests pass, about 14 s)

| Module | What |
|---|---|
| `keys` | `CampaignKeys`: one ZIP-32 account per campaign, a funding and a change P2PKH address, the payout OVK. `Debug` is redacted, and seeds shorter than 32 bytes are refused instead of panicking |
| `memo` | ZIP-302 text memos: 512 bytes max, rejected before building; no memo encodes as `0xF6` (REQ-TX-003) |
| `codec` | `ZcashAddressCodec` implements `drop_core::AddressCodec`. A UA with an Orchard receiver is `Unified`. A Sapling-only UA or a standalone `zs` address is `UnsupportedReceiver`, because an Ironwood batch cannot pay it. t/TEX addresses are `Transparent`; the other network is `WrongNetwork`. All-uppercase Bech32m is accepted. Errors never echo the address |
| `builder` | `build_batch_tx`: transparent in, Ironwood out, OVK always set (REQ-TX-001/002). Before any proving it refuses more than 330 payouts, pre-NU6.3 heights, coins it can't sign for, insufficient funds and dust change. The fee follows core's `FeePolicy` through the `non-standard-fees` ZIP-317 rule, so the engine's funding check and the tx agree |
| `inspect` | Public totals, a proof and signature check, and UFVK/IVK recovery. `RecoveredOutput`'s `Debug` is redacted |
| `chain` | A `ChainBackend` port: tip, Ironwood anchor, prevout, submit (idempotent), status |
| `distributor` | `ZcashDistributor` implements `drop_core::Distributor`. It refuses mainnet keys, and `classify` treats chain errors and a not-yet-visible funding coin as transient, everything else as permanent. Tested end to end through `drop_core::Engine` with an in-memory chain |

The builder is tested at both a testnet NU7 height and a mainnet NU6.3 height (ADR 0005; the
mainnet build is offline with TEST-ONLY keys).

The lightwalletd implementation of `ChainBackend` is not in `drop-zcash`, which stays free of
network code. `port-0.31/src/lwd.rs` is the working reference.

## Fallbacks, had Ironwood broadcast failed (not needed; inferred, none built)

1. **Two transactions.** First shield the funding to the campaign's own shielded address (e.g.
   with `shield_transparent_funds`), then send a shielded → N payouts tx.
   - The first tx's `NET` still publishes the campaign total.
   - The second tx's valueBalance shows only the fee, so per-batch totals become auditor-only.
2. **Sapling outputs.** Transparent → N Sapling outputs. ZIP-258 adds no Sapling inflow
   restriction, and `BranchId::Nu6_3.has_sapling()` is true.
   - About 948 bytes per output description (cv, cmu, epk, ciphertexts, 192-byte Groth16 proof).
   - Needs Sapling params and recipients with Sapling receivers.
   - Limited to 300 Sapling I/O per block from NU7.
   - Sapling is the older pool, so this is a regression rather than a target.

## Not done / not verified

- Testnet acceptance is confirmed with a real anchor from `GetTreeState`. Whether the
  *empty-tree* anchor would also be accepted was never tested, and is no longer needed.
- The transparent script interpreter (`zcash_script`) was not run. Instead the spike checks the
  ECDSA signature against the ZIP-244 sighash and checks HASH160(pubkey) against the prevout.
- Only P2PKH funding was tested; P2SH/multisig funding was not.
- The `zcash_client_backend` path was read, not executed.
- Some ZIP texts and the zcashd source were read by a research sub-agent (marked
  *agent-reported*). The Zebra constants and the ZIP-258, ZIP-218 and ZIP-326 quotes above were
  re-checked directly.
