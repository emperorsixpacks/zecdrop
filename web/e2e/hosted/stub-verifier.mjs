// A stand-in for the hosted verifier, for the browser test of the hosted build
// only. It answers /v1/health, answers /v1/receipt with the real 8-output batch's
// receipt (from the fixture), as a mainnet receipt when the request says
// network=mainnet, answers POST /v1/payslip (and the preflight a browser sends before it),
// and, like the real one, lets exactly one origin read it (CORS).
// /__calls lists what it was asked, so the test can see what the page called: the method,
// the path, the query and the origin, and never a body (a payslip names a receiver and an amount).

import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PORT = Number(process.env["STUB_PORT"] ?? "4175");
const ALLOWED_ORIGIN = process.env["STUB_ALLOWED_ORIGIN"] ?? "http://127.0.0.1:4174";

const root = resolve(process.cwd(), "..", "fixtures", "testnet-ironwood-batch-8");
const [dir] = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[0-9a-f]{64}$/u.test(e.name));
const receipt = readFileSync(join(root, dir.name, "receipt.json"), "utf8");

// The same receipt for a mainnet request: only what depends on the network is changed, which is the
// network and the funding address in its mainnet form (the key hash of the fixture's testnet address
// under the mainnet prefix, a valid t1 address that nobody is asked to pay). The ids and figures stay
// the fixture's, so a link made from it checks out; this is a stub, not a chain.
const MAINNET_FUNDING_ADDRESS = "t1cFrgk2qsbNHgNSmV8DNauWTCe6EKRLW9L";
const mainnetReceipt = JSON.stringify({ ...JSON.parse(receipt), network: "mainnet", funding_address: MAINNET_FUNDING_ADDRESS });

// Payslip 3 of the same batch, the one the page's "Load a sample" holds. The stub says "verified" for exactly
// this payslip and "invalid" for any other that is shaped like one. The sentences are the verifier's NOT_PROVEN
// (crates/drop-verify/src/payslip.rs); the browser test compares them with the page's own copy of the list.
const payslip = JSON.parse(readFileSync(join(root, dir.name, "payslips", "payslip-3.json"), "utf8"));
const PAYSLIP_FIELDS = ["version", "network", "txid", "action", "receiver", "value", "rseed"];
const NOT_PROVEN = [
  "Who the recipient is, or that whoever presents the payslip controls the receiver. A payslip is a bearer document: anyone who holds it can present it.",
  "The memo. The note commitment does not cover it.",
  "That the transaction is mined or final. That needs the chain: see the confirmations.",
  "That the funds are unspent, or that the transaction belongs to a given campaign. Compare its id with the campaign's public receipt.",
  "Anything about any other output of the transaction.",
];
const MAX_PAYSLIP_BODY = 1024;

/** The answer to a request body, or null when it is not a payslip (the verifier's 400). Nothing is kept or logged. */
function payslipAnswer(text) {
  let slip;
  try {
    slip = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof slip !== "object" || slip === null || Array.isArray(slip)) return null;
  const names = Object.keys(slip);
  if (names.length !== PAYSLIP_FIELDS.length || !PAYSLIP_FIELDS.every((name) => names.includes(name))) return null;
  const exact = PAYSLIP_FIELDS.every((name) => slip[name] === payslip[name]);
  return {
    network: slip.network,
    txid: slip.txid,
    action: slip.action,
    verdict: exact ? "verified" : "invalid",
    reason: exact ? null : "does_not_match",
    confirmations: exact ? 19 : null,
    required_depth: 3,
    ironwood_actions: exact ? 8 : null,
    not_proven: NOT_PROVEN,
  };
}

const calls = [];

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://stub");
  const origin = request.headers["origin"];
  if (url.pathname === "/__calls") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(calls));
    return;
  }
  calls.push({ method: request.method, path: url.pathname, search: url.search, origin: origin ?? null });
  const headers = { "Content-Type": "application/json" };
  if (origin === ALLOWED_ORIGIN) headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  if (url.pathname === "/v1/payslip") {
    if (request.method === "OPTIONS") {
      // The browser's preflight for a JSON POST, with the real verifier's rules: POST and content-type, one origin.
      response.writeHead(204, { ...headers, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "content-type", "Access-Control-Max-Age": "600" });
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, headers);
      response.end('{"error":{"code":"method_not_allowed","message":"a payslip is checked with POST"}}');
      return;
    }
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_PAYSLIP_BODY) chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > MAX_PAYSLIP_BODY) {
        response.writeHead(413, headers);
        response.end('{"error":{"code":"payload_too_large","message":"a payslip is at most 1 KiB"}}');
        return;
      }
      const answer = payslipAnswer(Buffer.concat(chunks).toString("utf8"));
      if (answer === null) {
        response.writeHead(400, headers);
        response.end('{"error":{"code":"invalid_payslip","message":"the body is not a payslip this service reads"}}');
        return;
      }
      response.writeHead(200, headers);
      response.end(JSON.stringify(answer));
    });
  } else if (url.pathname === "/v1/health") {
    response.writeHead(200, headers);
    response.end('{"ok":true}');
  } else if (url.pathname === "/v1/receipt") {
    response.writeHead(200, headers);
    response.end(url.searchParams.get("network") === "mainnet" ? mainnetReceipt : receipt);
  } else {
    response.writeHead(404, headers);
    response.end('{"error":{"code":"not_found","message":"no such route"}}');
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`stub verifier on http://127.0.0.1:${String(PORT)}`);
});
