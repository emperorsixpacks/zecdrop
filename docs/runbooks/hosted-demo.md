# Runbook — hosted public demo (receipt viewer)

**Status (2026-10-15): the static site is deployed, the verifier is not.** The site is live at
<https://zecdrop-site.vercel.app> (uploaded with the Vercel CLI from `web/dist`, built with `npm run build:hosted`; it was
checked from outside: every route answers, the headers are present, no console errors, the bundled real receipt renders). It
was built for a verifier at `https://zecdrop-verifier.fly.dev`, which does not exist yet: `deploy/fly.toml` is ready, but
Fly.io needs a payment method before it will create the app. Until the verifier is up, live receipt links say it is
unreachable; the bundled samples work. Before that, everything below was also checked locally against a stub verifier
(`web/e2e/hosted/`).

## What this is, and what it is not

A public, static copy of the web app that works as the **receipt viewer**: the home page, `/privacy`, the bundled
sample receipts (`/r/demo?demo=real`) and live receipt links (`/r/<name>?network=…&tx=…&commitment=…&declared_total=…`),
which it answers by asking a **hosted verifier**. The verifier is key-less and stateless (`crates/drop-verifier`).

It is **not** the operator. The operator pages (`/campaigns`, `/new`, `/campaign/*`, `/audit`) need the operator
program, which holds the spend keys and the recipient list and runs only on the owner's own computer. On the hosted
copy those paths show an explanation ("Run the operator on your own machine") and call nothing.

```
browser ──https──▶ static site (web/dist)           receipt page, sample receipts, privacy page
   │
   └────https──▶ hosted verifier (deploy/verifier.Dockerfile) ──gRPC──▶ testnet.zec.rocks:443
```

## 1. Deploy the verifier

A VPS works too: [`deploy/vps/`](../../deploy/vps/README.md) has a compose file with Caddy for the https certificate.

Build and run from the repository root (any host that runs a container and gives it a public https address):

```bash
docker build -f deploy/verifier.Dockerfile -t zecdrop-verifier .
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e TESTNET_ENDPOINT=https://testnet.zec.rocks:443 \
  -e CORS_ORIGIN=https://<web-origin> \
  zecdrop-verifier
```

| Variable | Meaning |
|---|---|
| `PORT` | port to listen on (default 8080) |
| `TESTNET_ENDPOINT` | the lightwalletd / Zaino endpoint it reads testnet from (default `https://testnet.zec.rocks:443`) |
| `CORS_ORIGIN` | the **exact origin of the web site** (`https://<web-origin>`, no path, no trailing slash). Without it the browser cannot read the verifier's answers |

The verifier holds no keys and no state, so a public bind is intended. Mainnet is opt-in (`--mainnet-endpoint`);
the demo is testnet only, so do not add it.

Check it: `curl https://<verifier-host>/v1/health` returns `{"ok":true}`.

## 2. Build the page for a public deployment

```bash
cd web
npm ci
VITE_API_URL=https://<verifier-host> \
VITE_ZEC_NETWORK=testnet \
VITE_PUBLIC_ONLY=true \
npm run build:hosted
```

| Variable | Meaning |
|---|---|
| `VITE_API_URL` | the verifier's origin, `https://<verifier-host>` (no trailing slash). The page asks it for receipts (`GET /v1/receipt`). The same value becomes the `connect-src` of the Content-Security-Policy, so there is one place to set the verifier's address |
| `VITE_ZEC_NETWORK` | `testnet` for the demo (amounts then show as TAZ) |
| `VITE_PUBLIC_ONLY` | `true`: the operator pages explain themselves instead of calling an operator. (A page served from any name other than localhost / 127.0.0.1 / [::1] behaves this way anyway.) |

`npm run build:hosted` builds `web/dist/` and then writes **`web/dist/vercel.json`** (`web/scripts/hosted-config.mjs`),
which holds:

- the **rewrites** that answer the client routes (`/r/*`, `/privacy`, `/campaigns`, `/new`, `/campaign/*`, `/audit`)
  with `index.html`;
