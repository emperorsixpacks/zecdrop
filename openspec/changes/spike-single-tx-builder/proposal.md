# spike-single-tx-builder

## Why
The whole product claim depends on one transaction shape (ADR 0001). If it cannot be built and decrypted with the
current crates, the pitch changes. Find out first, offline, with throwaway keys.

## What
Standalone crate `spikes/single-tx-builder/`: build a testnet-parameter transaction with transparent inputs and
N **Ironwood** outputs (V6), re-parse it, recompute public totals, decrypt with recipient IVK and campaign UFVK,
prove the `OVK = None` negative, show that the Orchard-output variant violates ZIP-258, and measure size, proving
time and fee for several N. Also report which SDKs can scan Ironwood notes (recipients must see their funds).

## Gate
Go / no-go by **Oct 9**. Results in `spikes/single-tx-builder/RESULTS.md` and an update to ADR 0001.
On GO, working code moves into `drop-zcash`; the spike directory is then deleted.

## Out of scope
Broadcasting, real funds, networking.
