# Live testnet Ironwood batch (public chain data only)

`50fb88e02e7f4b0f3b3b658f50b09b12ea973d8c3697f8bad4c59e41075ea3e3/` is the first ZecDrop batch
mined on public testnet. It was broadcast through `testnet.zec.rocks:443` on 2026-10-08 and mined
at height 4,478,065 (NU7, branch `77190ad9`).

Shape: 1 P2PKH input (12,500,000 zat) → 3 Ironwood outputs (net 60,000 zat into Ironwood) +
P2PKH change of 12,420,000 zat, fee 20,000 zat. V6 transaction.

| File | Content |
|---|---|
| `tx.hex` | the transaction exactly as fetched back from the chain with `GetTransaction` |
| `prevouts.json` | each spent output (txid, index, value, script), resolved from the chain |
| `expected.json` | the public facts recomputed from those bytes: `t_in = t_out + net_into_ironwood + fee` |
| `funding-tx.hex` | the transaction the batch spends (`daa6b06c…8e2e`, mined at 4,478,055), as fetched with `GetTransaction`; its output 0 pays the campaign funding address `tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD` |
| `receipt.json` | the public receipt a running `drop-verifier` (endpoint `testnet.zec.rocks:443`) returned for this batch with `declared_total=60000` and commitment `aade9fd1…1491` |

`receipt.json` was captured on 2026-10-08 at 11:27 UTC. **Its `confirmations` (137) is the depth at
that moment**, not a fixed fact: a fresh request returns a larger number. Every other field is fixed
by the chain and the request.

No keys, seeds or viewing keys. The recipients are throwaway dev-wallet accounts (the demo
range), so their amounts and memos are not secret.

## Sweep (not a batch; recorded for the chain of funds)

| | |
|---|---|
| txid | `9070aee087878ded13f46e8817574753e6cc6575678a5d233739a479a858f272` |
| mined | testnet height 4,478,106 (NU7), V6, 207 bytes, transparent only |
| input | the batch's change `50fb88e0…a3e3:0`, 12,420,000 zat at the campaign change address `tmPvSFX6uKbWX6UebNnuiaKmbdtcby9A3kr` |
| output | 12,410,000 zat to the campaign funding address `tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD` (its only UTXO afterwards) |
| fee | 10,000 zat (1 input + 1 output = the 2-action ZIP-317 minimum at 5,000 per action) |

It moves the batch change back to the funding address, which is the only address the operator
watches for deposits. Built with `drop_zcash::build_sweep` via `live-batch sweep --send`.

Written by the spike's `live-batch` (`spikes/single-tx-builder/port-0.31`). Regenerate it with
`live-batch verify <txid>`; `funding-tx.hex` with `live-batch raw <txid> > funding-tx.hex` (key-less).
`receipt.json` comes from a running verifier:
`GET /v1/receipt?network=testnet&tx=<txid>&declared_total=60000&commitment=<commitment>`.
