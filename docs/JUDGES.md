# How to test ZecDrop

Four ways, from least to most effort. Everything is on **Zcash testnet**; nothing here moves real money.

## 1. Look (no install)

Open <https://zecdrop-site.vercel.app>.

- **Home** explains the idea and how a payout is run.
- **A live receipt:** [the real 8-recipient testnet payout](https://zecdrop-site.vercel.app/r/real-8?network=testnet&tx=6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955&commitment=698ec02d7e72ec60a11f5a6e176288bf4a27e86304dfe75330bfb82051b976f8&declared_total=500000)
  (txid `6e2359182d1dc772…`). The page asks the hosted verifier, which reads public Zcash testnet and recomputes the totals,
  so this is a live check, not a stored page. Expect "Settled: 8 payouts, 0.005 TAZ, fee 0.00045 TAZ". The verifier runs on a
  teammate's server; if the page says it cannot reach it, use path 2, which needs only Docker.
- **See a real receipt** opens `/r/demo?demo=real`, a saved copy of the same answer that works even when the verifier is down.
- **Check a payslip:** [the Check a payslip page](https://zecdrop-site.vercel.app/payslip) loads a real payslip of that batch (one
  recipient's proof of one payout) and checks it through the hosted verifier; a second button loads a copy with the amount changed
  so you can watch it fail. Checking here shows the verifier the payslip's receiver, amount and the key to its memo; path 4
  checks one offline.
- **Try a practice payout:** press "Try a personal payout" or "Try an organisation payout" on the home page (it works on a phone).
  The operator's own screens run against a simulation inside the page: add the example list (in the personal view, try *Even* or
  *Lucky* to split a total), check the payouts, record a pretend deposit, send, and open a simulated public receipt. Nothing is sent anywhere, a banner on every screen says it is a simulation, and its ids begin with
  the bytes of "practice". It is not evidence about any chain; paths 2 and 4 are.
- **Being paid?** [The Get paid page](https://zecdrop-site.vercel.app/get-paid) is for a recipient: it checks the shape of a
  receiving address and offers to share it, entirely in the browser (no request, nothing stored).
- **Send a payslip:** on the payslip page, once the page can read the payslip in the box, it can be made into a link or a QR code. The payslip sits after the
  `#`, which a browser never sends to a server; opening such a link loads it into the box and checks nothing until you ask.
- **Payslips from the payer's screen:** on a settled campaign the operator's page has *Send payslips*: every person, and a link or
  a QR code of their own payslip. It needs a real chain (the mock chain and practice mode have no real transaction to prove),
  so on the fake chain the section says so; the payslip page above checks one of the real batch's.
- **A tour** of the operator's screens, with what the public sees and what stays hidden at each step, is on the home page.
- The site cannot run a real payout, because the operator holds the keys and runs on your own computer (there is no wallet to
  connect); the practice mode above simulates one.

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

## 4. Check one recipient's payslip (no key, no coins)

A **payslip** is a small file one recipient can show a third party: it proves that one output of a public transaction paid them
an amount, without revealing any other recipient and without a viewing key. This repository holds the payslips of the real
8-recipient testnet batch, issued with the demo campaign's throwaway key. With the operator built (`cargo build -p drop-operator`):

```bash
F=fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955
target/debug/drop-operator verify-payslip --payslip $F/payslips/payslip-3.json --tx $F/tx.hex
```

Expect `OK: action 5 of transaction 6e2359182d1d… creates a note with the payslip's receiver and amount`, followed by what that
does not prove. Change one digit of `value` in the file and it fails (`the payslip does not match the transaction's output`).
Against a verifier that reads the chain (path 2's container), a payslip travels in a POST body:

```bash
curl -s -X POST -H 'content-type: application/json' --data-binary @$F/payslips/payslip-3.json http://127.0.0.1:8080/v1/payslip
```

Expect `"verdict":"verified"` with the confirmations. A payslip is a bearer document and its `rseed` also opens that output's
memo, so a hosted check shows the verifier the receiver, the amount and the memo's key for the length of the request;
the offline command does not. What a payslip proves and does not prove: [`PRIVACY_BOUNDARY.md`](PRIVACY_BOUNDARY.md), "Payslips".

## Not available to judges

- A hosted operator or sandbox (see [ADR 0002](ADR/0002-local-operator-and-keyless-verifier.md) for why).
- A real testnet run needs a testnet seed and coins: [`runbooks/testnet-demo.md`](runbooks/testnet-demo.md).
- Mainnet: the code is ready and tested offline, but no real mainnet payout has been run yet ([`runbooks/mainnet-run.md`](runbooks/mainnet-run.md)).
