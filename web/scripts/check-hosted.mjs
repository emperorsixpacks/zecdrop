// Checks a deployed public copy of the app, and the verifier it talks to. Run it
// after deploying; it changes nothing and needs no keys.
//
//   node scripts/check-hosted.mjs --site https://<site> --verifier https://<verifier>
//
// It prints one line per check and exits 1 if any failed. What it checks:
//   - the page and the client routes answer 200 with HTML (the rewrites work)
//   - the security headers are on the page (a Content-Security-Policy that lets it
//     talk to this verifier, nosniff, no referrer, no framing)
//   - a built asset is cached as immutable
//   - the verifier answers /v1/health, and answers the real 8-output batch's receipt
//     to this site's origin (CORS), as settled, with no findings and the funding address
//
// The receipt request is built from the real sample's fixture (its txid, its
// commitment and its declared total), the same values as the shareable link.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const site = option("--site")?.replace(/\/+$/u, "");
const verifier = option("--verifier")?.replace(/\/+$/u, "");
if (!site || !verifier) {
  console.error("usage: node scripts/check-hosted.mjs --site https://<site> --verifier https://<verifier>");
  process.exit(2);
}

// The real sample: fixtures/testnet-ironwood-batch-8/<txid>/receipt.json.
const root = resolve(process.cwd(), "..", "fixtures", "testnet-ironwood-batch-8");
const [dir] = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[0-9a-f]{64}$/u.test(e.name));
const sample = JSON.parse(readFileSync(join(root, dir.name, "receipt.json"), "utf8"));
const txid = sample.batches[0].txid;
const query = new URLSearchParams({ network: sample.network });
query.append("tx", txid);
query.set("commitment", sample.manifest_commitment);
query.set("declared_total", sample.declared_total);

const siteOrigin = new URL(site).origin;
const verifierOrigin = new URL(verifier).origin;
let failed = false;
const report = (ok, what, detail = "") => {
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
};
const get = (url, headers = {}) => fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });

// ---- the page ---------------------------------------------------------------------
const home = await get(`${site}/`);
const html = await home.text();
report(home.status === 200 && (home.headers.get("content-type") ?? "").includes("text/html"), "the page answers", `${String(home.status)} ${home.headers.get("content-type") ?? ""}`);

for (const path of ["/r/demo?demo=real", "/privacy", "/campaigns", "/new/basics", "/campaign/c-1", "/audit"]) {
  const response = await get(`${site}${path}`);
  const body = await response.text();
  report(response.status === 200 && body.includes('<div id="root">'), `client route ${path}`, String(response.status));
}

const csp = home.headers.get("content-security-policy") ?? "";
report(csp.includes("default-src 'self'"), "Content-Security-Policy has default-src 'self'");
const connect = /connect-src ([^;]*)/u.exec(csp)?.[1] ?? "";
report(connect.split(" ").includes(verifierOrigin), "its connect-src names this verifier", connect);
report(!/unsafe-|\*/u.test(csp), "it has no unsafe-* and no wildcard");
report(csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'") && csp.includes("base-uri 'none'"), "it forbids framing, plug-ins and <base>");
report(home.headers.get("x-content-type-options") === "nosniff", "X-Content-Type-Options: nosniff");
report(home.headers.get("referrer-policy") === "no-referrer", "Referrer-Policy: no-referrer");

const asset = /\/assets\/[^"']+\.js/u.exec(html)?.[0];
if (asset === undefined) report(false, "the page names a built script");
else {
  const response = await get(`${site}${asset}`);
  await response.arrayBuffer();
  report(response.status === 200 && (response.headers.get("cache-control") ?? "").includes("immutable"), `${asset} is cached as immutable`, response.headers.get("cache-control") ?? "");
}

// ---- the verifier -----------------------------------------------------------------
const health = await get(`${verifier}/v1/health`);
report(health.status === 200 && (await health.json()).ok === true, "the verifier answers /v1/health");

const receipt = await get(`${verifier}/v1/receipt?${query.toString()}`, { Origin: siteOrigin, Accept: "application/json" });
const allowed = receipt.headers.get("access-control-allow-origin");
report(allowed === siteOrigin || allowed === "*", "the verifier allows this site's origin (CORS)", allowed ?? "no access-control-allow-origin");
const body = receipt.status === 200 ? await receipt.json() : null;
report(body !== null, "the verifier answers the real batch's receipt", String(receipt.status));
if (body !== null) {
  report(body.phase?.phase === "settled", "the receipt is settled", JSON.stringify(body.phase));
  report(Array.isArray(body.findings) && body.findings.length === 0, "the receipt has no findings", JSON.stringify(body.findings));
  report(typeof body.funding_address === "string" && body.funding_address === sample.funding_address, "the receipt carries the funding address", String(body.funding_address));
  report(body.batches?.[0]?.txid === txid, "the receipt is for the batch asked about");
}

console.log(`\nshareable link: ${site}/r/real-8?${query.toString()}`);
if (failed) {
  console.error("\nAt least one check failed.");
  process.exit(1);
}
