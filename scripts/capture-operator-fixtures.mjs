#!/usr/bin/env node
// Capture REAL responses from the operator API as contract fixtures.
//
//   node scripts/capture-operator-fixtures.mjs            # (re)write fixtures
//   node scripts/capture-operator-fixtures.mjs --check    # regenerate in a temp
//                                                         # dir and diff; exit 1
//                                                         # if the committed
//                                                         # fixtures are stale
//   --bin <path>   operator binary (default: target/debug/drop-operator)
//   --out <dir>    output dir (default: fixtures/contract/operator)
//
// It starts `drop-operator --mock-chain` on a random loopback port with a
// temporary encrypted database and a random passphrase, drives the API with
// SENTINEL data (fake addresses, amounts and memos), and saves what the server
// actually answered. The web app's schemas are built from these files and the
// web tests parse every one of them, so a change on the Rust side that the
// schemas do not know about fails the web tests instead of surprising a user.
//
// The bearer token is never written to disk. Needs Node 20+ and no packages.
//
// WHAT VARIES BETWEEN RUNS, AND HOW IT IS NORMALISED (so reruns are identical):
//   campaign ids   random `c-<12 hex>`          -> c-000000000001, 02, ... in order
//   txids          random (hash of tx bytes)    -> a0a0..a0, a1a1..a1, ... in order
//   commitments    salted, random per campaign  -> e0e0..e0, e1e1..e1, ... in order
//   created_at     wall clock                   -> 1700000000 + (campaign number - 1)
//   list order     same-second ties are arbitrary -> list responses sorted by id
// "In order" means order of first appearance across the whole run, which is
// fixed by the order of the requests below. The funding txid is chosen by this
// script, so it is left as is. Everything else is the server's own output.
//
// NOT CAPTURABLE WITH THE MOCK CHAIN (taken from the Rust source instead, and
// marked as such in the web tests): run states `halted` and `stalled`, batch
// state `failed`, and the real-chain 403 `dev_only` answer.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BIN = resolve(option("--bin", join(ROOT, "target/debug/drop-operator")));
/** Written by the operator's Rust tests, not by this script. Never cleared, never compared. */
const GOLDEN_DIR = "golden";
const COMMITTED = resolve(option("--out", join(ROOT, "fixtures/contract/operator")));
const CHECK = flag("--check");

// ---------------------------------------------------------------------------
// Sentinel inputs. All fake. Amounts are chosen so that no single amount equals
// a batch total, so a leak of one cannot hide inside the other.
// ---------------------------------------------------------------------------

const HEADER = "address,amount,memo";
const row = (address, amount, memo = "") => `${address},${amount},${memo}`;
const csv = (...lines) => `${lines.join("\n")}\n`;

