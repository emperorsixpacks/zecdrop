# Provenance of zcash-devtool

The operator's shielded deposit address (docs/ADR/0006-shielded-inbox.md, `--zcash-devtool`) is a wallet that zcash-devtool
runs, as a separate process. **None of zcash-devtool's code is in this repository.** `build.sh` clones it under `target/` (never
committed), checks out a pinned commit, applies `zecdrop.patch` and builds it.

| | |
|---|---|
| Upstream | <https://github.com/zcash/zcash-devtool> |
| Commit | `b532d4cd760d30213c961fe0638ee6b6e1bf8e30` (2026-10-15) |
| Licence | `MIT OR Apache-2.0`, Electric Coin Company (its `Cargo.toml`) |
| Built by | `build.sh`: clone, check out that commit, `git apply zecdrop.patch`, `cargo build --release --locked`, copy the binary to `target/zcash-devtool/zcash-devtool` |
| Changed by | `zecdrop.patch`, written for ZecDrop during the build window |

**The patch is ours.** Its added lines were written for ZecDrop; its context lines are upstream's, as in any patch, and only
place the change. It is the only change made to upstream:

- `pczt sign` also signs Ironwood spends from the wallet's own seed, with the pczt crate's own `Signer::sign_ironwood` and the
  account's Orchard spend authorizing key (as it already does for Orchard);
- `pczt create` and `pczt create-max` take `--ironwood-only`, which restricts input selection to Ironwood notes;
- `pczt extract` takes `--tx-out <file>`, which also writes the extracted transaction's bytes, so the operator checks exactly
  what it broadcasts (`drop_zcash::InboxKeys::check_move`).

The operator refuses a zcash-devtool without these flags at start-up.

**Nothing from another entry.** Another ZECATHON entry also drives zcash-devtool. None of its code, its patch or its binary is
used here: the patch and the operator's driver (`crates/drop-operator/src/inbox/`) were written fresh (AGENTS.md).

To update: move `REV` in `build.sh` to a newer commit, check that `git apply --check` still accepts the patch (or rewrite it),
rerun the inbox tests and a testnet run (`docs/runbooks/testnet-demo.md`), and update the table.
