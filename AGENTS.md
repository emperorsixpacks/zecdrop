# ZecDrop — AGENTS.md

Single source of truth for every contributor and coding agent (`CLAUDE.md` and `GEMINI.md` only point here).
Language: **English only**, in code, comments, specs and docs.

## What this is

ZecDrop — confidential batch payouts on Zcash. **Private amounts, public accountability.**
One transaction per batch spends transparent funds into N Ironwood shielded outputs (Orchard can no longer
receive new value, ADR 0001/0005). Consensus makes the
net value entering the pool public and every output amount hidden, so anyone can recompute how much was
shielded (and the fee) from chain data, while only the recipient (and an auditor with a viewing key) can read an
amount. Only the auditor can confirm the outputs match the payout list (`docs/PRIVACY_BOUNDARY.md`).

Built for ZECATHON, track **Shielded Payments**. Status: works end to end on public testnet, no mainnet payout, not audited;
each part's state is in `openspec/changes/` and the README's "Status".

## Hackathon constraints (these are rules, not preferences)

- **All code is written during the build window.** Libraries are fine; copying existing products is not.
  **Never copy, paste or lightly edit any file from another project.** Write fresh. Generated code must name its
  generator in `PROVENANCE.md`.
- Repo must be public by **Oct 28, 2026 23:59 UTC**. Until then keep it private and keep secrets out of history.
- Submission needs: working demo, two-minute video, description, public repo. See `docs/HACKATHON.md`.

## Commands

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps
python3 -I scripts/spec_drift.py          # every implemented REQ-ID has a covering test
cd web && npm ci && npm run lint && npm run typecheck && npm test && npm run build
# Real-browser checks. Need `cargo build -p drop-operator` first (they start target/debug/drop-operator
# on the mock chain) and, once per machine, `npx playwright install chromium`:
node scripts/capture-operator-fixtures.mjs --check   # fixtures/contract/operator still match the binary
cd web && npm run e2e                                # builds web/dist, then Playwright (public and operator)
# Only for the shielded deposit address (--zcash-devtool, testnet; docs/ADR/0006): zcash-devtool from upstream with our patch.
scripts/zcash-devtool/build.sh
# The launcher (openspec REQ-RUN-001): the operator in Docker, on testnet, on this computer. `help` lists its commands;
# crates/drop-operator/tests/launcher.rs checks the script. Its data is in ~/.zecdrop-app (or $ZECDROP_HOME): never print it.
shellcheck zecdrop
./zecdrop up                                         # builds deploy/operator.Dockerfile the first time
```

`npm run e2e` is not in the CI job yet: it needs the built operator binary and a browser. Run it before
changing anything the operator pages depend on (the operator API, `web/dist`, the CSP).

`spikes/` is excluded from the workspace on purpose; each spike has its own lockfile and target dir.

## Architecture

```
drop-core      chain-agnostic domain. NO zcash dependencies. Ports: Distributor, Ledger, AddressCodec
drop-zcash     keys (one ZIP-32 account per campaign), single-tx builder, memos (ZIP-302), ZIP-321
drop-chain     lightwalletd/Zaino gRPC client: fetch, broadcast, confirmations
drop-verify    KEY-LESS verifier: parse tx, recompute public totals, compare to manifest
drop-operator  local binary, holds keys, embeds the web UI
drop-verifier  hosted read-only service for the public receipt page
web/           Vite + React 19 + Tailwind v4, features-based
```

Dependency rules (enforced in review): `drop-core` imports nothing chain-specific; `drop-verify` and
`drop-verifier` never import key material; only `drop-operator` touches spend keys; only
`web/src/lib/config.ts` reads `import.meta.env`.

## Invariants — read before changing batch, key or receipt code

1. A batch tx has transparent inputs and Ironwood **outputs only**, never Orchard (ZIP-258). No real shielded spends. This is what
   makes `t_in = t_out + net_into_pool + fee` publicly checkable (REQ-TX-001). (ADR 0006: a payout's shielded deposit address
   moves and sends back in transactions of their own, which spend that payout's inbox notes only; batches are unchanged.)
2. Outputs are sent with the campaign account's **OVK**; `None` makes outputs unrecoverable (REQ-TX-002).
3. A built tx (txid + raw bytes) is written to the ledger **before** broadcast. Resume re-broadcasts the
   stored bytes and never rebuilds (REQ-RES-001, REQ-LED-001). (ADR 0006: an inbox move is stored the same way, and is rebuilt
   only after its wallet has scanned past its expiry with its notes unspent, so the first can never be mined.)
4. Spend keys never leave the operator process; the hosted verifier never receives a viewing key
   (REQ-SEC-001, REQ-VER-002). Audit decryption runs locally. (ADR 0006: each inbox's own seed, derived from the operator's,
   goes to the pinned zcash-devtool on the same machine, on stdin, and is kept encrypted to an identity derived the same way.)
5. Manifest commitments are salted (REQ-MAN-001). Amounts are zatoshi `u64`, never floats (REQ-AMT-001).
6. The public receipt type has no recipient/amount/memo fields (REQ-PRIV-001). Logs, errors and `Debug`
   redact them (REQ-PRIV-002).
7. A batch of one, or equal amounts, makes amounts derivable from public data. The planner avoids singleton
   batches and the review step warns (REQ-PLAN-003, REQ-PRIV-003).

## Spec-driven workflow

Read order before changing behaviour: this file → `openspec list` / `openspec/changes/<change>/` →
`openspec/specs/` → `docs/ADR/` → `docs/LEARNINGS.md` → code.

- Behaviour changes (batching, keys, verifier, receipts, privacy boundary, funding) need an OpenSpec change.
  Typos, lint and narrow tests do not.
- Every requirement has an ID (`REQ-AREA-NNN`) and a `Status:` of `planned` or `implemented`.
- Every test that verifies one carries `// covers: REQ-AREA-NNN`. `scripts/spec_drift.py` fails CI when an
  `implemented` requirement has no covering test, or a marker names an unknown ID.
- Privacy requirements need a **negative** test (what must *not* appear).
- Change IDs are descriptive (`public-verifier`). **No milestone labels** (V1, V2, phase-3) in code, files or PR titles.

## Where things go

| Content | Location |
|---|---|
| Durable rules | this file |
| Behaviour requirements | `openspec/` |
| Long-lived technical decisions | `docs/ADR/NNNN-title.md` |
| Pitfalls and measured facts | `docs/LEARNINGS.md` (symptom → cause → fix → prevention) |
| What leaks and what doesn't | `docs/PRIVACY_BOUNDARY.md` (written before any UI copy) |
| Threats and mitigations | `docs/SECURITY.md` |
| Operations | `docs/runbooks/` |
| Disposable notes | `.private/` (gitignored). Never `docs/` |

No WORKLOG. Status lives in `git log` and each OpenSpec change's `tasks.md`.

## Safety

- **Testnet by default.** Mainnet needs an explicit flag and a confirmation.
- Never commit seeds, mnemonics, viewing keys, JWTs or `.env`. Test keys are labelled `TEST ONLY`.
- Never log or print recipient addresses, amounts or memos.
- Unverified facts are marked as such in docs; do not state them as facts.
