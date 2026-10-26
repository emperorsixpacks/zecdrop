# zcash-devtool, for the shielded deposit address

The operator's shielded deposit address (docs/ADR/0006-shielded-inbox.md, `--zcash-devtool`) is a wallet that
[zcash-devtool](https://github.com/zcash/zcash-devtool) runs, as a separate process. It is optional: without it the operator
works exactly as before.

```sh
scripts/zcash-devtool/build.sh      # the first build takes a while
target/debug/drop-operator --lightwalletd-url https://testnet.zec.rocks:443 --zcash-devtool target/zcash-devtool/zcash-devtool …
```

## Provenance

Upstream zcash-devtool at a pinned commit, with `zecdrop.patch`, the only change, written for ZecDrop: see
[`PROVENANCE.md`](PROVENANCE.md). None of zcash-devtool's code is in this repository.