const CSVS = {
  // 5 recipients, varied amounts. With 3 per batch: batches of 3 and 2, so the
  // two-recipient warning fires for batch 1.
  "valid.csv": csv(
    HEADER,
    row("u1sentineladdressaaaaaaaaaaaaaaaaaaaa", "1.5", "memo-sentinel-one"),
    row("u1sentineladdressbbbbbbbbbbbbbbbbbbbb", "2.25", "memo-sentinel-two"),
    row("u1sentineladdresscccccccccccccccccccc", "0.75"),
    row("zs1sentineladdressdddddddddddddddddddd", "3", "memo-sentinel-four"),
    row("u1sentineladdresseeeeeeeeeeeeeeeeeeee", "4.125"),
  ),
  // Equal amounts: uniform-batch and two-recipient warnings.
  "uniform.csv": csv(
    HEADER,
    ...[1, 2, 3, 4, 5].map((n) => row(`u1sentineluniform${String(n).padStart(4, "0")}xxxxxxxxxx`, "2", `uniform-memo-${n}`)),
  ),
  // One recipient: the singleton-campaign warning.
  "single.csv": csv(HEADER, row("u1sentinelsingleaddressxxxxxxxxxxxx", "7.777", "single-memo-sentinel")),
  // Three recipients: the small-campaign warning.
  "small.csv": csv(
    HEADER,
    row("u1sentinelsmallaaaaaaaaaaaaaaaaaaaa", "1.1"),
    row("u1sentinelsmallbbbbbbbbbbbbbbbbbbbb", "2.3"),
    row("u1sentinelsmallcccccccccccccccccccc", "5.9"),
  ),
  // Many different row errors on known lines. Line 1 is the header.
  "row-errors.csv": csv(
    HEADER, //                                                       1
    row("u1sentinelrowokaaaaaaaaaaaaaaaaaaaa", "1.5", "ok-memo-sentinel"), // 2 ok
    row("u1sentinel!badchar", "1.0"), //                                  3 malformed address
    row("", "2.0"), //                                                    4 empty address
    row("x1sentinelunknownprefixxxxxxxx", "1.0"), //                      5 unknown prefix
    row("t1sentineltransparentaddressxxxxxx", "1.0"), //                  6 transparent not allowed
    row("u1sentinelbadamountaaaaaaaaaaaaaaaa", "abc"), //                 7 invalid character
    row("u1sentinelnegativeaaaaaaaaaaaaaaaaaa", "-1"), //                 8 negative
    row("u1sentinelscientificaaaaaaaaaaaaaaaa", "1e3"), //                9 scientific notation
    row("u1sentineldecimalsaaaaaaaaaaaaaaaaaa", "0.123456789"), //        10 too many decimals
    row("u1sentinelzeroaaaaaaaaaaaaaaaaaaaaaa", "0"), //                  11 zero
    row("u1sentinelrowokaaaaaaaaaaaaaaaaaaaa", "2.0"), //                 12 duplicate of line 2
    "u1sentinelfieldcountaaaaaaaaaaaaaaaa,1.0,memo,extra-cell", //        13 field count
    row("u1sentinelmaxmoneyaaaaaaaaaaaaaaaaaa", "21000001"), //           14 exceeds max money
    row("u1sentinelmalformedaaaaaaaaaaaaaaaa", "1.", "decimal-memo"), //  15 malformed decimal
    row("u1sentinelmemolongaaaaaaaaaaaaaaaaaa", "1.0", "m".repeat(513)), // 16 memo too long
    row("u1sentinelemptyamountaaaaaaaaaaaaaa", ""), //                      17 empty amount
  ),
  // A quote in the middle of an unquoted field.
  "malformed-quote.csv": csv(HEADER, row('u1sentinelq"uotedaddressaaaaaaaaaa', "1.0")),
  // An unterminated quote swallows the rest of the file.
  "quote-error.csv": csv(HEADER, row("u1sentinelquoteokaaaaaaaaaaaaaaaaaa", "1.0"), `"u1sentinelunterminatedaaaaaaaaaa,2.0,memo`),
  // Header problems, one per file.
  "header-missing.csv": csv(row("u1sentinelnoheaderaaaaaaaaaaaaaaaa", "1.0")),
  "header-unknown-column.csv": csv("address,amount,note", "u1sentinelunknowncolaaaaaaaaaaaaaaaa,1.0,hello"),
  "header-missing-column.csv": csv("address,memo", "u1sentinelmissingcolaaaaaaaaaaaaaaaa,hello"),
  "header-duplicate-column.csv": csv("address,amount,amount", "u1sentineldupcolaaaaaaaaaaaaaaaaaa,1.0,2.0"),
};

const FUNDING_TXID = "cd".repeat(32);

// ---------------------------------------------------------------------------
// Normalisation (see the header comment).
// ---------------------------------------------------------------------------

class Normaliser {
  constructor() {
    this.ids = new Map();
    this.txids = new Map();
    this.commitments = new Map();
  }