- long caching for the hashed files in `/assets/` and none for the page itself;
- the security headers: `Content-Security-Policy: default-src 'self'; connect-src 'self' <verifier origin>;
  frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`, plus `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and a restrictive `Permissions-Policy`.

The file is generated, not committed, because `vercel.json` cannot read environment variables. The policy allows no
inline script, no `eval` and no third-party host, so **do not add** analytics, web fonts or a CDN to the page: they
would be blocked.

Look at it before deploying (this serves `dist/` with exactly those headers and rewrites, on `127.0.0.1`):

```bash
node scripts/serve-hosted.mjs --dir dist --port 4174
```


## 3. Deploy the static site (owner)

Deploy the **`web/dist/`** folder, which contains `vercel.json`. With the Vercel CLI:

```bash
cd web
npx vercel deploy dist --prod
```

Any static host works if it applies the same headers and rewrites (translate `dist/vercel.json`). The expected
behaviour is that the host reads `vercel.json` from the deployed folder; **confirm it with the check in step 5**, which
fails if the headers or rewrites are missing.

To deploy from Git instead, run `VITE_API_URL=https://<verifier-host> node scripts/hosted-config.mjs --root` once to
write `web/vercel.json`, commit it, set the project's root to `web`, its build command to `npm run build:hosted`, its
output folder to `dist`, and the three variables above in the project's settings.

Then set the verifier's `CORS_ORIGIN` to the site's final origin (step 1) if it was not known yet.

## 4. The shareable receipt link for the real batch

The real 8-output batch (mined on public testnet at height 4,478,289) has these public values, from
`fixtures/testnet-ironwood-batch-8/6e235918…/receipt.json`:

| | |
|---|---|
| txid | `6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955` |
| commitment | `698ec02d7e72ec60a11f5a6e176288bf4a27e86304dfe75330bfb82051b976f8` |
| declared total | `500000` (zatoshi) |

```
https://<site>/r/real-8?network=testnet&tx=6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955&commitment=698ec02d7e72ec60a11f5a6e176288bf4a27e86304dfe75330bfb82051b976f8&declared_total=500000
```

`real-8` is only a label; the page ignores it. The link asks the verifier live, so it needs steps 1 to 3. The bundled
`https://<site>/r/demo?demo=real` shows the same batch from a file captured earlier (confirmations as of the capture)
and works even if the verifier is down.

## 5. Checks after deploying

```bash
cd web
node scripts/check-hosted.mjs --site https://<site> --verifier https://<verifier-host>
node scripts/check-explorer-links.mjs
```

`check-hosted.mjs` prints one line per check and exits 1 if one fails. It checks that the page and every client route
answer 200 with the page, that the Content-Security-Policy and the other headers are present and name this verifier, that
a built script is cached as immutable, that the verifier answers `/v1/health`, and that it answers the real batch's
receipt to this site's origin (CORS) as settled, with no findings and the funding address. It also prints the shareable
link. `check-explorer-links.mjs` fetches the explorer pages for the real samples' transactions and the funding address
(expect 200) and for an unknown transaction and address (expect 404).

Then, in a browser, open the shareable link and the sample, with the developer console open: no Content-Security-Policy
violation and no error should appear. Open `/campaigns`: it should say "Run the operator on your own machine".

## What not to do

- **No keys.** No seed, no viewing key, no spend key on the site, in its environment, in the build, or on the verifier's
  host. Neither piece needs one.
- **Do not host the operator.** It holds the spend keys and the recipient list, binds only to loopback and refuses other
  `Host` names on purpose. The hosted page must never be pointed at an operator (`VITE_API_URL` is the verifier).
- **No mainnet** for this demo; the verifier is started without `--mainnet-endpoint`.
- **No `CORS_ORIGIN=*`**; name the site.
- **No third-party scripts, fonts or analytics** in the page; the policy blocks them.
- **Do not commit** `web/dist/` or the generated `vercel.json` (except with `--root`, deliberately).
- Do not read "Transaction Not Found" on an explorer as a problem with the receipt: explorers are third parties and can lag
  (the default testnet explorer is ZecBlock; see `web/src/lib/config.ts`).

## If something is wrong

| Symptom | Likely cause |
|---|---|
| Console: "Refused to connect … Content Security Policy" | the page was built with a different `VITE_API_URL` than the verifier it is calling |
| Console: a CORS error on `/v1/receipt` | the verifier's `CORS_ORIGIN` is not the site's exact origin |
| A client route (`/r/…`) gives the host's 404 | the rewrites are not applied: the host did not read `vercel.json` |
| The receipt page says the verifier is unreachable | the verifier is down or its address is wrong; check `/v1/health` |
| TAZ shown as ZEC, or the reverse | `VITE_ZEC_NETWORK` is wrong for the build |

## Where the pieces are

`deploy/verifier.Dockerfile` · `web/scripts/hosted-config.mjs` (headers, rewrites) · `web/scripts/serve-hosted.mjs`
(local preview with those headers) · `web/scripts/check-hosted.mjs` (after deploying) · `web/scripts/check-explorer-links.mjs`
· `web/e2e/hosted/` (the tests that run all of this against a stub verifier) · `web/src/features/operator/HostedNotice.tsx`
(the explanation on operator paths).
