# ZecDrop web

The UI for ZecDrop, confidential batch payouts on Zcash ("private amounts,
public accountability"). The same bundle serves two roles:

- **Operator** routes (`/campaigns`, `/new/*`, `/campaign/:id`, `/audit`),
  served by the local operator binary that holds the spend keys. They need the
  operator's bearer token (below).
- **Public** routes (`/`, `/r/:id`, `/privacy`), safe to serve from the separate,
  key-less hosted verifier.

There is no wallet-connect and no EVM code in this app.

What is real: the public pages, the operator pages (campaign list, five-step
wizard, campaign view with live progress, receipt link, audit explainer), the
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
what ties a receipt to a campaign; the campaign id at the top is only a label.
The page shows it short, with a copy button and a link to the explorer's address
page (`VITE_EXPLORER_*_ADDRESS_URL`, default `/address/{address}`, checked on
both networks on 2026-10-08), and no link when the text is not a plain transparent
address. The real-sample banner says explorers are third parties and can lag.

**Coins.** Amounts are labelled by the network of what the page is about:
**TAZ** on testnet (the test coin, worth nothing; the page says so) and **ZEC** on
mainnet. Only the label differs; the arithmetic is the same bigint zatoshi
(`src/lib/units.ts`).

## Hosting a public copy (receipt viewer only)

A public, static copy of the app serves the home page, `/privacy`, the sample receipts and live receipt links (answered
by a hosted verifier). Nothing is deployed from this repository by itself; the owner does that. The steps are in
[`../docs/runbooks/hosted-demo.md`](../docs/runbooks/hosted-demo.md). In short:

```bash
VITE_API_URL=https://<verifier-host> VITE_ZEC_NETWORK=testnet VITE_PUBLIC_ONLY=true npm run build:hosted
node scripts/serve-hosted.mjs --dir dist --port 4174      # look at it with the real headers first
npx vercel deploy dist --prod                              # owner step
node scripts/check-hosted.mjs --site https://<site> --verifier https://<verifier-host>
```

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

On the mock chain a banner on every operator page says "Mock chain: nothing is
sent to Zcash", and the campaign page offers a form that records a pretend
deposit. Both appear only because the operator's `/api/health` says
`mock: true`; they never appear against a real chain. If health says nothing
about `mock` (an older build), the page treats it as unknown: no development
controls, and a strip saying so. There is no probe and no guessing.

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

Recipient addresses, amounts and memos are typed or pasted into the wizard, sent
**once** to the loopback operator in `POST /api/campaigns`, and dropped from the
page's memory the moment the campaign is created. They are never in browser
storage, a URL, the console, an error message, or any response from the
operator (its API has no field for them). The campaign view shows counts,
batch totals, fees, transaction ids, the manifest commitment and privacy
warnings only. `features/wizard/draft.test.ts` and `e2e/operator/flow.spec.ts`
plant sentinel recipients and fail if any of them turns up anywhere.

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
  to `CampaignView`.
- `npm run e2e` runs three Playwright projects in real Chromium. It needs a
  one-time `npx playwright install chromium`, and (for the operator project) a
  built `../target/debug/drop-operator` (`cargo build -p drop-operator`); it
  builds `dist/` itself.
  - **public**: the public pages over `vite preview`, both themes, 360px and
    1280px: no console errors, no requests leaving the origin, no sideways
    scrolling, zero axe WCAG 2.2 A/AA violations, tab order and focus.
  - **hosted**: a production build made the way a public deployment is made, served with the headers and
    rewrites of the `vercel.json` generated for it, against a stub verifier on another origin
    (`e2e/hosted/`). It asserts that the Content-Security-Policy produces no violation on the home page, the samples and a
    live receipt link, that the policy is really in force (a request to any other origin is blocked and reported), that
    the operator pages explain themselves and call nothing, and that `scripts/check-hosted.mjs` passes.
  - **operator**: `e2e/operator/global-setup.ts` starts the real binary on a
    free loopback port with a temporary store, reads the token from its banner,
    seeds three campaigns, and stops it afterwards. `flow.spec.ts` creates a
    campaign through the wizard from a sentinel CSV, records mock funding,
    starts, watches it settle and opens the receipt link, then checks that no
    sentinel is in storage (localStorage, sessionStorage, IndexedDB, cookies,
    caches), any URL, the console, any request other than the one that creates
    the campaign, or any response. `token.spec.ts` covers a missing, wrong,
    malformed and query-string token. `csp.spec.ts` walks the main pages under the
    operator's Content-Security-Policy and fails on any violation.
    `viewing-key.spec.ts` is the key test above. `a11y.spec.ts` runs axe on every
    operator page at 360px and 1280px in both themes, including the real-chain
    funding states and the key, served from the operator's `golden/` files. The global setup refuses to run
    if `dist/` is older than `src/`.

## Folder map

```
src/
  api/          wire types + strict zod validators (types, findings, warnings),
                receipt link + fetch (receipt-query, receipt, endpoints, demo);
    operator/   the operator API: schemas (strict, from captured responses),
                client, session (in-memory token), events (SSE over fetch)
  components/   app chrome (TopBar, Footer, AppShell), CopyButton, Zec, TxActions;
                ui/ is generated by shadcn
  features/
    home/       "/"             public pitch
    receipt/    "/r/:id"        PUBLIC receipt viewer
    privacy/    "/privacy"      "Privacy boundary" page
    operator/   the token gate, mock banner, hooks, wording (messages.ts),
                batch list, funding and start panels
    campaigns/  "/campaigns"    the operator's campaigns
    wizard/     "/new/:step"    five steps, the in-memory draft, PrivacyWarnings
    campaign/   "/campaign/:id" status, batches, activity, "Share the receipt"
    audit/      "/audit"        what the audit checks; the viewing-key card
  lib/          config, zod-config, zec (money), phase, fees, ids, explorer, theme, utils
  test/         fake operator, fixture loader, Rust-source reader, render helper
  index.css     design tokens, theme (dark default, light via data-theme), Tailwind map
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
- No third-party requests: fonts are system stacks, nothing is loaded from a
  CDN.
- Design tokens (in `src/index.css`) were contrast-checked against WCAG 2.2 AA
  in both themes. Re-check if you change a value.
