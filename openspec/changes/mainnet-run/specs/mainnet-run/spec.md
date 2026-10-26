# mainnet-run

### REQ-OPS-003 — A mainnet campaign has a funding cap
Status: planned
On mainnet the operator SHALL refuse to create a campaign whose required funding (the declared total plus the fee)
exceeds `--mainnet-max-funding-zat` (default 10,000,000 zat, 0.1 ZEC), with HTTP 422 and code `mainnet_cap_exceeded`,
before anything is stored. The cap SHALL NOT apply on testnet. The message SHALL name the cap and the flag, and a negative
test SHALL show it repeats no payout row (address, amount or memo).

### REQ-OPS-004 — One network per store, and a node this build can use
Status: planned
The operator SHALL refuse to start when its store holds a campaign of a different network than the one it was started
for, with a fixed-text message that names only the two networks. On a real chain it SHALL also check, before it prints its
link, that the node serves the configured network, reports the consensus branch id this build derives for the next block,
and serves a non-empty Ironwood tree state at its tip; any failure SHALL end start-up with a fixed-text error.

### REQ-TX-004 — A built batch is checked before it is stored or sent
Status: implemented
Before the distributor returns a built batch it SHALL verify every proof and signature the way consensus does, and SHALL
check that the branch id equals the one this build derives for the target height, that the public totals balance, that no
value enters Orchard or Sapling, and that the public Ironwood amount equals the sum of the payouts. It SHALL refuse to
build when the node reports a different branch id than the derived one. A failed check SHALL be a permanent build error
with nothing stored or sent, and its message SHALL name no recipient, address, memo or per-recipient amount (negative
test). An empty Ironwood tree state SHALL count as the empty tree only at or below the Ironwood activation height.

### REQ-VER-005 — The verifier serves each network it is configured for
Status: planned
A verifier configured with both endpoints SHALL answer each request from the source of the network the request names. A
request for a network that is not configured SHALL get HTTP 400 `network_not_configured` before any chain call, and the
answer SHALL NOT repeat the request's parameters (negative test).
