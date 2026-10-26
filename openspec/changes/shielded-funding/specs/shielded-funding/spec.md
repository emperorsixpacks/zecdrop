# shielded-funding

### REQ-VER-007 — A receipt says where the deposit came from
Status: implemented
For every batch, the verifier SHALL take as the batch's deposits the transactions that created its funding inputs (each input's
previous output), fetched by id and used only if their bytes hash to that id, and SHALL classify each as `shielded` when it has no
transparent input and as `transparent` when it has at least one (a coinbase input counts as one). The receipt SHALL carry
`funding_source`: `transparent` when any deposit is known to be transparent, `shielded` when every batch's deposits are known and
all are shielded, and `null` otherwise. It SHALL NOT be a finding and SHALL NOT change the phase, a receipt without the key SHALL
still read as one whose source is not established, and reading it SHALL make no chain request beyond those that resolve the
inputs' values. A negative test SHALL show that the receipt carries no address, amount or count of a deposit's inputs.

### REQ-FUND-004 — The funding screen asks for a shielded deposit and says what arrived
Status: implemented
Where the operator shows a campaign's funding address on a real chain, the page SHALL ask the payer to pay from a shielded balance,
and say why, before any deposit is seen. Once a deposit is seen at the funding address, at any depth, the operator SHALL classify
the transaction that created it by the rule of REQ-VER-007, from its bytes, used only if they hash to its id, and SHALL report the
result as the campaign's `funding_source` (`null` until it is known, including after a restart until it has been read again; on
the mock chain, only what `fund-observed` declares). The page SHALL say that a shielded deposit names no address of the payer's,
and SHALL state a transparent one plainly as public and tied to the payout. The source SHALL never refuse, delay or gate funding
or starting a payout, and no copy SHALL say or imply that a shielded deposit hides who paid: the amount and the time stay public.
A negative test SHALL show that no address or amount of a deposit's inputs appears in the operator's answers or logs, and the
page's copy is checked against phrases that would overclaim.
