# Provenance of the gRPC protocol definitions

`proto/compact_formats.proto` and `proto/service.proto` are the canonical Zcash light wallet
protocol definitions (the `CompactTxStreamer` service that lightwalletd and Zaino serve).

| | |
|---|---|
| Upstream | <https://github.com/zcash/lightwallet-protocol> |
| Tag | `v0.5.0` (annotated tag, 2026-06-30) |
| Commit | `ac7cee052a1bf5d430985a478d39e8b513fc4bd4` |
| Files | `walletrpc/compact_formats.proto`, `walletrpc/service.proto`, unmodified |
| Fetched | 2026-10-07, from `raw.githubusercontent.com` at that tag |
| Licence | MIT, Copyright (c) 2019 Electric Coin Company. Notice kept in `proto/LICENSE`. |

**Why v0.5.0.** It is the first tag with Ironwood: `CompactTx.ironwoodActions`,
`ChainMetadata.ironwoodCommitmentTreeSize`, `PoolType.IRONWOOD`, `ShieldedProtocol.ironwood`
and `TreeState.ironwoodTree`. It is also the protocol version the public servers report in
`GetLightdInfo` (`lightwalletProtocolVersion`). The earlier tags (v0.4.x) lack those fields.

**The Rust is generated, not copied.** `build.rs` runs `tonic-prost-build` over these two files
at build time and `src/lib.rs` includes the output. Nothing generated is checked in. Building
needs `protoc` on the `PATH` (or in `PROTOC`); CI installs it with `arduino/setup-protoc`.

**Why not `zcash_client_backend`.** It already contains a generated client, but it depends on
`zcash_keys` unconditionally. The hosted verifier depends on this crate and must have no
key types in its dependency closure (REQ-VER-002, checked by
`crates/drop-verifier/tests/no_keys.rs`).

To update: replace the two files from a newer tag, re-check that the fields above still exist,
and update the table.
