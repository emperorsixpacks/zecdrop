# How to test ZecDrop

Five ways, from least to most effort. Everything is on **Zcash testnet**; nothing here moves real money.

## What to look for: one payout, four views

ZecDrop pays many people in one transaction and gives each party its own view of it. Where to see each one:

| View | What it sees | Where to see it |
|---|---|---|
| **Everyone** | the total, the fee, how many were paid, whether the deposit came out of the shielded pool | the live receipt link in path 1, or your own verifier in path 2 |
| **Each person paid** | their own payout, proved to anyone with a payslip | "Check a payslip" in path 1, or offline in path 4 |
| **An auditor** | the whole list of that payout, reconciled against the public total | the home page's sheet, *Auditor* (the public demo list); the real audit of the 8-recipient run reconciled 8 of 8 outputs (`docs/LEARNINGS.md`, 2026-10-08; how to run it: `docs/runbooks/testnet-demo.md`, step 7) |
| **You, the payer** | every address, amount and note, on your own computer | the operator itself, on your computer: a real payout in path 3, or every screen on a fake chain in path 5 |

## 1. Look (no install)

Open <https://zecdrop-site.vercel.app>.

- **Home** says what ZecDrop does in a few lines; **Make a payout** gives the one command that runs it on your own computer
  (path 3).
