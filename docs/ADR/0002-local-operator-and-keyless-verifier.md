# 0002 — Local operator holds keys; hosted verifier holds none

Status: Accepted
Date: 2026-10-07

## Context

A privacy product that asks users to hand a server their spend key undercuts itself. Judges still need
something they can open.

## Decision

Two deployables. `drop-operator` runs locally, holds the seed, syncs, builds and sends, and embeds the web UI.
`drop-verifier` is hosted, read-only and key-less: it fetches transactions by id and recomputes public totals.
Audit decryption (needs a UFVK) runs only in the local binary, never on the hosted service.
A hosted **testnet sandbox operator** was considered for the judged demo and is **not built**: it would need a reverse
proxy, which undoes the loopback and Host-header protections (see `docs/SECURITY.md`). The demo is the hosted verifier
plus a recorded local run.

## Consequences

- Strong trust story; the hosted attack surface holds no secrets.
- Two binaries to build and document; the verifier core (`drop-verify`) is shared.
- The operator UI needs local-API protection (loopback bind + per-run token).
