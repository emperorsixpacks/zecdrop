# How big can one payout be?

One ZecDrop batch is one Zcash transaction. This page says what that costs in size, fee and time, measured offline with the
repository's own builder. Nothing here is sent anywhere.

| Payouts in the batch | Transaction size | Network fee | Time to prove and sign | Time to verify |
|---:|---:|---:|---:|---:|
| 2 | 9.3 KB | 0.00015 ZEC | 0.9 s | 0.01 s |
| 10 | 34.6 KB | 0.00055 ZEC | 3.9 s | 0.02 s |
| 50 | 160.8 KB | 0.00255 ZEC | 19.5 s | 0.08 s |
| 100 | 318.6 KB | 0.00505 ZEC | 43 s | 0.16 s |
| 330 | 1,044.5 KB | 0.01655 ZEC | 142 s | 0.52 s |

- **Size** is about 3 KB plus 3.16 KB per payout (each payout carries a 512-byte memo and its proof share).
- **Fee** is the ZIP-317 conventional fee at 5,000 zat per logical action: one per payout plus one for the transparent side. The
  fee a recipient pays for being in a batch is about 0.00005 ZEC. It is paid once, by the campaign, from the deposit.
- **Time** is the best of three runs (one run for 330) of building the transaction: signing and the Halo2 proof, which dominates.
  The proof is made once per batch, on the operator's own machine; a restart resumes from the stored transaction and never
  proves again. Verifying is what a node, the key-less verifier and a payslip check do, and it is fast.
- **Limit:** one transaction can carry at most 330 shielded outputs (ZIP-218). A campaign of more recipients needs several
  batches, and the funding-split step that would pay for them from one deposit is **not built** (`needs_funding_split`).
- **Not included:** broadcasting and confirming. Blocks come about every 75 seconds on mainnet today (25 seconds on testnet),
  and a batch settles at three confirmations.

## How it was measured

Apple M1 Pro, 10 cores, 16 GB, on 2026-10-18, with TEST ONLY keys and a made-up funding coin (no network). Other programs were
running (the machine's load average was 8 to 20 during the run), so the times are probably a little slower than on an idle
machine, and they will differ on yours. The proving key is built in memory on first use, which the first run of any size
includes and the warm-up run before the table removes.

```bash
cargo run --release -p drop-zcash --example batch_bench -- [--repeat K] [N ...]    # default sizes 2 10 50 100 330
```

The size and the fee are exact and do not depend on the machine; they are asserted by the builder's tests
(`crates/drop-zcash/src/builder.rs`).
