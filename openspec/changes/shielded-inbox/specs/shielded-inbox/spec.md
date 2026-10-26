# shielded-inbox

### REQ-FUND-005 — Each new testnet payout has a shielded deposit address of its own
Status: implemented
When the operator runs on a real testnet chain with a ZecDrop-built zcash-devtool (`--zcash-devtool`), every payout created
SHALL get a shielded deposit address (its "inbox"): a Unified Address with an Orchard receiver only, of account 0 of a wallet seed
derived from the operator's seed and the payout's own ZIP 32 account number, so the operator's seed alone recovers it and the
payout's own viewing key (the auditor's key) cannot see it. The wallet SHALL be set up from that phrase given on stdin, with its
birthday given explicitly, in a directory of its own (0700), and the operator SHALL show the address only after checking that the
wallet's one account has the Orchard incoming viewing key it derives itself; a wallet that fails the check SHALL be removed. The
operator SHALL refuse `--zcash-devtool` on mainnet, and SHALL refuse a zcash-devtool binary that lacks ZecDrop's patch. Without
`--zcash-devtool`, nothing about funding changes.

### REQ-FUND-006 — The operator moves exactly the funding from the inbox, and checks the move before sending it
Status: implemented
Once the inbox's unspent Ironwood notes that zcash-devtool can spend (10 confirmations for a note from outside) cover the
payout's funding plus the move's ZIP 317 fee, and after a random delay (bounded by a setting), the operator SHALL build one
transaction that pays exactly the payout's funding to its transparent funding address, from the inbox's Ironwood notes only, with
any change back to the inbox. Before storing or broadcasting it, the operator SHALL check its raw bytes with its own parser: V6 for
the node's branch; an expiry after the tip and at most 43 blocks past it; no transparent input; exactly one transparent output,
paying the funding address exactly the funding; no Sapling or Orchard part; an Ironwood part; a fee equal to the ZIP 317 fee for
its shape; and the inbox notes it spends (matched by nullifier) equal to the funding, the fee and the change it pays back to the
inbox. A transaction that fails any check SHALL NOT be stored or sent. The operator SHALL move only while the payout is unfunded
and nothing big enough has been seen at its funding address, read fresh just before the move; SHALL keep at most one move per
inbox, written to the store with its raw bytes before broadcast and re-sent from those bytes until it is mined; SHALL build
another only after the wallet has scanned past the first one's expiry with its notes still unspent; and SHALL never move again
after a move is mined. The move has no transparent input, so the payout's deposit reads `shielded` (REQ-VER-007) with no change
to the verifier.

### REQ-FUND-007 — What is left in the inbox can be sent back to a shielded address
Status: implemented
When no move can happen (the payout is funded, or its move is mined, or the inbox holds less than a move needs), the owner SHALL
be able to send everything spendable in the inbox, less the fee, to a shielded address with an Orchard receiver. The operator
SHALL refuse a transparent or Sapling-only address, the inbox's own address and the payout's own address, and SHALL check the
transaction before sending it as for a move: no transparent part at all, the fee ZIP 317's, and what it spends from the inbox equal
to what it pays the given address (recovered with the inbox's outgoing viewing key), the fee and any change to the inbox.

### REQ-FUND-008 — The funding screen leads with the inbox and says what it holds
Status: implemented
Where a payout has an inbox, the funding screen SHALL show it first: its address, a QR code and a wallet link for exactly the
funding plus the move's fee (amending REQ-FUND-003 for the inbox), and the ask to pay it from a shielded wallet (amending
REQ-FUND-004). It SHALL say what the inbox holds and how far it is: nothing yet; a deposit confirming (with its confirmations of
10); enough, moving at a stated time; the move confirming; or short by a stated amount. The public funding address SHALL stay
available as "Pay the public address instead" until the inbox holds a note. The answer the page polls SHALL be read from memory
only, never by running zcash-devtool, and the page SHALL keep polling while a move or a send-back is in progress. The operator
SHALL NOT fetch the payer's deposit transaction by id, so the node it watches the funding address through is never told which
payment fed which payout.

### REQ-PRIV-004 — Nothing of the inbox reaches the receipt, the auditor's key or the logs
Status: implemented
The inbox's address, its notes, their values and memos, and where a send-back goes SHALL NOT appear in the public receipt, in the
operator's logs or errors (zcash-devtool's own output is never put in either), or in what the payout's exported viewing key can
decrypt. The inbox's phrase and identity SHALL reach zcash-devtool on stdin (and the identity, for `init` alone, in a 0600 file
deleted as soon as `init` returns), never in argv, and PCZT files SHALL be deleted after use and at start-up. Negative tests SHALL
show the receipt, the logs and the payout's viewing key free of the inbox.
