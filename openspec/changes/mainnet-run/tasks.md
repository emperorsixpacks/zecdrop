# Tasks — mainnet-run

Tick only after the work is verified (tests run, behaviour probed). Evidence goes after "— verified:".

## drop-zcash
- [x] Z1 `ZcashDistributor::new_for_mainnet` with `MainnetPermit`; `new` still refuses mainnet (REQ-OPS-001) — verified: unit tests, a full mainnet-branch batch through the engine
- [x] Z2 Node branch id cross-check before building (`ChainBackend::consensus_branch_id`, `BranchMismatch`) (REQ-TX-004) — verified: unit tests with a fake chain
- [x] Z3 Self-check of the built batch before it leaves the distributor (REQ-TX-004) — verified: tampered signature, wrong branch, wrong total and junk bytes are refused
- [x] Z4 Empty Ironwood tree state is the empty tree only up to activation (REQ-TX-004) — verified: unit tests; a real mainnet tree state (captured 2026-10-18) parses to a non-empty root
- [x] Z5 Mainnet offline build at the real tip: proofs and signatures verify, `t1`/`u1`/`uview1` strings, key-holder recovery (REQ-TX-001)

## drop-operator
- [x] O1 Real chain allowed on mainnet behind the existing gate; mock chain and seed file still refused (REQ-OPS-001) — verified: config tests (flag and confirmation, endpoint validated, mock and seed file refused) and a full mainnet campaign on the in-memory chain
- [x] O2 Start-up check of the node (network, branch id, Ironwood tree) before the link is printed (REQ-OPS-004) — verified: `preflight` against a fake node (match, other branch, no tree state, other network); `LightwalletdConnector::connect` calls it; the live start-up is L1
- [x] O3 One network per store (REQ-OPS-004) — verified: a testnet store opened by a mainnet operator is refused at start-up with fixed text, and the tools (`export-ufvk`, `audit`) refuse a campaign of another network than the one they were started for
- [x] O4 Funding cap for mainnet campaigns (REQ-OPS-003) — verified: above the cap 422 `mainnet_cap_exceeded` with nothing stored and no payout row in the message, exactly the cap allowed, no cap on testnet
- [x] O5 A full mainnet campaign on the in-memory chain: create, fund, start, settle, receipt verifies as `t1…` — verified: `crates/drop-operator/tests/mainnet.rs` (NU6.3 branch, proofs and signatures, viewing-key recovery, no private data in any output); a node on another upgrade halts the run with nothing sent; no permit, no run

## drop-verifier and deploy
- [x] V1 One verifier serves both networks and routes each request to its own source (REQ-VER-005) — verified: in-process test with two fake nodes; the real binary run locally against `testnet.zec.rocks` and `zec.rocks` answered the real testnet batch as settled and a real mainnet transparent-to-Ironwood transaction as parsed (`t1…` funding address, 2 Ironwood actions)
- [x] V2 `MAINNET_ENDPOINT` reaches the container command; compose and VPS README updated — verified: the command line, compose and README; the rollout on the VPS is the teammate's step (not yet done)

## web
- [ ] W1 Header names the receipt's network; mainnet Start needs an explicit tick; texts for `mainnet_cap_exceeded` and `network_not_configured`
- [ ] W2 Hosted e2e: a mainnet receipt renders ZEC and mainnet explorer links

## live
- [ ] L1 No-money preflight on mainnet (operator starts, preflight passes, campaign created from real wallet addresses)
- [ ] L2 Hosted verifier answers for `network=mainnet`
- [ ] L3 The funded run settles; hosted receipt, local audit and the receiving wallet agree
- [ ] L4 Pinned "mainnet is untested" sentences and docs updated in the same commit as the real receipt
