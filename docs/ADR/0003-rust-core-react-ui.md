# 0003 — Rust core on librustzcash, React UI

Status: Accepted
Date: 2026-10-07

## Context

Options: drive a CLI wallet from TypeScript; build in the browser with a WASM wallet; or use the Rust crates
directly. The documentation we read describes `zcash-devtool` as "not production-ready" with an unstable CLI
and Zallet as beta with many RPC methods unimplemented. A browser WASM wallet could not be confirmed to
support multi-recipient sends or transparent funding.

## Decision

Rust workspace on `librustzcash` crates for everything touching keys, transactions and chain data. React + Vite +
Tailwind for the UI. `drop-core` stays free of zcash dependencies behind ports so the domain is testable in isolation.

## Consequences

- Supported primitives, typed errors, strong tests; slower start than scripting a CLI.
- Compile times are long; spikes live outside the workspace so they cannot break it.
- Crate versions and MSRV are pinned after the spike (recorded in `spikes/single-tx-builder/RESULTS.md`).
