# How to test ZecDrop

Three ways, from least to most effort. Everything is on **Zcash testnet**; nothing here moves real money.

## 1. Look (no install)

Open <https://zecdrop-site.vercel.app>.

- **Home** explains the idea and how a payout is run.
- **A live receipt:** [the real 8-recipient testnet payout](https://zecdrop-site.vercel.app/r/real-8?network=testnet&tx=6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955&commitment=698ec02d7e72ec60a11f5a6e176288bf4a27e86304dfe75330bfb82051b976f8&declared_total=500000)
  (txid `6e2359182d1dc772…`). The page asks the hosted verifier, which reads public Zcash testnet and recomputes the totals,
  so this is a live check, not a stored page. Expect "Settled: 8 payouts, 0.005 TAZ, fee 0.00045 TAZ". The verifier runs on a
  teammate's server; if the page says it cannot reach it, use path 2, which needs only Docker.
- **See a real receipt** opens `/r/demo?demo=real`, a saved copy of the same answer that works even when the verifier is down.
- The site cannot run a payout, because the operator holds the keys and runs on your own computer (there is no wallet to
  connect).

## 2. Check the real payout yourself (Docker, no keys, no coins)

This runs the key-less verifier on your machine. It reads public Zcash testnet and recomputes the receipt from chain data.

```bash
docker build -f deploy/verifier.Dockerfile -t zecdrop-verifier .
docker run --rm -p 8080:8080 -e PORT=8080 -e TESTNET_ENDPOINT=https://testnet.zec.rocks:443 zecdrop-verifier
```

In another terminal:

```bash
curl -s 'http://127.0.0.1:8080/v1/receipt?network=testnet&tx=6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955&declared_total=500000&commitment=698ec02d7e72ec60a11f5a6e176288bf4a27e86304dfe75330bfb82051b976f8'
```

Expect `"phase":{"phase":"settled"}`, `"shielded_actions":8`, `"net_into_pool":"500000"`, `"fee":"45000"` (zatoshi) and
`"findings":[]`. Change `declared_total` to `499999` and it answers `failed` with `declared_total_mismatch`.

What this proves: how much entered the shielded pool, in how many outputs, at what fee, from which funding address. What
it cannot prove: who received what. That needs the auditor's viewing key; the real campaign's audit is in
`docs/runbooks/testnet-demo.md`, step 7.

## 3. Run the whole flow on a fake chain (no keys, no coins)

Needs Rust 1.92, `protoc` and Node 22. The fake chain sends nothing to Zcash; it shows the product end to end, not the
privacy of a real transaction (that is path 2).

```bash
(cd web && npm ci && npm run build)
ZECDROP_PASSPHRASE='any passphrase of 12 or more characters' \
  cargo run -p drop-operator -- --mock-chain --db /tmp/zecdrop-judge.sqlite --web-dir web/dist
```

Open the `open:` link it prints (the token is in the link and changes on every start). Then: add payouts (paste
`examples/demo-recipients.testnet.csv`), check them, fund the campaign ("Practice mode: record a pretend deposit",
then "Record mock deposit"), send, and open the public receipt.

## Not available to judges

- A hosted operator or sandbox (see [ADR 0002](ADR/0002-local-operator-and-keyless-verifier.md) for why).
- A real testnet run needs a testnet seed and coins: [`runbooks/testnet-demo.md`](runbooks/testnet-demo.md).
- Mainnet: untested.
