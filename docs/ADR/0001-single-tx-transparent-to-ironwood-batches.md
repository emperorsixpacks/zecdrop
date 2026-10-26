# 0001 — One transaction per batch: transparent inputs → Ironwood outputs

Status: **Accepted — proven on public testnet.** On 2026-10-08 a batch built this way was accepted by the network and
mined (txid `50fb88e02e7f4b0f3b3b658f50b09b12ea973d8c3697f8bad4c59e41075ea3e3`, height 4,478,065, V6 on NU7 branch `0x77190ad9`); the lead fetched it back independently.
Evidence: `spikes/single-tx-builder/RESULTS.md` (offline) and `fixtures/testnet-ironwood-batch/` (the real transaction).
Supersedes the first draft, which targeted the Orchard pool.

Spike results (offline, 11 tests, run by the spike agent): one P2PKH input → N Ironwood outputs with 512-byte
memos + transparent change builds as a V6 transaction; the proof and all signatures verify; `t_in = t_out + net +
fee` holds exactly from public data; recipients decrypt their own outputs; the campaign UFVK recovers all N and the
sum equals the public total; with no OVK the sender recovers nothing. Measured: bytes = 3,036 + 3,156·N, about
1.25 s of proving per payout (N=50 ≈ 63 s, N=100 ≈ 125 s on an M1 Pro).
Date: 2026-10-07

## Context

The product claim is "private amounts, public accountability". On Zcash this needs a transaction whose total is
public and whose individual outputs are hidden. A transparent input balanced against shielded outputs does this:
the net value entering the shielded pool is public, each output is a commitment, and the binding signature forces
the sum to match when the batch has no real shielded spends.

**Correction found on 2026-10-07.** The first draft put the outputs in the Orchard pool. ZIP-258 (Draft; NU6.3,
branch id `0x37A5165B`, active on mainnet from height 3,428,143 and on testnet from 4,134,000 per an explorer and
the ZIP) states: *"No new value may enter the Orchard pool: for every transaction, v^OrchardPoolBalance ≥ 0."*
ZIP-326 (Draft) adds: *"A wallet MUST NOT send funds to any external receiver … in the Orchard pool after NU6.3
activation."* A transparent → Orchard batch is therefore very likely **consensus-invalid**. New value goes to the
**Ironwood** pool (V6 transactions, ZIP-229), which reuses the Orchard action structure.

## Decision

Each batch is one V6 transaction with transparent inputs, **Ironwood** outputs only, and optional transparent
change. Use the lower-level `zcash_primitives` `Builder` (`add_ironwood_output`), because we believe the wallet
framework's `propose_transfer` spends only shielded notes and `shield_transparent_funds` shields to self
(**unverified**; spike). Recipients' existing Unified Addresses are unchanged: ZIP-229/326 reuse the Orchard
receiver (typecode `0x03`) (**per a research report; spike to confirm**).

## Consequences

- The public total of each batch is recomputable by anyone from the Ironwood pool value balance (REQ-VER-001).
- Batch size, fee and timing are public; singleton or uniform batches make amounts derivable
  (`PRIVACY_BOUNDARY.md` §1).
- **Crate train.** The stable train (`zcash_primitives` 0.30.1) already supports V6 and Ironwood but (a) does not know
  NU7, which is **already active on public testnet** (from height 4,465,026; verified live: branch `77190ad9` at a tip
  near 4.47M), so a stable-train builder stamps NU6.3's branch id and builds transactions testnet rejects today, and (b) pins
  `crypto-common =0.2.0-rc.1` and `bip32 =0.6.0-pre.1`, which fail to resolve beside `drop-core`'s `sha2 0.11`. The
  workspace therefore uses the **0.31 pre-release train** (`zcash_primitives` 0.31.0-pre.1, `orchard` 0.16.0,
  `zcash_protocol` 0.11.0-pre.0, …), which the spike ported with 5 call-site changes. Pin exact versions, commit the
  lockfile, expect API churn.
- **Low-level `Builder`, not `zcash_client_backend`.** The wallet framework can build this in one transaction
  (`SpendPolicy::with_transparent`) but always shields change, which would inflate the public total. Use the
  framework only for chain data.
- **The public cannot prove the outputs reached distinct third parties** (see `PRIVACY_BOUNDARY.md`); the auditor
  check (count and sum) is what closes that.
- **Batch size.** Real ceilings are the 2 MB block now (~632 payouts) and 330 actions per transaction from NU7.
  Proving time scales linearly, so default to about 50 payouts per batch.
- **Product risk:** a recipient's wallet must be able to scan Ironwood notes to show the funds. Unverified; the
  spike reports which SDKs can.
- **Consensus validity is now confirmed on testnet** (the broadcast above: 1 transparent input, 3 Ironwood outputs, change
  returned, real Ironwood anchor from `GetTreeState`). Still unproven: mainnet (NU6.3) acceptance and batches above 3 outputs.
- **Fallback if the spike fails:** shield first, then send shielded→shielded. That loses the public sum-check; the
  claim weakens to "auditor-verifiable" and the pitch and specs change. Decide at the spike gate.
