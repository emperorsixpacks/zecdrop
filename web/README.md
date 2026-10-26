# ZecDrop web

The UI for ZecDrop, confidential batch payouts on Zcash ("private amounts,
public accountability"). The same bundle serves two roles:

- **Operator** routes (`/campaigns`, `/new/*`, `/campaign/:id`, `/audit`),
  served by the local operator binary that holds the spend keys. They need the
  operator's bearer token (below).
- **Public** routes (`/`, `/r/:id`, `/get-paid`, `/payslip`, `/privacy`), safe to serve from the separate,
  key-less hosted verifier.

**Practice mode** ("Try a practice payout" on the home page) draws the operator routes on any copy, hosted ones too, against a
simulation inside the page (below).

There is no wallet-connect and no EVM code in this app.

What is real: the public pages, the operator pages (payout list, the three
stages Payouts, Check and Send, campaign view with live progress, receipt link, audit explainer), the
design system and the libraries under `src/lib` and `src/api`. The operator
pages are tested against responses captured from the real operator binary.

What is not finished (and the UI says so where it matters):

- **Real-chain behaviour has not been seen from a real node.** The only chain
  this has been run against is the operator's mock chain. What only a real chain
  produces (`funding_address`, `funding_progress`, `wallet_matches: false`, the
  viewing-key export, `needs_funding_split` and the like) comes from
  `../fixtures/contract/operator/golden/`, which the operator's own Rust test
  writes from its real handlers over an in-memory chain. The UI is tested against
  those files, not against Zcash.
- **Campaigns cannot be deleted.** The wizard creates the campaign when the
  recipients are accepted (the operator needs them to report row errors and to
  plan the batches), so going back after that offers "Start a new campaign",
  not an edit.
- **Running the audit is not done from the page.** `drop-operator audit` is a
  command-line tool; the page explains it and hands out the viewing key.

## Run, test, build

Requires Node `^20.19 || >=22.12` and npm.

```bash
npm install
npm run dev          # Vite dev server on http://localhost:5173
npm run lint         # ESLint, zero warnings allowed
npm run typecheck    # tsc -b (strict)
npm test             # vitest run
npm run build        # tsc -b && vite build -> dist/
npm run e2e          # builds, then runs Playwright in real Chromium (see below)
```

Optional runtime config goes in `.env.local` (see `.env.example`):
`VITE_API_URL` (default `/api`), `VITE_ZEC_NETWORK` (`testnet` default, or
`mainnet`; any other value is a startup error), the block-explorer templates
(`VITE_EXPLORER_*_TX_URL`) and `VITE_PUBLIC_RECEIPT_BASE_URL` (where the public
receipt page is hosted, so "Share the receipt" can show a full link instead of
a path). No other file reads the environment. The explorer defaults are
ZecBlock (`testnet.zecblock.com`) for testnet and `mainnet.zcashexplorer.app` for
mainnet, with the checks behind each recorded in `src/lib/config.ts`. Explorers
are third parties and can lag: the testnet `zcashexplorer.app` stopped at block
4,331,234 while the chain was past 4,478,066, which is why it is not the testnet
default. Before submitting, `node scripts/check-explorer-links.mjs` prints the HTTP
status of the real sample's transaction and address links (not run in CI).

## The public receipt page

`/r/:id` is what a judge or auditor opens. It reads the link's claim from the
query string, asks the verifier, and shows only what passes the strict receipt
schema:

```
/r/<label>?network=testnet&tx=<txid>&tx=<txid>&commitment=<hex>&declared_total=<zatoshi>
```

`/r/demo?demo=real` (what "Sample receipt" opens, and what the home page links to)
is a **real batch from the full operator path on public testnet**: one batch, one
transaction, 8 shielded outputs, as the live verifier read it, bundled from
`../fixtures/testnet-ironwood-batch-8/`. `?demo=real-smoke` is the first, smaller
real batch (3 shielded outputs) from `../fixtures/testnet-ironwood-batch/`. Each
page says where the batch was mined and the height it was captured at (taken from
the fixtures' own READMEs), that confirmations are as of the capture and not live,
and that explorers are third parties and can lag; each explorer link goes to the
real transaction on the default testnet explorer. `?demo=1`, `?demo=findings` and
`?demo=mismatch` are synthetic goldens the Rust tests generate, for the states a
real batch does not show. All are parsed by the same strict schema, with no
hand-copied duplicate.

**Funding address.** A receipt carries the one transparent address every batch
spends from (or `null`, shown as "Unknown"). With the manifest commitment it is
what ties a receipt to a campaign; the campaign id under the title is only a label.
The page shows it short, with a copy button and a link to the explorer's address
page (`VITE_EXPLORER_*_ADDRESS_URL`, default `/address/{address}`, checked on
both networks on 2026-10-08), and no link when the text is not a plain transparent
address. The real sample's "Details" say explorers are third parties and can lag.

**Coins.** Amounts are labelled by the network of what the page is about:
**TAZ** on testnet (the test coin, worth nothing; the page says so) and **ZEC** on
mainnet. Only the label differs; the arithmetic is the same bigint zatoshi
(`src/lib/units.ts`).

## The payslip page

`/payslip` ("Check a payslip") is public too. A payslip is the small JSON file one recipient can show to prove one payout to
them, with no viewing key and without revealing anyone else's (`../docs/PRIVACY_BOUNDARY.md`, "Payslips"). The page reads
the pasted file strictly in the browser (the seven fields the verifier knows, lowercase hex, a known network, at most 4 KiB;
`src/api/payslip-input.ts`) and only then sends it, once, as the body of `POST /v1/payslip` on the verifier
(`src/api/payslip.ts`: JSON, no credentials, no cache, no referrer, no redirect, 15 s). A paste that is not a payslip gets
a plain message and sends nothing, and so does a viewing key. The verifier answers 200 with a verdict (`verified`,
`pending`, `not_found`, or `invalid` with a reason that never says which field was wrong), read by the same kind of strict
schema as the receipt (`src/api/payslip-answer.ts`). The page shows it with the amount and a short receiver **as the
payslip states them** (the answer holds neither), the confirmations and the depth, and a link to the transaction on the
network's explorer. "What this does not prove" is always on the page: before a check it is a copy of the verifier's
`NOT_PROVEN` sentences (a test compares it with the Rust source), after one it is the answer's own.

Checking here hands the receiver, the amount and the secret that also opens the output's memo to whoever runs the verifier.
The page says so next to the button, and points to `drop-operator verify-payslip --payslip FILE --tx FILE`, which needs no
network. The payslip lives in the component's state only: not in storage, the query cache or the console, and not in an
address (except the link below, which the person asks for), and the box is empty again when the person leaves. "Load a sample" is payslip 3 of the real 8-recipient testnet batch (the one the sample
receipt shows, bundled from `../fixtures/testnet-ironwood-batch-8/`); "Load a changed copy" is the same with the amount one
zatoshi higher, so a visitor can watch the check fail.

A payslip in the box that reads as one can be sent as a link or a QR code (openspec REQ-PAY-004): "Make a link", "Show QR code"
and, where the phone has a share sheet, "Share". The link is `<origin>/payslip#payslip=<the payslip's body, base64url, no
padding>` (`src/api/payslip-link.ts`; the origin is `VITE_PUBLIC_RECEIPT_BASE_URL` if the build has one). The payslip is only
after the `#`, which a browser never sends to a server, and the link is made when it is asked for, not before. It is a bearer
document, and the page says so where it makes one: whoever has the link has the payslip, its receiver, its amount and the key to
its memo, and can present it as their own. Opening a link reads the fragment once, strictly (a size cap, the base64url alphabet
and nothing else, one spelling of the bytes, then the same reading as a paste), puts the payslip in the box and takes the
fragment out of the address bar (`history.replaceState`, before anything else happens, whatever the fragment held). It never
checks by itself: the page says the payslip came from a link, and the person presses Check payslip. A fragment that is not a
payslip loads nothing and says so. The QR code is the same link, at the lowest error-correction level, drawn large on a phone
(see "QR codes").

## The get-paid page

`/get-paid` ("Get paid in ZEC") is for someone who is going to be paid by a ZecDrop payout, on a phone, and may never have used
Zcash, and it is kept short (under 240 words before anything is opened; the test keeps that as a ceiling). It is static: it names
Zodl as the example (the one wallet whose release notes have been read; the only link out is `https://zodl.com`, in a new tab, and no
app-store link is made up), keeps what a shielded wallet is, and what has not been checked about other wallets, behind one closed row
(*More about wallets*), says which address to copy
(`u1…`, real money; `utest1…` is practice; `t1…`/`t3…` are transparent and do not suit payouts; `zs1…` is an older Sapling
address) and what to expect when the payout arrives, with a link to the payslip page. The one thing it does is look at an
address the person pastes: `src/lib/address-shape.ts` says what it **looks like** from its prefix, its characters and its
length, and nothing more. It does not decode the address or test its checksum, so the page says in plain words that it checks
the shape only, not that the address is valid or yours, and that the payer's tool checks it fully. Share (the Web Share API, where
the phone has one, with one sentence and the address) and Copy turn on only for a `u1` or `utest1` shape; closing the share sheet
says nothing, and a share that fails falls back to copying.

The page makes **no request to any server**, stores nothing (no cookie, no `localStorage` or `sessionStorage`), writes nothing to
the console and puts nothing in the address bar: the address lives in the component's state and goes only where the person sends
it (openspec REQ-ONB-001). `features/get-paid/GetPaidPage.test.tsx` watches `fetch`, `XMLHttpRequest`, `sendBeacon`, storage, the
cookie, the history and the console while an address is pasted, checked, shared and copied, and scans the source of the page, its
wording and the address check for each of them; `e2e/get-paid.spec.ts` and the hosted spec count the requests the real page makes
after it has loaded (none).

## QR codes

Two screens draw one (`src/components/QrCode.tsx`): the funding request on a real-chain campaign page, beside "Copy funding address"
and "Open in wallet" (the same `zcash:` link, so a wallet that scans it fills in the address and the exact amount; openspec
REQ-FUND-003), and a payslip link on `/payslip`. The matrix of modules comes from [uqr](https://github.com/unjs/uqr) 0.1.3 (MIT, no
dependencies), loaded with `import("uqr")` into a chunk of its own (about 10 kB, 4 kB gzipped) the first time a code is drawn, so
no page that draws none pays for it. The drawing is ours: one inline SVG (a paper `rect` and one `path`), a quiet zone of four modules,
and black on white in every theme (`--qr-ink` and `--qr-paper`; `src/colours.test.ts` holds them to that), because a scanner reads
dark on light. There is no canvas, no data URI and no request. The funding code is drawn only where there is a wallet link to put
in it (not on the practice chain, not for an amount that cannot be put in one); at 768px and up it sits beside the address, below that
behind a "Show QR code" button. Where there is room a module is a whole number of pixels, so that every module is as wide as every other.
The tests read what was drawn with jsQR 1.4.0 (a devDependency that is never shipped), a decoder that did not draw it:
`src/test/qr.ts` for the SVG, `e2e/qr.ts` for a screenshot of the page at the density of a phone.

## Practice mode

"Try a practice payout" on the home page runs the operator's own screens (add the payouts, check them, fund, send, and the receipt)
against a simulation inside the page, so anyone can go through a whole payout, on a phone, with no install, no wallet and no
money (openspec REQ-DEMO-001). It is a simulation and says so on every screen:

- A banner at the top of every screen, as part of the page's frame (`Shell`), so no screen can be drawn without it: "Practice mode:
  everything here is simulated in your browser. No real money, nothing is sent anywhere, nothing is saved. Reloading starts over.", with "Leave
  practice mode". It cannot be hidden.
- "Practice" on the header capsule where a network is named, and amounts in TAZ.
- Where the operator's own screens speak of a network, a block or a send that cannot be undone, practice mode says it is pretended:
  the timeline ("Pretending to send: nothing leaves your browser.", "N of D confirmations (simulated)."), the activity log
  ("Batch N: pretend-sent (practice).", and the waiting and confirmation lines marked simulated) and the send sheet ("In a real run
  this cannot be undone.", with its own line that nothing is sent anywhere). With practice mode off those are the operator's words,
  byte for byte (`describeEvent`, `timelineSteps` and the sheet take a `practice` flag that is false unless the store says so);
  `src/copy.test.tsx` scans every screen of a practice payout for "to the network" and "the next block".
- Every simulated 64-hex value (a transaction id, the list fingerprint, the pretend deposit) begins with the ASCII of "practice",
  `7072616374696365`, which no chain's id does. A practice id gets no explorer link, and a receipt that practice mode made says so
  and labels its id "Practice id".

**What is where.** Every call the app makes to an operator or a verifier goes through one function, `sendToApi` in `src/api/client.ts`:
`fetch` until something takes its place, and never `fetch` once something has (`installApiTransport`). `src/lib/practice-mode.ts` is
what is always in the app: the flag, the marker, the switch (`startPractice`, `stopPractice`, `resumePractice`). The simulation,
`src/practice/`, is a chunk of its own (`simulation-*.js`, about 20 kB, 8 kB gzipped), fetched from the page's own origin when the
button is pressed or when a reloaded tab was in practice mode, and never otherwise; a page that never practises does not carry it.
The flag is `zecdrop.practice` = `1` in sessionStorage, the only thing practice mode writes anywhere, and it goes with the tab. The
banner says nothing is sent anywhere, which is what is true: the one thing practice mode fetches is its own code, a static file from the
page's own origin, and it sends nothing. The
simulation's state is memory, so reloading starts over, and leaving (the banner's button) removes the flag, the transport, every
timer and every open stream, and what the screens held of the payout. Leaving waits until the start page is up, so that no screen
is left asking for its data from a simulation that has gone. A real operator session is kept through it: practice mode is a stand-in
token (`PRACTICE_TOKEN`, in `src/api/operator/session.ts`) that every call carries while it lasts, the operator's own token is not
touched and is never one the simulation sees, and it is what calls carry again on leaving (a link opened meanwhile replaces it,
as it would have, and is not what calls carry either until practice mode ends). Starting practice mode clears what the screens held
of the operator's own answers (its payouts, its health), so that none of it is on a practice screen even for a moment; leaving clears
what practice mode held. `e2e/operator/practice-session.spec.ts` does it against the real operator: its token comes through, none of
its calls is made meanwhile, none of its payouts is on a practice screen, and its screens work again on leaving with no link to open.

**What it answers.** `/health` (the practice chain: `mock: true`), `/campaigns` (list, create from the CSV, get), the pretend deposit
(`fund-observed`), `start` (202), the event stream (`built`, `broadcast`, `waiting`, a confirmation at a time up to three, `settled`, a
step of about a second and a quarter apart, as Server-Sent Events from a `ReadableStream`), the operator's receipt, and
`/v1/receipt` as the public verifier would answer for a receipt it made. The shapes, statuses and sentences are the operator's own
on its practice chain: the importer (`csv.ts`, with the practice chain's look-at-the-shape address check), the planner, fee and
warnings (`plan.ts`) are ports of `drop-core`'s, and `server.test.ts` makes every request of the capture
(`../fixtures/contract/operator`) again, of the simulation, and compares the answers, as well as reading each with the page's own strict
parsers. What a list holds is read once, in `create`, and dropped: the simulation keeps counts, batch totals, fees and ids.

**What it does not do.** There is no chain: a confirmation is a timer, not a block. No batch fails and no run halts, stalls or has to
be resumed; there is no funding address, no check for a deposit and no viewing key (the practice chain's 409s); no funding from another
coin; an address is checked for its shape only (as on the practice chain: no checksum), so the practice list takes addresses a real
operator would refuse. It reads no chain, so a payslip is not checked and a receipt link it did not make is not shown: each says
so, in its own words, instead of asking a verifier (`practice_mode`, a 409).

**What proves it.** `src/practice/practice.test.tsx` was written first, and the simulation is built to pass it: a whole practice payout from the home
page to the simulated receipt, with `fetch`, `XMLHttpRequest`, `navigator.sendBeacon`, `WebSocket`, `EventSource`, IndexedDB and cookies
replaced by things that record and refuse (`src/test/leaks.ts`): the payout goes through, nothing is called, nothing is written to local
storage or a cookie, session storage holds the flag and only the flag, no list is on the console or in the page once the payout
exists, the banner is on every screen, and leaving removes the flag and every handler. The folder's own source is scanned for the
names of every way out. `e2e/practice.spec.ts` does the same in a browser at 360 and 1280 px in both themes with axe on every screen,
from the keyboard, across a reload, and `e2e/hosted/hosted.spec.ts` runs a whole payout under the generated Content-Security-Policy,
which is unchanged: the simulation makes no request, so it needs no allowance.

## Hosting a public copy (receipt viewer only)

A public, static copy of the app serves the home page, `/privacy`, `/get-paid`, the sample receipts, live receipt links and the
payslip check (answered by a hosted verifier), including a payslip opened from a link, and practice mode (which asks no one). Nothing is deployed from this repository by itself; the owner does that. The steps are in
[`../docs/runbooks/hosted-demo.md`](../docs/runbooks/hosted-demo.md). In short:

```bash
VITE_API_URL=https://<verifier-host> VITE_ZEC_NETWORK=testnet VITE_PUBLIC_ONLY=true npm run build:hosted
node scripts/serve-hosted.mjs --dir dist --port 4174      # look at it with the real headers first
npx vercel deploy dist --prod                              # owner step
node scripts/check-hosted.mjs --site https://<site> --verifier https://<verifier-host> [--mainnet-tx <txid>] [--payslip]
```

`--mainnet-tx` also asks the verifier about that mainnet transaction and fails if the verifier does not serve mainnet.
`--payslip` also checks that the verifier answers the browser's preflight for a JSON POST from the site, checks the real batch's
payslip 3 (public demo data, the page's sample) and refuses it with one digit changed; it prints verdicts, never the payslip.

`build:hosted` also writes `dist/vercel.json`: the rewrites for the client routes, caching, and a
Content-Security-Policy (`default-src 'self'`, `connect-src 'self'` plus the verifier's origin taken from
`VITE_API_URL`, no framing, no plug-ins, no `<base>`), `nosniff` and `no-referrer`. On such a copy the operator pages
(`/campaigns`, `/new`, `/campaign/*`, `/audit`) say "Run the operator on your own machine" and call nothing; a page is
treated this way when `VITE_PUBLIC_ONLY=true` or when it is served from any name other than localhost / 127.0.0.1 /
[::1] (`src/lib/mode.ts`).

## Using the operator pages

Start the operator (from the repository root) and open the link it prints:

```bash
cargo build -p drop-operator
ZECDROP_PASSPHRASE=... target/debug/drop-operator --mock-chain   # serves web/dist
# open:    http://127.0.0.1:8787/#token=<64 hex>
```

The token is in the URL **fragment**, which a browser never sends in a request.
On load the page reads it, removes it from the address bar at once
(`history.replaceState`) and keeps it **in memory only**: not in localStorage,
sessionStorage, IndexedDB, a cookie or any URL. So a reload forgets it and the
page shows how to get back in, with a field to paste the link again. Every call
to `/api` sends `Authorization: Bearer <token>`; a 401 clears the token and
shows the same screen. Progress events arrive over `fetch` with a streaming
parser (not `EventSource`, which cannot send a header), with reconnect and
backoff, and are aborted when the page is left.

On the mock chain a line directly under the header capsule of every operator page says "Practice mode:
nothing is sent to Zcash", and the campaign page offers a form that records a pretend
deposit. Both appear only because the operator's `/api/health` says
`mock: true`; they never appear against a real chain. If health says nothing
about `mock` (an older build), the page treats it as unknown: no development
controls, and a line saying so. There is no probe and no guessing.

The operator serves the app with a strict Content-Security-Policy
(`default-src 'self'`: no inline script, no eval). The app runs under it with no
violations. One thing needed care: zod compiles parsers with `new Function`
after probing for it, which a strict policy reports as a violation on every page
load, so `src/lib/zod-config.ts` turns that off before any schema is built
(`main.tsx` imports it first; a test fails if the order changes).

Errors the page has no sentence for degrade instead of failing: an unknown code
is shown with the operator's own words under a heading chosen by HTTP status
(and a body that is not an error envelope at all, such as a 421 from a security
layer, is explained by its status alone). A test fails when the operator's
source starts to raise a code the page does not list, so the sentence gets
written.

## What is kept, and what never is

Recipient addresses, amounts and memos are dropped, chosen or pasted on the first stage, sent
**once** to the loopback operator in `POST /api/campaigns`, and dropped from the
page's memory the moment the campaign is created. They are never in browser
storage, a URL, the console, an error message, or any response from the
operator (its API has no field for them). The campaign view shows counts,
batch totals, fees, transaction ids, the manifest commitment and privacy
warnings only. `features/wizard/draft.test.ts` and `e2e/operator/flow.spec.ts`
plant sentinel recipients and fail if any of them turns up anywhere.

The get-paid page keeps an address in the box and nowhere else (no request, no storage, no console, no address bar), and says so
in a test that fails if that changes. The payslip page is the one deliberate exception, and it is the person's own: a payslip they paste names their receiver, their
amount and a secret, and is sent to the verifier on request, in one POST body (see "The payslip page"). It is shown back only as
an amount and a short receiver, and kept nowhere. `features/payslip/PayslipPage.test.tsx` and `e2e/payslip.spec.ts` carry a
payslip through a check and fail if any of it turns up in storage, an address, the console, the query cache or a second request.
The link the page makes on request is the only address it is ever in, and only after the `#`; `features/payslip/PayslipLink.test.tsx`
and `e2e/payslip-link.spec.ts` open links good and bad and fail if the payslip is in the address bar or the history afterwards, in
storage, the console or any request, or if opening a link calls `fetch` at all.

Practice mode takes the example list, or one the person gives it, through the same screens as a real payout, and every call is answered
inside the page: nothing is sent, and what is kept after the campaign exists is counts and totals, not the list
(`src/practice/practice.test.tsx`, "Practice mode").

The viewing key (for an auditor) is the one thing that discloses everything. It
is requested only after the person ticks "I understand ..." (a fresh tick for
every reveal), is held in the component's state and nowhere else (not in the
query cache), is shown with the operator's warning and a copy button, is hidden
on request, after two minutes, and when the page is left, and travels to the
operator with the header `X-Zecdrop-Confirm-Disclosure: I-UNDERSTAND`. The
warning is the operator's own sentence; a test compares it with the Rust source.
`ViewingKeyCard.test.tsx` and `e2e/operator/viewing-key.spec.ts` carry a
recognisable key through ask, show, copy, hide, leave and return, and fail if any
piece of it turns up in storage, a URL, a link, the console, the query cache, a
later request or the page after it is hidden; a source scan fails if the card or
its hook mention storage, navigation, logging or a cache.

## Tests

- `npm test`: unit and component tests (vitest, jsdom). The operator pages run
  against `src/test/fake-operator.ts`, which answers from the captured fixtures
  in `../fixtures/contract/operator/`, so they see real response shapes.
- **The contract.** `../scripts/capture-operator-fixtures.mjs` starts the real
  binary three times on the mock chain, drives it with sentinel CSVs and saves
  every response (and two event-stream transcripts) as JSON. The strict zod
  schemas in `src/api/operator/schemas.ts` are built from those files, and a
  test parses every one, and so is every file in `golden/`. `node scripts/capture-operator-fixtures.mjs --check`
  (from the repository root) regenerates them in a temporary folder and fails if
  they differ; run it after any change to the operator's API. When a fixture
  file is added or removed (by the capture script, or by the operator's Rust test
  for `golden/`), run `npm run fixtures:sync` in `web/` to rewrite the list the
  tests read; a test fails while the list is stale.
- **Rust agreement.** Sentences shown to people (privacy warnings, verifier
  findings, phase labels, the disclosure warning) are word for word the core's,
  and tests compare them with the Rust source. A test also fails if the operator
  can raise an error code the page has no sentence for, or if a field is added
  to `CampaignView`. The same goes for the verifier's payslip answer: its fields, its reasons and the five
  "does not prove" sentences are compared with `crates/drop-verifier/src/api.rs` and `crates/drop-verify/src/payslip.rs`.
- `npm run e2e` runs three Playwright projects in real Chromium. It needs a
  one-time `npx playwright install chromium`, and (for the operator project) a
  built `../target/debug/drop-operator` (`cargo build -p drop-operator`); it
  builds `dist/` itself.
  - **public**: the public pages over `vite preview` (and practice mode, `practice.spec.ts`: a whole simulated payout, at both widths in both themes, every
    screen with its banner and axe, from the keyboard, across a reload, and leaving), both themes, 360px and
    1280px: no console errors, no requests leaving the origin, no sideways
    scrolling, zero axe WCAG 2.2 A/AA violations, tab order and focus. The payslip page is
    checked in every state of its result (the browser answers for the verifier), from the keyboard, and for where the payslip goes,
    as a link and a QR code (read back from the pixels), and opened from a link, good and bad, with the address bar bare afterwards.
    The get-paid page is checked with an address of every shape, with a share sheet that accepts, is closed and refuses, at 360px
    for thumb-sized controls, and for the requests it makes after it has loaded (none).
    The screen (`screen.spec.ts`, "The screen" in DESIGN.md): at 360, 390, 768 and 1280px that no focusable element and no line of text on any
    public page is clipped by the curves of the frame (a rounded box by the middle of its arc), that the frame takes no press and what is above
    what, the scale of curves, the grain, a press, a bar's label and the lens's pill, a new page's cross-fade, and forced colours and print;
    each of these is also checked under "reduce motion", where none of it moves.
    Narrow screens (`responsive.spec.ts`, "Narrow screens" in DESIGN.md): every public page at 320, 340, 360, 375, 414, 600, 768 and 1024px,
    and every screen of the practice payout at 320x568, in landscape (667x375) and on a tablet (768x1024), with nothing wider than the screen,
    the capsule inside it, and the confirm sheet inside its window or scrolling.
  - **hosted**: a production build made the way a public deployment is made, served with the headers and
    rewrites of the `vercel.json` generated for it, against a stub verifier on another origin
    (`e2e/hosted/`). It asserts that the Content-Security-Policy produces no violation on the home page, the samples and a
    live receipt link, that the policy is really in force (a request to any other origin is blocked and reported), that
    the operator pages explain themselves and call nothing, that a payslip is checked against the stub (preflight, one POST of
    JSON, Verified for the sample, a refusal for the changed copy) with no violation, that a whole practice payout runs under the
    unchanged policy asking no one for anything, that a page opened from a payslip link loads
    under the policy and the stub answers its check, that the get-paid page takes, shares and
    copies an address under the policy and asks no one for anything, and that `scripts/check-hosted.mjs` passes.
  - **operator**: `e2e/operator/global-setup.ts` starts the real binary on a
    free loopback port with a temporary store, reads the token from its start-up banner,
    seeds three campaigns, and stops it afterwards. `flow.spec.ts` creates a
    campaign through the three stages from a sentinel CSV, records mock funding,
    starts, watches it settle and opens the receipt link, then checks that no
    sentinel is in storage (localStorage, sessionStorage, IndexedDB, cookies,
    caches), any URL, the console, any request other than the one that creates
    the campaign, or any response. `token.spec.ts` covers a missing, wrong,
    malformed and query-string token. `csp.spec.ts` walks the main pages under the
    operator's Content-Security-Policy and fails on any violation.
    `viewing-key.spec.ts` is the key test above. `a11y.spec.ts` runs axe on every
    operator page at 320px, 360px and 1280px in both themes (and asks, at each, that nothing is wider than the screen), with every section opened,
    the send sheet, a run in progress, a stopped run and a failed one (from the operator's captured
    files), and the real-chain funding states and the key (from its `golden/` files). `funding-qr.spec.ts` reads the funding
    QR code from the pixels, at both widths and in both themes, for testnet and mainnet. The global setup refuses to run
    if `dist/` is older than `src/`.

## Folder map

```
src/
  api/          wire types + strict zod validators (types, findings, warnings),
                receipt link + fetch (receipt-query, receipt, endpoints, demo);
                the payslip check (payslip-input: the paste, payslip-answer, payslip: the POST, payslip-sample,
                payslip-link: a payslip as a link and back);
    operator/   the operator API: schemas (strict, from captured responses),
                client, session (in-memory token), events (SSE over fetch)
  components/   app chrome (TopBar: the header capsule, Footer, AppShell), CopyButton, Zec, TxActions, QrCode;
                ui/ is generated by shadcn
  features/
    home/       "/"             public pitch
    receipt/    "/r/:id"        PUBLIC receipt viewer
    get-paid/   "/get-paid"     "Get paid in ZEC": how to be paid, the address check, Share and Copy
    payslip/    "/payslip"      "Check a payslip": the paste box, the verdict, what it does not prove, the link and QR code
    privacy/    "/privacy"      "Privacy boundary" page
    operator/   the token gate, hooks, wording (messages.ts),
                batch list, funding (with its QR code) and start panels
    campaigns/  "/campaigns"    the operator's campaigns
    wizard/     "/new/..."      three stages (Payouts, Check, Send), the in-memory draft, PrivacyWarnings
    campaign/   "/campaign/:id" status, batches, activity, "Share the receipt"
    audit/      "/audit"        what the audit checks; the viewing-key card
  practice/     practice mode's simulation, a chunk of its own (importer, planner, server, run, events, verifier)
  lib/          config, zod-config, zec (money), address-shape (what a pasted address looks like), qr (the quiet zone, the path), share, practice-mode (the flag and the switch), view-transition (a new page's cross-fade, where the browser has it), phase, fees, ids, explorer, theme, utils
  test/         fake operator, fixture loader, Rust-source reader, render helper, leak watcher, the practice payout walk
  index.css     palette (Redacted paper, light and dark), roles, the screen's frame and the scale of curves, slips, motion, Tailwind map
tests/          guard tests that run ESLint itself
e2e/            Playwright specs (public pages) and e2e/operator/ (real operator)
PROVENANCE.md   what is hand-written, what is generated, and by which tool
```

To add another UI primitive, run the generator with `npx shadcn@4.21.4 add <name>`
(it is not installed as a dependency; `components.json` is what it reads), then
note it in `PROVENANCE.md`. Delete the `@import "shadcn/tailwind.css"` line it may
add to `src/index.css`: that stylesheet comes with the CLI package, which this
project does not install.

Components import from `@/` (alias for `src/`).

## Rules

**1. No `import.meta` outside `src/lib/config.ts`.** That module is the single
source of runtime config; everything else does `import { config } from
"@/lib/config"`. ESLint enforces this (`no-restricted-syntax`), and
`tests/lint-guards.test.ts` fails if the rule is ever loosened.

**2. No recipient address, amount or memo is ever persisted or echoed.** See
"What is kept" above. Do not add a field to the wizard draft, a route, an error
message or a log line that could carry one, and extend the sentinel tests if
you add a place where data is kept.

Other conventions worth knowing:

- Money is **bigint zatoshi** via `lib/zec.ts` (`parseZec` / `formatZec`).
  Never `Number`, `parseFloat`, or bare `BigInt` on user input. Wire amounts
  are decimal strings.
- Wire schemas are `.strict()`: a payload with any field the schema does not
  know (a per-recipient field above all) is rejected, not stripped.
- Batch numbers are 0-based everywhere, as in the core's messages.
- A batch is shown "Final" only with evidence (the campaign has settled).
- A `null` in a receipt means the verifier could not establish that fact. The
  page shows "Unknown", never zero.
- Claims name what a key-less verifier can compute. The public can see how much
  value entered the shielded pool, in how many actions and at what fee; it
  cannot see that the money reached the people on the list. `src/copy.test.tsx`
  renders every page and fails on phrases that claim more ("everyone was paid",
  "verified payouts", ...).
- No third-party requests: the two fonts (Archivo, IBM Plex Mono; OFL,
  see PROVENANCE.md) are bundled with the page, nothing is loaded from a CDN.
- Design tokens (in `src/index.css`) were contrast-checked against WCAG 2.2 AA
  in both themes. Re-check if you change a value.
