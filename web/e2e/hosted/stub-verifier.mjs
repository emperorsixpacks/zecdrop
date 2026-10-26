// A stand-in for the hosted verifier, for the browser test of the hosted build
// only. It answers /v1/health, answers /v1/receipt with the real 8-output batch's
// receipt (from the fixture) and, like the real one, lets exactly one origin read
// it (CORS). /__calls lists what it was asked, so the test can see what the page
// called.

import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PORT = Number(process.env["STUB_PORT"] ?? "4175");
const ALLOWED_ORIGIN = process.env["STUB_ALLOWED_ORIGIN"] ?? "http://127.0.0.1:4174";

const root = resolve(process.cwd(), "..", "fixtures", "testnet-ironwood-batch-8");
const [dir] = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[0-9a-f]{64}$/u.test(e.name));
const receipt = readFileSync(join(root, dir.name, "receipt.json"), "utf8");

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
  if (url.pathname === "/v1/health") {
    response.writeHead(200, headers);
    response.end('{"ok":true}');
  } else if (url.pathname === "/v1/receipt") {
    response.writeHead(200, headers);
    response.end(receipt);
  } else {
    response.writeHead(404, headers);
    response.end('{"error":{"code":"not_found","message":"no such route"}}');
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`stub verifier on http://127.0.0.1:${String(PORT)}`);
});
