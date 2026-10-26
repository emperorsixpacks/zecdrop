# Runbook — a small real mainnet run

**Status: written, not run yet (2026-10-18).** This is **real money**. The code is not audited, so the operator caps a mainnet
campaign at 0.1 ZEC of funding by default (`--mainnet-max-funding-zat`). The decision behind it and the checks that guard
it are in the OpenSpec change `mainnet-run` and in `docs/LEARNINGS.md`.

## Before you start

- **A wallet that can receive.** Zodl 3.8.0 or newer on a phone (iOS or Android). Write its recovery phrase on paper. That
  wallet is yours; ZecDrop never sees it.
- **A few dollars of ZEC in Zodl.** Three small payouts need about 0.003 ZEC plus a fee of about 0.0002 ZEC; Zodl charges its
  own network fee on top when it sends the deposit.
- **3 to 5 different receiving addresses** (`u1…`): yours, your teammate's, friends'. They are public receiving addresses,
  not secrets. The same address twice is not allowed. Whether Zodl gives you more than one address is unverified; a second
  person's Zodl is the safe way to get a second address.
- **In Zodl's Send screen, paste a `t1…` address and check that Zodl accepts it** as a recipient. Stop before confirming. The
  deposit goes to a transparent address.
- **The binaries:** `cargo build --release -p drop-operator` and, for the local screens,
  `cd web && VITE_ZEC_NETWORK=mainnet npm run build`.
- **The network news:** mainnet's next upgrade (NU7) has a decision due 2026-10-20 and a target of 2026-11-05. After it activates
  this build must not run on mainnet; the operator checks the node's branch id at start-up and refuses (below).

## 1. A separate store and state directory

Never reuse a testnet store: the operator refuses a store that holds another network's campaigns.

```bash
export ZECDROP_PASSPHRASE='a passphrase of 12 or more characters'   # keep it in a password manager
export ZECDROP_CONFIRM_MAINNET=I-UNDERSTAND
M="$HOME/.zecdrop-mainnet"; mkdir -p "$M" && chmod 700 "$M"
OP="target/release/drop-operator --network mainnet --allow-mainnet --lightwalletd-url https://zec.rocks:443 \
  --db $M/store.sqlite --state-dir $M"
$OP init-wallet
```

`init-wallet` creates the wallet seed inside the encrypted store. It is 32 random bytes, not a recovery phrase, and nothing
can export it. **The store file plus its passphrase are the only copy of the keys.**

## 2. Back it up, and prove the backup before any deposit

Right after `init-wallet`, before any campaign exists:

```bash
cp "$M/store.sqlite" "$HOME/zecdrop-mainnet-store.backup"     # and a second copy on another disk
```

