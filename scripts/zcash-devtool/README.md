# zcash-devtool, for the shielded deposit address

The operator's shielded deposit address (docs/ADR/0006-shielded-inbox.md, `--zcash-devtool`) is a wallet that
[zcash-devtool](https://github.com/zcash/zcash-devtool) runs, as a separate process. It is optional: without it the operator
works exactly as before.

```sh
scripts/zcash-devtool/build.sh      # the first build takes a while
target/debug/drop-operator --lightwalletd-url https://testnet.zec.rocks:443 --zcash-devtool target/zcash-devtool/zcash-devtool …
```

## Provenance

- **Upstream:** zcash-devtool by the Electric Coin Company, `MIT OR Apache-2.0`, built from source at commit
  `b532d4cd760d30213c961fe0638ee6b6e1bf8e30` (2026-10-15) by `build.sh`. None of its code is in this repository; the clone
  lives under `target/` and is never committed.
- **`zecdrop.patch`:** written for ZecDrop during the build window, and the only change made to upstream:
  - `pczt sign` also signs Ironwood spends from the wallet's own seed, with the pczt crate's own `Signer::sign_ironwood` and the
    account's Orchard spend authorizing key (as it already does for Orchard);
  - `pczt create` and `pczt create-max` take `--ironwood-only`, which restricts input selection to Ironwood notes;
  - `pczt extract` takes `--tx-out <file>`, which also writes the extracted transaction's bytes, so the operator checks exactly
    what it broadcasts (`drop_zcash::InboxKeys::check_move`).
- The operator refuses a zcash-devtool without these flags at start-up.