  #fake(map, key, make) {
    if (!map.has(key)) map.set(key, make(map.size));
    return map.get(key);
  }

  id(real) {
    return this.#fake(this.ids, real, (n) => `c-${String(n + 1).padStart(12, "0")}`);
  }

  txid(real) {
    if (real === FUNDING_TXID) return real;
    return this.#fake(this.txids, real, (n) => (0xa0 + n).toString(16).padStart(2, "0").repeat(32));
  }

  commitment(real) {
    return this.#fake(this.commitments, real, (n) => (0xe0 + n).toString(16).padStart(2, "0").repeat(32));
  }

  /** Replaces ids and txids inside free text (SSE transcripts). */
  text(raw) {
    return raw
      .replace(/c-[0-9a-f]{12}/gu, (m) => this.id(m))
      .replace(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gu, (m) => this.txid(m));
  }

  /** Walks parsed JSON. `key` is the property name the value sits under. */
  json(value, key = "") {
    if (Array.isArray(value)) {
      const items = value.map((v) => this.json(v, key));
      // A list of campaigns: same-second ties come back in arbitrary order.
      if (items.length > 1 && items.every((i) => i && typeof i === "object" && typeof i.id === "string")) {
        items.sort((a, b) => a.id.localeCompare(b.id));
      }
      return items;
    }
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.json(v, k);
      // created_at is wall-clock time: derive it from the campaign's own number
      // so it never depends on which second a request happened to land in.
      if (typeof value.id === "string" && typeof value.created_at === "number") {
        out.created_at = 1_700_000_000 + (Number(out.id.slice(2)) - 1);
      }
      return out;
    }
    if (typeof value === "string") {
      if (key === "manifest_commitment") return this.commitment(value);
      return this.text(value);
    }
    return value;
  }
}

// ---------------------------------------------------------------------------
// Running the real binary.
// ---------------------------------------------------------------------------

async function startOperator(label, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), `zecdrop-capture-${label}-`));
  const emptyWebDir = join(dir, "web");
  mkdirSync(emptyWebDir);
  // The binary rejects a repeated flag, so a default applies only if the caller
  // did not set that flag.
  const pollDefault = extraArgs.includes("--poll-interval-ms") ? [] : ["--poll-interval-ms", "40"];
  const child = spawn(
    BIN,
    ["--mock-chain", "--bind", "127.0.0.1:0", "--db", join(dir, "store.sqlite"), "--state-dir", join(dir, "state"), "--web-dir", emptyWebDir, ...pollDefault, ...extraArgs],
    {
      env: { PATH: process.env.PATH ?? "", ZECDROP_PASSPHRASE: randomBytes(24).toString("hex") },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const link = await new Promise((resolveLink, reject) => {
    const timer = setTimeout(() => reject(new Error(`operator did not print its link within 30s\nstderr: ${stderr}`)), 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /open:\s+(http:\/\/127\.0\.0\.1:\d+)\/#token=([0-9a-f]{64})/u.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolveLink({ base: match[1], token: match[2] });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`operator exited early (code ${String(code)})\nstderr: ${stderr}`));
    });
  });

  const stop = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => {
        const force = setTimeout(() => child.kill("SIGKILL"), 3000);
        child.once("exit", () => {
          clearTimeout(force);
          r();
        });
      });
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return { ...link, stop };
}

// ---------------------------------------------------------------------------
// Capturing.
// ---------------------------------------------------------------------------