Then run step 3 and note the campaign's funding address, F. To prove the backup, open it with a fresh state directory on
another port and create a campaign from the same payouts; the funding address must be F (both are the seed's account 0):

```bash
T=$(mktemp -d); mkdir -p "$T/state"; cp "$HOME/zecdrop-mainnet-store.backup" "$T/store.sqlite"
target/release/drop-operator --network mainnet --allow-mainnet --lightwalletd-url https://zec.rocks:443 \
  --db "$T/store.sqlite" --state-dir "$T/state" --bind 127.0.0.1:8788 --web-dir web/dist
# create the campaign in the browser, compare the funding address with F, stop it with Ctrl-C, then: rm -r "$T"
```

**Do not fund anything until the two addresses match.** Never copy an old backup over the live store: an older copy is not
detected as old, and a rolled-back store could build a batch again.

## 3. Start the operator and create the campaign

```bash
$OP --web-dir web/dist --poll-interval-ms 5000
```

It must print `connected to the mainnet chain (tip …, branch 37a5165b)` and then the `open:` link. If it refuses to start,
**stop and do not fund**. The refusals that matter: the node is on an upgrade this build does not know (the branch id differs),
the node serves no Ironwood tree state, or the store holds testnet campaigns.

Open the link on this machine. The header must say **Zcash mainnet**. "New payout": paste the payouts (amounts in ZEC with up to
8 decimals; make them differ; a memo is optional). The review step shows the total, the fee and "funding required", which is the
total plus the fee. `mainnet_cap_exceeded` means the campaign needs more than 0.1 ZEC: lower the amounts.

## 4. Fund exactly

Send **exactly** "funding required" to the campaign's `t1…` address from Zodl (Zodl pays its own fee on top).

- More than required leaves change at an address this operator cannot spend on mainnet.
- Less never funds the campaign.

Wait for 3 confirmations (about 4 minutes at 75 seconds a block). The page changes to "Funded, ready to send".

## 5. Send and watch

Press **Send N payouts**. A sheet asks once; on mainnet its button stays disabled until you tick "This sends real ZEC and
cannot be undone", then press the same button. Proving takes 10 to 20 seconds; then the batch is built, checked, broadcast and
confirmed; it settles at depth 3. Do not close the operator between sending and "broadcast". A transaction that was built but not sent expires
after about 50 minutes, and a stopped campaign does not rebuild it (a restart re-sends the stored bytes).

## 6. Check it three ways

1. **The receiving wallets.** Each recipient's Zodl shows the payout and its memo. Screen-record the phone.
2. **The public receipt** (needs the hosted verifier to serve mainnet, see `deploy/vps/README.md`):
   `https://zecdrop-site.vercel.app/r/mainnet-run?network=mainnet&tx=<txid>&commitment=<commitment>&declared_total=<zat>`.
   Expect "Settled" and the `t1…` funding address.
3. **The local audit:**
   ```bash
   $OP export-ufvk --campaign <id> --i-understand-this-is-irreversible \
     | $OP audit --campaign <id> --ufvk-stdin --receipt-commitment <commitment>
   ```
   Expect every output recovered, the total equal to the public figure, and `RESULT: reconciled`.

## 7. Issue the payslips (optional; good for the video)

Once the campaign is settled, the operator can give each recipient a **payslip**: a small file that proves one payout to them,
checkable by anyone without a key. Each file names its recipient's receiver and amount, and also opens that output's memo, so it
goes only to its recipient.

```bash
$OP payslips --campaign <id> --out-dir "$HOME/zecdrop-payslips-mainnet"       # one owner-only file per payout
target/release/drop-operator verify-payslip --payslip "$HOME/zecdrop-payslips-mainnet/payslip-001.json" \
  --lightwalletd-url https://zec.rocks:443                                    # a recipient or a third party checks one
```

Expect `OK` with the confirmations. The public site's "Check a payslip" page checks the same file through the hosted verifier,
which then sees the receiver, the amount and the memo's key for the length of the request (`docs/PRIVACY_BOUNDARY.md`,
"Payslips").

## If something goes wrong

- **A refusal at start-up:** read the message, do not fund, and tell whoever is helping.
- **The batch fails or the node rejects it:** the deposit is still unspent at the funding address (a rejected transaction moves
  nothing). Copy the exact failure text from the campaign page and the log. Do not create another campaign from the same
  deposit. Your loss is at most what you funded, which the cap bounds. No mainnet recovery tool exists yet.
- **A lost passphrase or store file:** the funds at that address cannot be recovered.

## What the public sees afterwards (by design)

The funding address and the amount funded, the total entering the shielded pool, the fee, the number of outputs, the transaction
ids and their timing, and the deposit transaction that funded the address (your wallet's withdrawal). Recipient addresses, per-
recipient amounts and memos stay hidden.

## After the run

Update in the same commit as the real receipt: `README.md` (status and limits), `docs/JUDGES.md`, `docs/submission/*`,
`docs/PRIVACY_BOUNDARY.md` (status line, which `web/src/features/privacy/PrivacyPage.tsx` mirrors), `docs/HACKATHON.md`,
`docs/LEARNINGS.md`, and the pinned sentences in `ProvesAndNot.tsx`, `HomePage.tsx` and `e2e/sample.spec.ts`. Capture the real
mainnet batch as a fixture the way `fixtures/testnet-ironwood-batch-8/` was.
