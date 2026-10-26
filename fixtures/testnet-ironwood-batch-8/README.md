# Live testnet Ironwood batch, 8 recipients (public chain data only)

`6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/` is the batch of operator campaign
`c-d8d4d52029a4`: the full product path (operator → build → broadcast) paying the 8 demo recipients of
`examples/demo-recipients.testnet.csv`. Mined on public testnet at height 4,478,289 (NU7, branch
`77190ad9`), V6, 28,284 bytes.

Shape: 1 P2PKH input (12,410,000 zat, the sweep output `9070aee0…f272:0` at the campaign funding address
`tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD`) → 8 Ironwood outputs (net 500,000 zat into Ironwood) + P2PKH
change of 11,865,000 zat, fee 45,000 zat (9 logical actions at 5,000).

| File | Content |
|---|---|
| `tx.hex` | the transaction exactly as fetched back from the chain with `GetTransaction` |
| `prevouts.json` | the spent output (txid, index, value, script), resolved from the chain |
| `funding-tx.hex` | the transaction the batch spends: the sweep `9070aee0…f272` (mined at 4,478,106, see `../testnet-ironwood-batch/README.md`). It spends one transparent coin (the first batch's change), so the receipt says `funding_source: transparent` |
| `expected.json` | the public facts recomputed from those bytes: `t_in = t_out + net_into_ironwood + fee` |
| `receipt.json` | the public receipt a freshly started `drop-verifier` (endpoint `testnet.zec.rocks:443`) returned with `declared_total=500000` and commitment `698ec02d…76f8` |
| `payslips/payslip-1.json` to `payslip-8.json` | one payslip per demo recipient, numbered like the rows of `examples/demo-recipients.testnet.csv`, issued with the demo campaign's throwaway testnet key (`cargo run -p drop-zcash --example issue_demo_payslips`). Each opens exactly one output of `tx.hex` with no key (`crates/drop-verify/tests/real_batch_payslips.rs`). Public demo data: a payslip also opens its output's memo, and these memos are in the CSV |

`receipt.json` was first captured on 2026-10-08 at 11:57 UTC (tip 4,478,307), and captured again on 2026-10-23 at
18:49 UTC (tip 4,533,356) from a freshly started `drop-verifier` that also reports where the deposit came from
(`funding_source`, REQ-VER-007). **Its `confirmations` (55,068) is the depth at that moment**, not a fixed fact: a fresh
request returns a larger number. Every other field is fixed by the chain and the request.

No keys, seeds or viewing keys; memos are encrypted in `tx.hex`. Scanned before committing: no seed (hex
or bytes), no key-encoding prefixes, and none of the CSV's recipient addresses or memo texts appear in
any file. The recipients are the throwaway demo accounts 9000..9007 of the dev wallet, so their amounts
and memos are not secret; `crates/drop-zcash/tests/demo_batch_recovery.rs` decrypts them, but only with
the dev seed (ignored by default).

Captured with the spike's key-less
`live-batch fixture <txid> fixtures/testnet-ironwood-batch-8` (`spikes/single-tx-builder/port-0.31`),
which writes nothing unless the balance holds and the proof and signatures verify. `receipt.json` comes
from a running verifier:
`GET /v1/receipt?network=testnet&tx=<txid>&declared_total=500000&commitment=<commitment>`.
