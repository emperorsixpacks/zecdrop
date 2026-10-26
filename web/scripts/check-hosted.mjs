// Checks a deployed public copy of the app, and the verifier it talks to. Run it
// after deploying; it changes nothing and needs no keys.
//
//   node scripts/check-hosted.mjs --site https://<site> --verifier https://<verifier> [--mainnet-tx <txid>] [--payslip]
//
// It prints one line per check and exits 1 if any failed. What it checks:
//   - the page and the client routes answer 200 with HTML (the rewrites work)
//   - the security headers are on the page (a Content-Security-Policy that lets it
//     talk to this verifier, nosniff, no referrer, no framing)
//   - a built asset is cached as immutable
//   - a picture of the home page tour answers as an image (/tour is files, not a client route)
//   - the verifier answers /v1/health, and answers the real 8-output batch's receipt
//     to this site's origin (CORS), as settled, with no findings and the funding address
//   - with --mainnet-tx, that the verifier serves mainnet: it answers a receipt request for
//     that mainnet transaction with a receipt. Any mainnet transaction id will do; the declared
//     total and the commitment sent are placeholders, so what the receipt finds is not looked at.
//   - with --payslip, that the verifier checks payslips for this site: it answers the browser's preflight for a
//     JSON POST from this site's origin, answers the real batch's payslip 3 (public demo data, the page's
//     sample) as verified or pending without repeating anything of it, and refuses the same payslip with one
//     digit changed. It prints verdicts and statuses, never a receiver, an amount or a secret.
//
// The receipt request is built from the real sample's fixture (its txid, its
// commitment and its declared total), the same values as the shareable link.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const site = option("--site")?.replace(/\/+$/u, "");
const verifier = option("--verifier")?.replace(/\/+$/u, "");
const mainnetTx = option("--mainnet-tx");
const checkPayslips = args.includes("--payslip");
if (!site || !verifier) {
  console.error("usage: node scripts/check-hosted.mjs --site https://<site> --verifier https://<verifier> [--mainnet-tx <txid>] [--payslip]");
  process.exit(2);
}
if (args.includes("--mainnet-tx") && !/^[0-9a-f]{64}$/u.test(mainnetTx ?? "")) {
  console.error("--mainnet-tx needs a transaction id: 64 lowercase hex characters");
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

for (const path of ["/r/demo?demo=real", "/privacy", "/payslip", "/campaigns", "/new/basics", "/campaign/c-1", "/audit"]) {
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

// The home page tour's pictures are files in /tour (web/public/tour), not client routes: one answers as a WebP image.
const picture = "/tour/receipt-light.webp";
const tourPicture = await get(`${site}${picture}`);
const tourBytes = Buffer.from(await tourPicture.arrayBuffer());
report(
  tourPicture.status === 200 && tourPicture.headers.get("content-type") === "image/webp" && tourBytes.subarray(0, 4).toString("ascii") === "RIFF",
  `${picture} is served as an image`,
  `${String(tourPicture.status)} ${tourPicture.headers.get("content-type") ?? ""}`,
);

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

// ---- mainnet, when asked ----------------------------------------------------------
if (mainnetTx !== undefined) {
  const what = "the verifier serves mainnet";
  const probe = new URLSearchParams({ network: "mainnet" });
  probe.append("tx", mainnetTx);
  probe.set("declared_total", "1");
  probe.set("commitment", "0".repeat(64));
  try {
    const response = await get(`${verifier}/v1/receipt?${probe.toString()}`, { Origin: siteOrigin, Accept: "application/json" });
    const answer = await response.json().catch(() => null);
    const code = typeof answer?.error?.code === "string" ? answer.error.code : undefined;
    if (response.status === 200 && answer?.phase !== undefined && answer.phase !== null) {
      report(true, what, `HTTP 200, phase ${String(answer.phase.phase ?? answer.phase)}`);
    } else if (response.status === 400 && code === "network_not_configured") {
      report(false, what, `verifier is not serving mainnet (HTTP 400 ${code})`);
    } else {
      report(false, what, `HTTP ${String(response.status)}${code === undefined ? "" : ` ${code}`}${response.status === 200 ? ", the answer has no phase" : ""}`);
    }
  } catch (error) {
    report(false, what, `no answer (${error instanceof Error ? error.message : String(error)})`);
  }
}

// ---- payslips, when asked ---------------------------------------------------------
if (checkPayslips) {
  // Payslip 3 of the real batch: the demo recipients are throwaway accounts, and it is the page's own sample.
  const slip = JSON.parse(readFileSync(join(root, dir.name, "payslips", "payslip-3.json"), "utf8"));
  const endpoint = `${verifier}/v1/payslip`;
  const reason = (error) => `no answer (${error instanceof Error ? error.message : String(error)})`;

  // What a browser asks before it POSTs JSON from another origin: may this site send POST with a content-type?
  const preflightWhat = "the verifier lets this site POST a payslip (CORS preflight)";
  try {
    const preflight = await fetch(endpoint, {
      method: "OPTIONS",
      headers: { Origin: siteOrigin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const origin = preflight.headers.get("access-control-allow-origin");
    const methods = (preflight.headers.get("access-control-allow-methods") ?? "").toUpperCase();
    const headers = (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    const allowed = preflight.ok && (origin === siteOrigin || origin === "*") && (methods.includes("POST") || methods === "*") && (headers.includes("content-type") || headers === "*");
    report(allowed, preflightWhat, allowed ? String(preflight.status) : `HTTP ${String(preflight.status)}, allow-origin ${origin ?? "none"}, allow-methods ${methods || "none"}, allow-headers ${headers || "none"}`);
  } catch (error) {
    report(false, preflightWhat, reason(error));
  }

  /** POST a payslip as the page does, from this site's origin. */
  const post = async (payslip) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Origin: siteOrigin },
      body: JSON.stringify(payslip),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let answer = null;
    try {
      answer = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { response, text, answer, code: typeof answer?.error?.code === "string" ? answer.error.code : undefined };
  };
  const refused = ({ response, code }) =>
    response.status === 400 && code === "network_not_configured" ? `verifier is not serving ${slip.network} (HTTP 400 ${code})` : `HTTP ${String(response.status)}${code === undefined ? "" : ` ${code}`}`;

  const realWhat = "the verifier checks the real batch's payslip";
  let answered = false;
  try {
    const real = await post(slip);
    const { answer } = real;
    const verdict = answer?.verdict;
    answered = real.response.status === 200 && answer !== null;
    const good = answered && (verdict === "verified" || verdict === "pending") && answer.txid === slip.txid && Array.isArray(answer.not_proven) && answer.not_proven.length > 0;
    // The answer is about the transaction. It must not give back what the payslip names.
    const echoes = [slip.receiver, slip.rseed].some((secret) => real.text.includes(secret));
    const allowed = real.response.headers.get("access-control-allow-origin");
    if (!answered) report(false, realWhat, refused(real));
    else if (!good) report(false, realWhat, `verdict ${String(verdict)}${typeof answer.reason === "string" ? ` ${answer.reason}` : ""}`);
    else if (echoes) report(false, realWhat, "the answer repeats something the payslip names");
    else if (allowed !== siteOrigin && allowed !== "*") report(false, realWhat, `no access-control-allow-origin for this site (${allowed ?? "none"})`);
    else report(true, realWhat, `${verdict}, ${String(answer.confirmations)} confirmation(s), final at ${String(answer.required_depth)}`);
  } catch (error) {
    report(false, realWhat, reason(error));
  }

  // The same payslip with the amount one zatoshi higher must not verify, or the check proves nothing.
  if (answered) {
    const changedWhat = "the verifier refuses the same payslip with the amount changed";
    try {
      const changed = await post({ ...slip, value: String(BigInt(slip.value) + 1n) });
      const ok = changed.response.status === 200 && changed.answer?.verdict === "invalid" && changed.answer?.reason === "does_not_match";
      report(ok, changedWhat, ok ? "invalid, does_not_match" : changed.response.status === 200 ? `verdict ${String(changed.answer?.verdict)}` : refused(changed));
    } catch (error) {
      report(false, changedWhat, reason(error));
    }
  }
}

console.log(`\nshareable link: ${site}/r/real-8?${query.toString()}`);
if (failed) {
  console.error("\nAt least one check failed.");
  process.exit(1);
}