- **A live receipt:** [the real 8-recipient testnet payout](https://zecdrop-site.vercel.app/r/real-8?network=testnet&tx=6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955&commitment=698ec02d7e72ec60a11f5a6e176288bf4a27e86304dfe75330bfb82051b976f8&declared_total=500000)
  (txid `6e2359182d1dc772…`). The page asks the hosted verifier, which reads public Zcash testnet and recomputes the totals,
  so this is a live check, not a stored page. Expect "Settled: 8 payouts, 0.005 TAZ, fee 0.00045 TAZ". The verifier runs on a
  teammate's server; if the page says it cannot reach it, use path 2, which needs only Docker.
- **See a real receipt** opens `/r/demo?demo=real`, a saved copy of the same answer that works even when the verifier is down.
- **What the deposit spent:** every receipt says whether its deposit came out of the shielded pool (it then names no payer
  address) or from transparent funds, whose address is public; never the address itself, and the amount and time are public
  either way. The 8-recipient batch says *transparent*: its deposit was a sweep of the first batch's change. [The first real
  batch, 3 recipients](https://zecdrop-site.vercel.app/r/first-batch?network=testnet&tx=50fb88e02e7f4b0f3b3b658f50b09b12ea973d8c3697f8bad4c59e41075ea3e3&commitment=aade9fd18f7c48dc3b04ead6a7ee2211640d0fa5948dfd14b5a356463c841491&declared_total=60000)
  says *shielded*: it was funded straight from the testnet faucet's shielded wallet. The operator's funding screen asks the
  payer to pay from a shielded balance and says which kind arrived.
- **A payout funded through its own shielded address:** [the same 8 recipients, paid on 2026-10-24](https://zecdrop-site.vercel.app/r/c-6207fac6674f?network=testnet&tx=af8adf80e3a58378d4ed4852cfbbb035be5dbd4bde65dab732fa3bf95cd64a12&commitment=ca5ccacaaa467610fb8c0e1a36c364429c9ff91f17403a34ea679292fd73803f&declared_total=500000)
  (txid `af8adf80e3a58378…`). The payer paid the payout's own shielded address from a shielded wallet; the operator moved
  exactly the funding to the public address and checked that move before sending it. Its deposit is that move, which spends
  only shielded notes, so the receipt says *shielded* (the hosted verifier says so, checked 2026-10-25; path 2 shows it too).
- **Check a payslip:** [the Check a payslip page](https://zecdrop-site.vercel.app/payslip) loads a real payslip of that batch (one
  recipient's proof of one payout) and checks it through the hosted verifier; a second button loads a copy with the amount changed
  so you can watch it fail. Checking here shows the verifier the payslip's receiver, amount and the key to its memo; path 4
  checks one offline.
- **Being paid?** [The Get paid page](https://zecdrop-site.vercel.app/get-paid) is for a recipient: it checks the shape of a
  receiving address and offers to share it, entirely in the browser (no request, nothing stored).
- **Send a payslip:** on the payslip page, once the page can read the payslip in the box, it can be made into a link or a QR code. The payslip sits after the
  `#`, which a browser never sends to a server; opening such a link loads it into the box and checks nothing until you ask.
- **Payslips from the payer's screen:** on a settled campaign the operator's page has *Send payslips*: every person, and a link or
  a QR code of their own payslip. It needs a real chain (the mock chain has no real transaction to prove),
  so on the fake chain the section says so; the payslip page above checks one of the real batch's.
- The site cannot make a payout, because the operator holds the keys and runs on your own computer (there is no wallet to
  connect): path 3 runs it there.

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

The payout funded through its own shielded address (2026-10-24) answers the same, with its own funding address and
`"funding_source":"shielded"`:

```bash
curl -s 'http://127.0.0.1:8080/v1/receipt?network=testnet&tx=af8adf80e3a58378d4ed4852cfbbb035be5dbd4bde65dab732fa3bf95cd64a12&declared_total=500000&commitment=ca5ccacaaa467610fb8c0e1a36c364429c9ff91f17403a34ea679292fd73803f'
```

What this proves: how much entered the shielded pool, in how many outputs, at what fee, from which funding address. What
it cannot prove: who received what. That needs the auditor's viewing key; the real campaign's audit is in
`docs/runbooks/testnet-demo.md`, step 7.

## 3. Make a payout of your own (Docker, one command, free test coins)

ZecDrop runs on your own computer, which holds the keys and the payout list. You need git and Docker (Docker Desktop on a Mac
or on Windows, where it runs inside WSL).

```bash
git clone https://github.com/JemIIahh/zecdrop.git
cd zecdrop
./zecdrop up
```

The first start builds ZecDrop, which takes a few minutes to half an hour; then the operator opens in your browser, on Zcash
testnet. Then:

1. **Add the people.** *Use the example list* loads eight testnet addresses of the project's own test wallet, with their
   amounts and notes (`examples/demo-recipients.testnet.csv`). Or type people in, or import a list of your own.
2. **Check, then fund.** The funding screen gives the payout's address and the amount to send. The free
   [testnet faucet](https://faucet.testnet.valargroup.dev) pays that address directly: 0.125 TAZ, once a day, where the
   example list needs 0.00545. The faucet pays from a shielded wallet, so the receipt will say the deposit came out of the
   shielded pool. **It has paid no one since 2026-10-23 16:09 UTC** (checked 2026-10-25; reported to its maintainers as
   [valargroup/valar-testnet-faucet#5](https://github.com/valargroup/valar-testnet-faucet/issues/5)). If it says "the wallet
   cannot pay this address", press *ask us on GitHub* under it: that opens an issue on this repository that already holds your
   payout's funding address and amount, and we pay it from ZecDrop's own test wallet. The issue is public and puts your GitHub
   name beside that address. The screen says *Funded* once the payment has confirmed, a few minutes later.
3. **Send.** One transaction pays all eight; the page follows it until it is confirmed, a few minutes later.
4. **Share.** *Open public receipt* opens the payout's receipt on the public site, checked by its key-less verifier (or by
   your own, path 2). *Send payslips* gives each person a link to their own payslip (path 4 checks one).

`./zecdrop down` stops it and keeps your payouts, and `./zecdrop up` starts it again with a new link; `./zecdrop help` lists
the rest. Your wallet and payouts are kept in `~/.zecdrop-app`, which only you can read. The page is published on your
computer's loopback address only, behind a token that changes on every start, and the launcher never runs on mainnet. The steps of the first run through it, on 2026-10-25, are in
[`runbooks/testnet-demo.md`](runbooks/testnet-demo.md).

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

## 5. Every screen on a fake chain (from source, no keys, no coins)

Needs Rust 1.92, `protoc` and Node 22. The fake chain sends nothing to Zcash; it shows the product end to end, not the
privacy of a real transaction (that is path 2).

```bash
(cd web && npm ci && npm run build)
ZECDROP_PASSPHRASE='any passphrase of 12 or more characters' \
  cargo run -p drop-operator -- --mock-chain --db /tmp/zecdrop-judge.sqlite --web-dir web/dist
```

Open the `open:` link it prints (the token is in the link and changes on every start). Then: add payouts (paste
`examples/demo-recipients.testnet.csv`), check them, fund the campaign ("Fake chain: record a pretend deposit",
then "Record mock deposit"), send, and open the public receipt.

## Not available to judges

- A hosted operator or sandbox (see [ADR 0002](ADR/0002-local-operator-and-keyless-verifier.md) for why): path 3 runs the
  operator on your own computer instead.
- A real testnet run from source, with a seed of your own: [`runbooks/testnet-demo.md`](runbooks/testnet-demo.md). Funding through a
  payout's shielded address also needs zcash-devtool (built by `scripts/zcash-devtool/build.sh`) and a shielded wallet that
  can send on current testnet; the same runbook, "Funding through the shielded deposit address", has both real runs.
- Mainnet: the code is ready and tested offline, but no real mainnet payout has been run yet ([`runbooks/mainnet-run.md`](runbooks/mainnet-run.md)).
