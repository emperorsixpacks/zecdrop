# Hosted verifier on a VPS

Runs the key-less verifier (`crates/drop-verifier`) behind https on any VPS with Docker. It holds **no keys and no secrets**
and reads only public Zcash testnet. Do not run the operator here: it holds the spend keys and stays on the owner's own
machine ([ADR 0002](../../docs/ADR/0002-local-operator-and-keyless-verifier.md)).

## You need

- A VPS with Docker and the Compose plugin, ports **80 and 443** open to the internet, and outbound access to
  `testnet.zec.rocks:443`.
- A name that points at the VPS (an `A` record to its IP). A subdomain of any domain works, and so does a free one from a
  dynamic-DNS service. The site only accepts an https verifier, so a bare IP does not do.
- The code. The repository is private, so the owner must add you as a collaborator first.

## Steps

```bash
git clone https://github.com/JemIIahh/zecdrop.git
cd zecdrop/deploy/vps
cp .env.example .env        # then edit .env: VERIFIER_DOMAIN and CORS_ORIGIN
docker compose up -d --build
```

The first build compiles the verifier and takes several minutes. Then check:

```bash
curl https://<your-name>/v1/health      # {"ok":true}
```

Send the owner `https://<your-name>` (no trailing slash). They rebuild the site with
`VITE_API_URL=https://<your-name>` and redeploy it, because the site's content-security policy names the verifier's origin.
Then run `node web/scripts/check-hosted.mjs --site https://zecdrop-site.vercel.app --verifier https://<your-name>`.

## Notes

- `CORS_ORIGIN` must be the site's exact origin, `https://zecdrop-site.vercel.app`: no path, no trailing slash. Without it the
  browser cannot read the verifier's answers.
- The verifier's port is not published; only Caddy (80 and 443) is reachable. Keep the firewall to those two and SSH.
- Update: `git pull && docker compose up -d --build`. Logs: `docker compose logs -f`. Stop: `docker compose down`.
- Tested locally with the name `localhost`: the real testnet receipt came back `settled` with 8 outputs through Caddy, and the
  site's origin was allowed while another origin got no CORS header. Not yet tried on a real VPS with a real certificate.