function pretty(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main() {
  if (!existsSync(BIN)) {
    throw new Error(`operator binary not found: ${BIN}\nBuild it first: cargo build -p drop-operator`);
  }
  const out = CHECK ? mkdtempSync(join(tmpdir(), "zecdrop-fixtures-check-")) : COMMITTED;
  // Clear what this script wrote before, but NOT golden/: those files are written
  // by the operator's own Rust test (crates/drop-operator/tests/api_contract.rs).
  if (existsSync(out)) {
    for (const entry of readdirSync(out)) {
      if (entry !== GOLDEN_DIR) rmSync(join(out, entry), { recursive: true, force: true });
    }
  }
  mkdirSync(join(out, "csv"), { recursive: true });
  for (const [name, text] of Object.entries(CSVS)) writeFileSync(join(out, "csv", name), text);

  const norm = new Normaliser();
  const index = [];
  let session = null; // { base, token }

  /** One request. Returns { status, body (raw, un-normalised) }. */
  async function call(method, path, { body, token = session.token, headers = {}, rawBody } = {}) {
    const init = { method, headers: { ...headers } };
    if (token) init.headers.Authorization = `Bearer ${token}`;
    if (rawBody !== undefined) init.body = rawBody;
    else if (body !== undefined) {
      init.headers["Content-Type"] ??= "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${session.base}${path}`, init);
    const text = await response.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON: keep the text */
    }
    return { status: response.status, body: parsed };
  }

  /** Capture and record one request under `file` (without extension). */
  async function capture(file, method, pathTemplate, options = {}, note = "", request = undefined) {
    const path = pathTemplate.replace(/\{id\}/u, options.id ?? "").replace(/\{id2\}/u, options.id2 ?? "");
    const { status, body } = await call(method, path, options);
    const normalised = norm.json(body);
    writeFileSync(join(out, `${file}.json`), pretty(normalised));
    index.push({ file: `${file}.json`, method, path: pathTemplate.replace("{id2}", "{id}"), status, note, ...(request ? { request } : {}) });
    return { status, body, normalised };
  }

  const create = (file, csvName, extra = {}, note = "") =>
    capture(
      file,
      "POST",
      "/api/campaigns",
      { body: { name: extra.name ?? "Sentinel campaign", csv: CSVS[csvName], max_outputs_per_batch: extra.batch ?? 3, fee_policy: extra.fee ?? "zip317_text" } },
      note,
      { csv: `csv/${csvName}`, name: extra.name ?? "Sentinel campaign", max_outputs_per_batch: extra.batch ?? 3, fee_policy: extra.fee ?? "zip317_text" },
    );

  /** Read an SSE stream into text until it closes or `stopWhen` says enough. */
  async function sse(path, { stopWhen, timeoutMs = 30_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let text = "";
    try {
      const response = await fetch(`${session.base}${path}`, {
        headers: { Authorization: `Bearer ${session.token}`, Accept: "text/event-stream" },
        signal: controller.signal,
      });
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        text += decoder.decode(chunk, { stream: true });
        if (stopWhen?.(text)) break;
      }
    } catch (error) {
      if (error?.name !== "AbortError") throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    return text;
  }

  const waitFor = async (predicate, what, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  const OUTPOINT = (vout = 0) => `${FUNDING_TXID}:${vout}`;

  // ===================== operator 1: a fast mock chain =======================
  const fast = await startOperator("fast");
  session = fast;
  try {
    // ---- before any campaign exists -----------------------------------------
    await capture("health", "GET", "/api/health", { token: null }, "no token needed");
    await capture("unauthorized-no-token", "GET", "/api/campaigns", { token: null }, "no Authorization header");
    await capture("unauthorized-wrong-token", "GET", "/api/campaigns", { token: "0".repeat(64) }, "a token that is not this run's");
    await capture("route-not-found", "GET", "/api/nope", {}, "an unknown API route, with a valid token");
    await capture("campaigns-empty", "GET", "/api/campaigns", {}, "no campaigns yet");

    // ---- creating campaigns (the happy paths) --------------------------------
    const valid = await create("create-valid", "valid.csv", {}, "5 recipients in batches of 3 and 2: a two-recipient-batch warning");
    const id = valid.body.id;
    await create("create-zebra-fee", "valid.csv", { fee: "zebra_main", name: "Lower fee campaign" }, "same recipients, the 1,000-per-action fee policy");
    await create("create-uniform", "uniform.csv", { name: "Equal amounts" }, "equal amounts: uniform-batch and two-recipient warnings");
    await create("create-single", "single.csv", { name: "One recipient", batch: 10 }, "a single recipient: singleton-campaign warning");
    await create("create-small", "small.csv", { name: "Three recipients", batch: 10 }, "three recipients: small-campaign warning");

    // ---- creating campaigns (the failures) ----------------------------------
    await create("create-row-errors", "row-errors.csv", {}, "every kind of row error, with line numbers; no value is echoed");
    await create("create-quote-error", "quote-error.csv", {}, "an unterminated quote swallows the rest of the file");
    await create("create-malformed-quote", "malformed-quote.csv", {}, "a quote in the middle of an unquoted field");
    await create("create-header-missing", "header-missing.csv", {}, "no header row");
    await create("create-header-unknown-column", "header-unknown-column.csv", {}, "a header cell that is not address, amount or memo");
    await create("create-header-missing-column", "header-missing-column.csv", {}, "no amount column");
    await create("create-header-duplicate-column", "header-duplicate-column.csv", {}, "a repeated column");
    await capture("create-invalid-name", "POST", "/api/campaigns", { body: { name: "   ", csv: CSVS["valid.csv"], max_outputs_per_batch: 3, fee_policy: "zip317_text" } }, "a blank campaign name");
    await capture("create-plan-failed", "POST", "/api/campaigns", { body: { name: "Bad batch size", csv: CSVS["valid.csv"], max_outputs_per_batch: 0, fee_policy: "zip317_text" } }, "a batch size the planner refuses");
    await capture("create-unknown-field", "POST", "/api/campaigns", { body: { name: "x", csv: CSVS["valid.csv"], max_outputs_per_batch: 3, fee_policy: "zip317_text", extra: 1 } }, "an unexpected field in the body");
    await capture("create-bad-fee-policy", "POST", "/api/campaigns", { body: { name: "x", csv: CSVS["valid.csv"], max_outputs_per_batch: 3, fee_policy: "free" } }, "an unknown fee policy");
    await capture("create-not-json", "POST", "/api/campaigns", { rawBody: "{", headers: { "Content-Type": "application/json" } }, "a body that is not JSON");
    await capture("create-wrong-media-type", "POST", "/api/campaigns", { rawBody: "name=x", headers: { "Content-Type": "text/plain" } }, "not sent as application/json");

    // ---- reading one campaign, and what is not there yet ---------------------
    await capture("campaigns-list", "GET", "/api/campaigns", {}, "all campaigns created so far");
    await capture("campaign-awaiting-funding", "GET", "/api/campaigns/{id}", { id }, "a campaign that has not been funded");
    await capture("campaign-not-found", "GET", "/api/campaigns/{id}", { id: "c-000000000000" }, "an id that does not exist");
    await capture("campaign-bad-id", "GET", "/api/campaigns/{id}", { id: "bad%20id" }, "an id that is not even well-formed");
    await capture("receipt-not-funded", "GET", "/api/campaigns/{id}/receipt", { id }, "the receipt needs funding first");
    await capture("start-not-funded", "POST", "/api/campaigns/{id}/start", { id }, "cannot start before funding");

    // ---- funding (mock chain only) -------------------------------------------
    const required = valid.body.funding_required;
    await capture("check-funding-mock", "POST", "/api/campaigns/{id}/check-funding", { id }, "the mock chain has no funding address to look at (a real chain answers with the campaign)");
    await capture("export-ufvk-mock", "GET", "/api/campaigns/{id}/audit-ufvk-export", { id, headers: { "X-Zecdrop-Confirm-Disclosure": "I-UNDERSTAND" } }, "the mock chain has no real viewing keys (a real chain answers with warning, campaign_id, network, ufvk)");
    await capture("export-ufvk-mock-unconfirmed", "GET", "/api/campaigns/{id}/audit-ufvk-export", { id }, "without the disclosure header; the mock chain answers not_available first (a real chain answers 400 confirmation_required)");
    await capture("payslips-mock", "GET", "/api/campaigns/{id}/payslips", { id, headers: { "X-Zecdrop-Confirm-Disclosure": "I-UNDERSTAND" } }, "the mock chain has no real transactions to prove (a settled campaign on a real chain answers with warning, campaign_id, network, payslips, unmatched_outputs)");
    await capture("fund-insufficient", "POST", "/api/campaigns/{id}/fund-observed", { id, body: { outpoint: OUTPOINT(0), amount: "1000" } }, "a deposit that is too small; reports required and observed");
    await capture("fund-invalid-body", "POST", "/api/campaigns/{id}/fund-observed", { id, body: { outpoint: "not-an-outpoint", amount: required } }, "a malformed outpoint");
    await capture("fund-ok", "POST", "/api/campaigns/{id}/fund-observed", { id, body: { outpoint: OUTPOINT(0), amount: required } }, "enough funding: the campaign becomes funded");
    await capture("fund-same-again", "POST", "/api/campaigns/{id}/fund-observed", { id, body: { outpoint: OUTPOINT(0), amount: required } }, "the same deposit again is accepted unchanged");
    await capture("fund-conflict", "POST", "/api/campaigns/{id}/fund-observed", { id, body: { outpoint: OUTPOINT(1), amount: required } }, "a different deposit for an already funded campaign");
    await capture("fund-campaign-not-found", "POST", "/api/campaigns/{id}/fund-observed", { id: "c-000000000000", body: { outpoint: OUTPOINT(0), amount: "1" } }, "funding a campaign that does not exist (a real chain answers 403 dev_only before looking)");
    await capture("campaign-funded", "GET", "/api/campaigns/{id}", { id }, "funded, not started");
    await capture("receipt-funded", "GET", "/api/campaigns/{id}/receipt", { id }, "the operator-built receipt before any batch is built");

    // ---- running -------------------------------------------------------------
    const first = await capture("start-ok", "POST", "/api/campaigns/{id}/start", { id }, "starts the engine in the background");
    const second = await capture("start-again", "POST", "/api/campaigns/{id}/start", { id }, "starting a run that is already running does nothing");
    if (first.body.started !== true) throw new Error("expected the first start to start a run");
    if (second.body.started !== false) console.warn("note: the run finished before the second start; start-again may differ from run to run");

    const transcript = await sse(`/api/campaigns/${id}/events`, {});
    writeFileSync(join(out, "events-settled.sse.txt"), norm.text(transcript));
    index.push({ file: "events-settled.sse.txt", method: "GET", path: "/api/campaigns/{id}/events", status: 200, note: "the full event stream of a run that settles, history first" });

    await waitFor(async () => (await call("GET", `/api/campaigns/${id}`)).body.run?.state === "settled", "the run to settle");
    await capture("campaign-settled", "GET", "/api/campaigns/{id}", { id }, "every batch confirmed at the required depth");
    await capture("receipt-settled", "GET", "/api/campaigns/{id}/receipt", { id }, "the operator-built receipt of a settled campaign");
    await capture("campaigns-list-after", "GET", "/api/campaigns", {}, "the list after one campaign has settled");

    // A pretend deposit that says what it spent: a real chain reads that from the deposit itself (REQ-FUND-004). Its own
    // txid, so the answers above, where nothing was declared, keep funding_source null.
    const declared = await call("POST", "/api/campaigns", { body: { name: "Declared source", csv: CSVS["valid.csv"], max_outputs_per_batch: 3, fee_policy: "zip317_text" } });
    await capture("fund-declared-source", "POST", "/api/campaigns/{id}/fund-observed", { id: declared.body.id, body: { outpoint: `${"5e".repeat(32)}:0`, amount: declared.body.funding_required, source: "shielded" } }, "a pretend deposit said to come from the shielded pool: funding_source is what fund-observed declares, and null when it says nothing");
    await capture("events-not-found", "GET", "/api/campaigns/{id}/events", { id: "c-000000000000" }, "events of a campaign that does not exist");
  } finally {
    await fast.stop();
  }

  // ===================== operator 2: a slow chain (a run in progress) =========
  const slow = await startOperator("slow", ["--poll-interval-ms", "1500", "--mock-confirm-after-polls", "4"]);
  session = slow;
  try {
    const made = await call("POST", "/api/campaigns", { body: { name: "In progress", csv: CSVS["valid.csv"], max_outputs_per_batch: 3, fee_policy: "zip317_text" } });
    const id = made.body.id;
    await call("POST", `/api/campaigns/${id}/fund-observed`, { body: { outpoint: OUTPOINT(0), amount: made.body.funding_required } });
    await call("POST", `/api/campaigns/${id}/start`, {});
    // Wait until both batches are broadcast and the engine is waiting on blocks.
    await sse(`/api/campaigns/${id}/events`, { stopWhen: (t) => t.includes('"event":"waiting"'), timeoutMs: 15_000 });
    await capture("campaign-running", "GET", "/api/campaigns/{id}", { id }, "a run in progress: batches broadcast, waiting for blocks");
    const partial = await sse(`/api/campaigns/${id}/events`, { stopWhen: (t) => t.includes('"event":"waiting"'), timeoutMs: 15_000 });
    writeFileSync(join(out, "events-running.sse.txt"), norm.text(partial));
    index.push({ file: "events-running.sse.txt", method: "GET", path: "/api/campaigns/{id}/events", status: 200, note: "a stream cut off while the run is still waiting for blocks" });
    await capture("receipt-running", "GET", "/api/campaigns/{id}/receipt", { id }, "the receipt of a campaign whose batches are broadcast but not confirmed");
  } finally {
    await slow.stop();
  }

  // ===================== operator 3: a run that crashes, then resumes ========
  const crashy = await startOperator("crash", ["--mock-crash-after-steps", "2"]);
  session = crashy;
  try {
    const made = await call("POST", "/api/campaigns", { body: { name: "Interrupted", csv: CSVS["valid.csv"], max_outputs_per_batch: 3, fee_policy: "zip317_text" } });
    const id = made.body.id;
    await call("POST", `/api/campaigns/${id}/fund-observed`, { body: { outpoint: OUTPOINT(0), amount: made.body.funding_required } });
    await call("POST", `/api/campaigns/${id}/start`, {});
    await waitFor(async () => (await call("GET", `/api/campaigns/${id}`)).body.run?.state === "crashed", "the simulated crash");
    await capture("campaign-crashed", "GET", "/api/campaigns/{id}", { id }, "the run stopped silently; start again to resume from the ledger");
    await capture("start-resume", "POST", "/api/campaigns/{id}/start", { id }, "starting again after a crash resumes");
  } finally {
    await crashy.stop();
  }

  index.sort((a, b) => a.file.localeCompare(b.file));
  writeFileSync(join(out, "index.json"), pretty({ generated_by: "scripts/capture-operator-fixtures.mjs", files: index }));
  writeFileSync(join(out, "README.md"), README);

  if (!CHECK) {
    console.log(`wrote ${String(index.length)} fixtures and ${String(Object.keys(CSVS).length)} CSVs to ${out}`);
    return;
  }

  // --check: compare the fresh capture with what is committed.
  const files = (dir) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath ?? e.path, e.name).slice(dir.length + 1))
      .filter((f) => !f.startsWith(`${GOLDEN_DIR}/`)) // not ours: see above
      .sort();
  const fresh = files(out);
  const have = existsSync(COMMITTED) ? files(COMMITTED) : [];
  const problems = [];
  for (const f of new Set([...fresh, ...have])) {
    if (!fresh.includes(f)) problems.push(`stale (no longer produced): ${f}`);
    else if (!have.includes(f)) problems.push(`missing: ${f}`);
    else if (readFileSync(join(out, f), "utf8") !== readFileSync(join(COMMITTED, f), "utf8")) problems.push(`differs: ${f}`);
  }
  rmSync(out, { recursive: true, force: true });
  if (problems.length > 0) {
    console.error(`fixtures are out of date:\n  ${problems.join("\n  ")}\nRegenerate with: node scripts/capture-operator-fixtures.mjs`);
    process.exit(1);
  }
  console.log(`fixtures are up to date (${String(fresh.length)} files)`);
}

const README = `# Operator API fixtures

Real responses from \`drop-operator --mock-chain\`, captured by
\`scripts/capture-operator-fixtures.mjs\`. Do not edit by hand: regenerate with

    cargo build -p drop-operator
    node scripts/capture-operator-fixtures.mjs          # rewrite
    node scripts/capture-operator-fixtures.mjs --check  # verify they are current

\`index.json\` lists every response file with its request and HTTP status.
\`csv/\` holds the SENTINEL inputs (fake addresses, amounts and memos). The web
tests parse every file here with strict schemas and assert that no sentinel
address, amount or memo appears in any response.

Random values are normalised so reruns are byte-identical: campaign ids
(\`c-000000000001\`, ...), txids (\`a0a0...\`, \`a1a1...\`) and manifest commitments
(\`e0e0...\`, ...), each in order of first appearance; \`created_at\` becomes
1700000000 + (campaign number - 1). List responses are sorted by id, because the
server returns campaigns created in the same second in arbitrary order. The
funding txid (\`cdcd...\`) is chosen by the script.

\`golden/\` is NOT written by this script. The operator's own Rust test
(\`crates/drop-operator/tests/api_contract.rs\`) writes it: the real handlers
answering for an in-memory real-chain backend, so it holds the shapes only a real
chain produces. No real node has been involved. This script leaves it alone.

Not capturable with the mock chain: the run states \`halted\` and \`stalled\` and
the batch state \`failed\` (taken from the Rust source), and everything only a real
chain produces, which is in \`golden/\`: a non-null \`funding_address\` and
\`funding_progress\`, \`wallet_matches: false\`, the answer of \`audit-ufvk-export\`
(\`warning\`, \`campaign_id\`, \`network\`, \`ufvk\`), and the errors
\`needs_funding_split\`, \`wrong_wallet_seed\`, \`chain_unavailable\`,
\`confirmation_required\` and \`dev_only\`. On the mock chain a campaign always has
\`wallet_matches: true\`, \`funding_address: null\` and \`funding_progress: null\`, and
\`funding_source\` is null unless \`fund-observed\` declared one (\`fund-declared-source.json\`).
None of these shapes has been seen from a real node.
`;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
