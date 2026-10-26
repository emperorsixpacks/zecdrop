# public-verifier

## Why
"Public accountability" must be something a judge can check without trusting us. The verifier recomputes a
campaign's public totals from chain data and holds no keys.

## What
`drop-verify` (parse + recompute) and `drop-verifier` (hosted read-only HTTP service) plus the public receipt page
(`/r/:id`). Input: a campaign's txids. Output: the strict `PublicReceipt`.

## Approach
Resolve each batch's previous outputs to get input values (a transaction does not carry them), then check
`t_in = t_out + net_into_pool + fee`. Report batches below the confirmation depth as pending. Link txids to
independent explorers.

## Risks
Needs a node/indexer endpoint (self-hosted Zebra + Zaino, or a public lightwalletd). Unconfirmed that a suitable
public endpoint exists.
