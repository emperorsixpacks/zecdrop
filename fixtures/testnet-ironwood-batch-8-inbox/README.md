# Live testnet Ironwood batch, 8 recipients, funded through a shielded deposit address (public chain data only)

`af8adf80e3a58378d4ed4852cfbbb035be5dbd4bde65dab732fa3bf95cd64a12/` is the batch of operator campaign `c-6207fac6674f`,
paying the 8 demo recipients of `examples/demo-recipients.testnet.csv`. It was funded the new way
(docs/ADR/0006-shielded-inbox.md), with nothing done by hand:

1. The operator gave the payout a shielded deposit address of its own (its "inbox") and asked for the funding plus the move's
   fee: 560,000 zatoshi.
2. The payer paid that from a shielded wallet, shielded to shielded.
3. At 10 confirmations, after a random wait, the operator's inbox engine moved exactly the funding (545,000) to the payout's
   funding address `tmM4VS6wn8oNwTgRFEPTiicWqbBzUG1Q3bY`, in a transaction it checked from its raw bytes before storing and
   sending it: `6e677bc50c0e17396340d40bbf5464d749c7192c6d19f914a7db5772ad5870f3`, mined at 4,537,111.
4. The funding poller funded the payout from that move, and the payout was sent: this transaction, mined on public testnet at
   height 4,537,130 (NU7, branch `77190ad9`), V6, 28,250 bytes. Run on 2026-10-24.

Shape: 1 P2PKH input (545,000 zat, the move's output `6e677bc5…70f3:0`) → 8 Ironwood outputs (net 500,000 zat into Ironwood),
no change (the deposit was exactly the funding), fee 45,000 zat (9 logical actions at 5,000).

| File | Content |
|---|---|
| `tx.hex` | the transaction exactly as fetched back from the chain with `GetTransaction` |
| `prevouts.json` | the spent output (txid, index, value, script), resolved from the chain |
| `funding-tx.hex` | the transaction the batch spends: the inbox's move. It has no transparent input (2 Ironwood actions, 560,000 leaving the pool; one P2PKH output of exactly 545,000; fee 15,000), so the receipt says `funding_source: shielded` |
| `expected.json` | the public facts recomputed from those bytes: `t_in = t_out + net_into_ironwood + fee` |
| `receipt.json` | the public receipt a freshly started `drop-verifier` (endpoint `testnet.zec.rocks:443`) returned with `declared_total=500000` and commitment `ca5ccaca…803f`, captured on 2026-10-24 at 21:24 UTC. **Its `confirmations` (32) is the depth at that moment**, not a fixed fact; every other field is fixed by the chain and the request |
| `payslips/payslip-001.json` to `payslip-008.json` | one payslip per demo recipient, numbered like the rows of the CSV, written by the operator's own `payslips` command from the payout's key. Each opens exactly one output of `tx.hex` with no key (`crates/drop-verify/tests/real_batch_payslips.rs`). Public demo data: a payslip also opens its output's memo, and these memos are in the CSV |

Also checked on the run (Checkpoint B):
- The audit (`export-ufvk … | audit --ufvk-stdin --receipt-commitment …`, key never printed) reconciled: 8 of 8 public actions,
  8 of 8 rows, the recomputed commitment equal to the receipt's.
- The payout's own viewing key, the one an auditor gets, opens none of the actions of the payer's deposit into the inbox and none
  of the move's (`audit-tx`): an auditor sees the payout, not how it was funded.
- The operator's log names the move's txid (public: it is the payout's deposit) and nothing else of the inbox: no address, no
  amount, no payer transaction.

Not here: the payer's deposit into the inbox. It is on the chain like any shielded transaction, but naming it here would
publish what the inbox keeps off the record: which payment fed which payout.

No keys, seeds or viewing keys. Scanned before committing: no seed (as stored, hex or bytes), no key-encoding prefixes, none of
the CSV's recipient addresses or memo texts, no inbox address and nothing of the payer's in any file. The recipients are the
throwaway demo accounts of the dev wallet, so their amounts and memos are not secret.

Captured with no key: `tx.hex` and `funding-tx.hex` are the bytes `GetTransaction` returns
(`cargo run -p drop-zcash --example fetch_tx -- <txid>`), and `prevouts.json` and `expected.json` are recomputed from them.
`receipt.json` comes from a running verifier:
`GET /v1/receipt?network=testnet&tx=<txid>&declared_total=500000&commitment=<commitment>`.
