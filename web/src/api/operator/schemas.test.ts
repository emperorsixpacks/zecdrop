// Contract tests for the operator API. Every file in
// fixtures/contract/operator is a REAL response captured from the operator
// binary (scripts/capture-operator-fixtures.mjs); each is parsed here with its
// strict schema. Where the mock chain cannot produce a shape (halted/stalled
// runs, failed batches), the shape comes from the Rust source and is tested
// separately, marked as such.

import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { parsePublicReceipt } from "@/api/types";
import { warningMessage } from "@/api/warnings";
import { phaseSentence } from "@/lib/phase";
import { parseZec } from "@/lib/zec";
import { CSV, FIXTURES, fixtureJson, INDEX, type IndexEntry } from "@/test/operator-fixtures";
import { between } from "@/test/rust-source";
import operatorApiSource from "../../../../crates/drop-operator/src/api.rs?raw";
import operatorStateSource from "../../../../crates/drop-operator/src/state.rs?raw";

import {
  BATCH_STATES,
  isTerminalEvent,
  parseCampaign,
  parseCampaignList,
  parseHealth,
  parseOperatorError,
  parseProgressEvent,
  parseStartResponse,
  parseViewingKeyExport,
  type OperatorCampaign,
} from "./schemas";

type Json = Record<string, unknown>;

// ---- which schema parses which response ---------------------------------------

/** The parser for a successful (< 400) response, chosen by request. */
function parserFor(entry: IndexEntry): ((input: unknown) => unknown) | null {
  const { method, path } = entry;
  if (path.endsWith("/events")) return null; // text/event-stream, tested below
  if (method === "GET" && path === "/api/health") return parseHealth;
  if (method === "GET" && path === "/api/campaigns") return parseCampaignList;
  if (method === "POST" && path === "/api/campaigns") return parseCampaign;
  if (method === "GET" && path === "/api/campaigns/{id}") return parseCampaign;
  if (method === "GET" && path === "/api/campaigns/{id}/receipt") return parsePublicReceipt;
  if (method === "POST" && path === "/api/campaigns/{id}/fund-observed") return parseCampaign;
  if (method === "POST" && path === "/api/campaigns/{id}/start") return parseStartResponse;
  return undefined as never;
}

const responses = INDEX.filter((e) => e.file.endsWith(".json") && e.file !== "index.json");
const successes = responses.filter((e) => e.status < 400 && !e.path.endsWith("/events"));
const failures = responses.filter((e) => e.status >= 400);

// ---- completeness ----------------------------------------------------------------

describe("the fixture set", () => {
  it("lists exactly the files that are loaded (nothing captured but unchecked)", () => {
    const listed = INDEX.map((e) => e.file).sort();
    const loaded = Object.keys(FIXTURES).sort();
    expect(loaded).toEqual(listed);
  });

  it("has a parser rule for every successful response", () => {
    for (const entry of successes) {
      expect(parserFor(entry), `${entry.file} has no parser rule`).not.toBeUndefined();
    }
  });

  it("covers every status family the UI must handle", () => {
    const statuses = new Set(INDEX.map((e) => e.status));
    for (const status of [200, 201, 202, 400, 401, 404, 409, 415, 422]) {
      expect(statuses.has(status), `no fixture with HTTP ${String(status)}`).toBe(true);
    }
  });

  it("every create request names a CSV that exists", () => {
    for (const entry of INDEX) {
      if (entry.request) expect(CSV[entry.request.csv.replace("csv/", "")], entry.file).toBeDefined();
    }
  });
});

// ---- every real response parses ----------------------------------------------------

describe.each(successes.map((e) => [e.file, e] as const))("%s", (file, entry) => {
  it(`parses (HTTP ${String(entry.status)})`, () => {
    const parse = parserFor(entry);
    expect(parse).not.toBeNull();
    expect(() => parse?.(fixtureJson(file))).not.toThrow();
  });
});

describe.each(failures.map((e) => [e.file, e] as const))("%s", (file, entry) => {
  it(`parses as an error envelope (HTTP ${String(entry.status)})`, () => {
    const error = parseOperatorError(fixtureJson(file));
    expect(error.code.length).toBeGreaterThan(0);
    expect(error.message.length).toBeGreaterThan(0);
  });
});

// ---- what each error means (the contract the UI relies on) ---------------------------

describe("error codes and statuses", () => {
  const expected: Record<string, [status: number, code: string]> = {
    "unauthorized-no-token.json": [401, "unauthorized"],
    "unauthorized-wrong-token.json": [401, "unauthorized"],
    "route-not-found.json": [404, "not_found"],
    "campaign-not-found.json": [404, "not_found"],
    "campaign-bad-id.json": [404, "not_found"],
    "events-not-found.json": [404, "not_found"],
    "fund-campaign-not-found.json": [404, "not_found"],
    "create-invalid-name.json": [422, "invalid_name"],
    "create-plan-failed.json": [422, "plan_failed"],
    "create-unknown-field.json": [400, "invalid_body"],
    "create-bad-fee-policy.json": [400, "invalid_body"],
    "create-not-json.json": [400, "invalid_body"],
    "create-wrong-media-type.json": [415, "unsupported_media_type"],
    "create-row-errors.json": [422, "import_failed"],
    "create-quote-error.json": [422, "import_failed"],
    "create-malformed-quote.json": [422, "import_failed"],
    "create-header-missing.json": [422, "import_failed"],
    "create-header-unknown-column.json": [422, "import_failed"],
    "create-header-missing-column.json": [422, "import_failed"],
    "create-header-duplicate-column.json": [422, "import_failed"],
    "receipt-not-funded.json": [409, "not_funded"],
    "start-not-funded.json": [409, "not_funded"],
    "fund-insufficient.json": [422, "insufficient_funding"],
    "fund-invalid-body.json": [400, "invalid_body"],
    "fund-conflict.json": [409, "funding_conflict"],
    "check-funding-mock.json": [409, "not_applicable"],
    "export-ufvk-mock.json": [409, "not_available"],
    "export-ufvk-mock-unconfirmed.json": [409, "not_available"],
  };

  it("covers every failing fixture", () => {
    expect(Object.keys(expected).sort()).toEqual(failures.map((e) => e.file).sort());
  });

  it.each(Object.entries(expected))("%s", (file, [status, code]) => {
    const entry = INDEX.find((e) => e.file === file);
    expect(entry?.status).toBe(status);
    expect(parseOperatorError(fixtureJson(file)).code).toBe(code);
  });

  it("insufficient funding reports what was needed and what was seen", () => {
    const error = parseOperatorError(fixtureJson("fund-insufficient.json"));
    expect(error).toMatchObject({ code: "insufficient_funding", observed: "1000" });
    expect("required" in error && error.required).toBe("1162535000");
  });

  it("a funding conflict reports the deposit already recorded", () => {
    const error = parseOperatorError(fixtureJson("fund-conflict.json"));
    expect(error).toMatchObject({
      code: "funding_conflict",
      recorded: { amount: "1162535000", outpoint: { vout: 0 } },
    });
  });

  it("an insufficient_funding answer WITHOUT details (the 409 from receipt/start) still parses", () => {
    expect(
      parseOperatorError({
        error: { code: "insufficient_funding", message: "the recorded deposit does not cover this plan" },
      }),
    ).toEqual({ code: "insufficient_funding", message: "the recorded deposit does not cover this plan" });
  });
});

// ---- CSV import errors ----------------------------------------------------------------

describe("import errors", () => {
  const importError = (file: string) => {
    const error = parseOperatorError(fixtureJson(file));
    if (error.code !== "import_failed" || !("errors" in error)) throw new Error("not an import error");
    return error;
  };

  it("report each problem with its 1-based line and kind", () => {
    const error = importError("create-row-errors.json");
    expect(error.errorCount).toBe(15);
    expect(error.errors).toHaveLength(15);
    expect(error.errors.map((e) => [e.line, e.code])).toEqual([
      [3, "invalid_address"],
      [4, "missing_address"],
      [5, "invalid_address"],
      [6, "invalid_address"],
      [7, "invalid_amount"],
      [8, "invalid_amount"],
      [9, "invalid_amount"],
      [10, "invalid_amount"],
      [11, "zero_amount"],
      [12, "duplicate_address"],
      [13, "field_count"],
      [14, "invalid_amount"],
      [15, "invalid_amount"],
      [16, "memo_too_long"],
      [17, "invalid_amount"],
    ]);
  });

  it("a duplicate points at the first occurrence", () => {
    const duplicate = importError("create-row-errors.json").errors.find((e) => e.code === "duplicate_address");
    expect(duplicate?.firstLine).toBe(2);
  });

  it("lines are strictly increasing, so they can be shown in order", () => {
    const lines = importError("create-row-errors.json").errors.map((e) => e.line);
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
  });

  it.each([
    ["create-header-missing.json", "missing_header", 1],
    ["create-header-unknown-column.json", "unknown_column", 1],
    ["create-header-missing-column.json", "missing_column", 1],
    ["create-header-duplicate-column.json", "duplicate_column", 1],
    ["create-quote-error.json", "unterminated_quote", 3],
    ["create-malformed-quote.json", "malformed_quote", 2],
  ])("%s reports %s on line %i", (file, code, line) => {
    const [only, ...rest] = importError(file).errors;
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ code, line });
  });

  // covers: REQ-PRIV-002
  it("no error message echoes any value from the CSV", () => {
    for (const file of failures.map((e) => e.file)) {
      const text = FIXTURES[file] ?? "";
      for (const secret of SENTINELS.addresses) expect(text.toLowerCase(), file).not.toContain(secret);
      for (const secret of SENTINELS.memos) expect(text, file).not.toContain(secret);
    }
  });
});

// ---- campaigns ------------------------------------------------------------------------

const campaignFiles = successes
  .filter((e) => parserFor(e) === parseCampaign)
  .map((e) => e.file);

describe.each(campaignFiles)("campaign %s", (file) => {
  const raw = fixtureJson(file) as Json;
  const campaign: OperatorCampaign = parseCampaign(raw);

  it("adds up: totals, fees, funding, counts", () => {
    const sum = (pick: (b: OperatorCampaign["batches"][number]) => string) =>
      campaign.batches.reduce((total, b) => total + BigInt(pick(b)), 0n);
    expect(sum((b) => b.total).toString()).toBe(campaign.declaredTotal);
    expect(sum((b) => b.fee).toString()).toBe(campaign.feeTotal);
    expect((BigInt(campaign.declaredTotal) + BigInt(campaign.feeTotal)).toString()).toBe(campaign.fundingRequired);
    expect(campaign.batches.reduce((n, b) => n + b.recipients, 0)).toBe(campaign.recipientCount);
    expect(campaign.batches).toHaveLength(campaign.batchCount);
    campaign.batches.forEach((b, i) => {
      expect(b.index).toBe(i);
      expect((BigInt(b.total) + BigInt(b.fee)).toString()).toBe(b.fundingRequired);
    });
  });

  it("the server's status sentence is the one the web renders from the phase", () => {
    expect(raw["phase_label"]).toBe(phaseSentence(campaign.phase));
  });

  it("each warning's sentence is the one the web renders from its code", () => {
    const sentences = (raw["warnings"] as { message: string }[]).map((w) => w.message);
    expect(campaign.warnings.map(warningMessage)).toEqual(sentences);
  });

  it("only built batches have a txid, and only confirmed ones confirmations", () => {
    for (const b of campaign.batches) {
      expect(b.txid === null, `batch ${String(b.index)} ${b.state}`).toBe(b.state === "planned");
      if (b.state !== "confirmed") expect(b.confirmations).toBe(0);
    }
  });

  it("a funded campaign records its deposit", () => {
    expect(campaign.funding === null).toBe(campaign.phase.phase === "awaiting_funding" || campaign.phase.phase === "draft");
  });
});

describe("what each campaign fixture shows", () => {
  const load = (file: string) => parseCampaign(fixtureJson(file));

  it("awaiting funding: idle, planned batches, a warning about the two-recipient batch", () => {
    const c = load("campaign-awaiting-funding.json");
    expect(c.phase).toEqual({ phase: "awaiting_funding" });
    expect(c.run).toEqual({ state: "idle" });
    expect(c.batches.map((b) => b.state)).toEqual(["planned", "planned"]);
    expect(c.warnings).toEqual([{ code: "two_recipient_batch", batchIndex: 1 }]);
    expect(c.funding).toBeNull();
    expect(c.recipientCount).toBe(5);
  });

  it("funded: funding recorded, still idle", () => {
    const c = load("campaign-funded.json");
    expect(c.phase).toEqual({ phase: "funded" });
    expect(c.run).toEqual({ state: "idle" });
    expect(c.funding?.amount).toBe(c.fundingRequired);
  });

  it("running: batches broadcast, nothing confirmed yet", () => {
    const c = load("campaign-running.json");
    expect(c.run).toEqual({ state: "running" });
    expect(c.phase).toEqual({ phase: "sending", done: 0, total: 2 });
    expect(c.batches.map((b) => b.state)).toEqual(["broadcast", "broadcast"]);
  });

  it("crashed: the run stopped part-way and can be started again", () => {
    const c = load("campaign-crashed.json");
    expect(c.run).toEqual({ state: "crashed" });
    expect(c.batches.map((b) => b.state)).toEqual(["broadcast", "planned"]);
  });

  it("settled: every batch confirmed", () => {
    const c = load("campaign-settled.json");
    expect(c.phase).toEqual({ phase: "settled" });
    expect(c.run).toEqual({ state: "settled" });
    expect(c.batches.every((b) => b.state === "confirmed" && b.confirmations === 3)).toBe(true);
  });

  it("the fee policies differ as documented (5,000 vs 1,000 per action)", () => {
    expect(load("create-valid.json").feePolicy).toEqual({ marginalFee: 5000, graceActions: 2 });
    expect(load("create-zebra-fee.json").feePolicy).toEqual({ marginalFee: 1000, graceActions: 2 });
  });

  it("every warning code the core can raise appears in a capture", () => {
    const codes = new Set(
      ["create-valid", "create-uniform", "create-single", "create-small"].flatMap((f) =>
        load(`${f}.json`).warnings.map((w) => w.code),
      ),
    );
    expect([...codes].sort()).toEqual(["singleton_campaign", "small_campaign", "two_recipient_batch", "uniform_batch"]);
  });
});

describe("campaign lists", () => {
  it("is empty before anything is created", () => {
    expect(parseCampaignList(fixtureJson("campaigns-empty.json"))).toEqual([]);
  });

  it("lists campaigns by summary, and each matches its full view", () => {
    const list = parseCampaignList(fixtureJson("campaigns-list.json"));
    expect(list.length).toBeGreaterThanOrEqual(5);
    const valid = list.find((c) => c.name === "Sentinel campaign");
    expect(valid).toMatchObject({ recipientCount: 5, batchCount: 2, declaredTotal: "1162500000" });
  });
});

// ---- the receipt the operator builds -----------------------------------------------------

describe("operator receipts", () => {
  it("settled: the same strict receipt the public page accepts, with no findings", () => {
    const receipt = parsePublicReceipt(fixtureJson("receipt-settled.json"));
    expect(receipt.phase).toEqual({ phase: "settled" });
    expect(receipt.findings).toEqual([]);
    expect(receipt.campaignId).not.toBeNull();
    expect(receipt.batches.every((b) => b.txid !== null && b.pool === "ironwood")).toBe(true);
  });

  it("matches the campaign it belongs to", () => {
    const receipt = parsePublicReceipt(fixtureJson("receipt-settled.json"));
    const campaign = parseCampaign(fixtureJson("campaign-settled.json"));
    expect(receipt.manifestCommitment).toBe(campaign.manifestCommitment);
    expect(receipt.declaredTotal).toBe(campaign.declaredTotal);
    expect(receipt.feeTotal).toBe(campaign.feeTotal);
    expect(receipt.batches.map((b) => b.txid)).toEqual(campaign.batches.map((b) => b.txid));
  });

  it("running: batches are built but unconfirmed", () => {
    const receipt = parsePublicReceipt(fixtureJson("receipt-running.json"));
    expect(receipt.batches.every((b) => b.txid !== null && b.confirmations === 0)).toBe(true);
  });

  it("before any batch is built, every txid is null", () => {
    const receipt = parsePublicReceipt(fixtureJson("receipt-funded.json"));
    expect(receipt.batches.map((b) => b.txid)).toEqual([null, null]);
  });
});

// ---- start and health ----------------------------------------------------------------------

describe("start and health", () => {
  it("start: started true, then false while the run is still going", () => {
    expect(parseStartResponse(fixtureJson("start-ok.json"))).toEqual({ started: true, run: { state: "running" } });
    expect(parseStartResponse(fixtureJson("start-again.json")).started).toBe(false);
    expect(parseStartResponse(fixtureJson("start-resume.json")).started).toBe(true);
  });

  it("health reports the network and whether the chain is the mock one", () => {
    expect(parseHealth(fixtureJson("health.json"))).toEqual({ network: "testnet", mock: true });
  });

  it("health without the mock flag means unknown, not mock and not real", () => {
    expect(parseHealth({ ok: true, network: "testnet" })).toEqual({ network: "testnet", mock: null });
    expect(parseHealth({ ok: true, network: "testnet", mock: false })).toEqual({ network: "testnet", mock: false });
    expect(parseHealth({ ok: true, network: "mainnet", mock: true })).toEqual({ network: "mainnet", mock: true });
  });

  it("health with anything else on it is refused (the route is exactly these keys)", () => {
    expect(() => parseHealth({ ok: true, network: "testnet", mock: true, build: "x" })).toThrow(ZodError);
    expect(() => parseHealth({ ok: false, network: "testnet", mock: true })).toThrow(ZodError);
    expect(() => parseHealth({ ok: true, network: "testnet", mock: "yes" })).toThrow(ZodError);
    expect(() => parseHealth({ ok: true, network: "testnet", mock: null })).toThrow(ZodError);
  });
});

// ---- SENTINELS: nothing from the CSVs may come back --------------------------------------

/** Values taken from the sentinel CSVs. */
const SENTINELS = (() => {
  const addresses = new Set<string>();
  const memos = new Set<string>();
  const amounts = new Set<string>(); // zatoshi, as the API would write them
  for (const name of ["valid.csv", "uniform.csv", "small.csv"]) {
    for (const line of (CSV[name] ?? "").split("\n").slice(1)) {
      const [address, amount, memo] = line.split(",");
      if (!address) continue;
      addresses.add(address.toLowerCase());
      if (memo) memos.add(memo);
      if (amount) amounts.add(parseZec(amount).toString());
    }
  }
  // Single-recipient: the amount IS the batch total by design (the known limit),
  // so only its address and memo are checked.
  for (const line of (CSV["single.csv"] ?? "").split("\n").slice(1)) {
    const [address, , memo] = line.split(",");
    if (address) addresses.add(address.toLowerCase());
    if (memo) memos.add(memo);
  }
  return { addresses: [...addresses], memos: [...memos], amounts: [...amounts] };
})();

// covers: REQ-PRIV-002
// covers: REQ-PRIV-001, REQ-PRIV-002
describe("no recipient data in any response", () => {
  const everything = Object.entries(FIXTURES).filter(([name]) => name !== "index.json");

  it("the sentinel sets are non-trivial", () => {
    expect(SENTINELS.addresses.length).toBeGreaterThanOrEqual(10);
    expect(SENTINELS.memos.length).toBeGreaterThanOrEqual(5);
    expect(SENTINELS.amounts.length).toBeGreaterThanOrEqual(8);
  });

  it("no sentinel address, memo or individual amount appears in a single captured byte", () => {
    for (const [name, text] of everything) {
      const lower = text.toLowerCase();
      for (const address of SENTINELS.addresses) expect(lower, `${name} leaks an address`).not.toContain(address);
      for (const memo of SENTINELS.memos) expect(text, `${name} leaks a memo`).not.toContain(memo);
      if (name !== "create-single.json") {
        for (const amount of SENTINELS.amounts) {
          expect(text, `${name} leaks the amount ${amount}`).not.toMatch(new RegExp(`"${amount}"`, "u"));
        }
      }
    }
  });

  it("CONTROL: the scan really can fail (a response with a planted sentinel is caught)", () => {
    const planted = JSON.stringify({ ...(fixtureJson("campaign-funded.json") as Json), note: SENTINELS.addresses[0] });
    expect(planted.toLowerCase()).toContain(SENTINELS.addresses[0]);
    const leaked = SENTINELS.addresses.some((a) => planted.toLowerCase().includes(a));
    expect(leaked).toBe(true);
  });

  it("the sentinel CSVs themselves do contain what the scan looks for", () => {
    expect(CSV["valid.csv"]).toContain("u1sentineladdressaaaaaaaaaaaaaaaaaaaa");
    expect(CSV["valid.csv"]).toContain("memo-sentinel-one");
  });
});

// ---- strictness: no field for recipient data can be accepted -----------------------------------

// covers: REQ-PRIV-001
describe("a recipient field smuggled into any response is refused, never stripped", () => {
  const PRIVATE: [string, unknown][] = [
    ["address", "u1sentineladdressaaaaaaaaaaaaaaaaaaaa"],
    ["recipients", [{ address: "u1x", amount: "1" }]],
    ["amount", "150000000"],
    ["memo", "memo-sentinel-one"],
    ["csv", "address,amount\nu1x,1\n"],
  ];

  const campaign = () => fixtureJson("campaign-settled.json") as Json;
  const rejects = (parse: (i: unknown) => unknown, input: unknown) => expect(() => parse(input)).toThrow(ZodError);

  it.each(PRIVATE)("campaign: top level `%s`", (key, value) => {
    rejects(parseCampaign, { ...campaign(), [key]: value });
  });

  it.each(PRIVATE)("campaign: inside a batch `%s`", (key, value) => {
    const c = campaign();
    const batches = (c["batches"] as Json[]).map((b, i) => (i === 0 ? { ...b, [key]: value } : b));
    rejects(parseCampaign, { ...c, batches });
  });

  it.each(PRIVATE)("campaign: inside funding / fee policy / run `%s`", (key, value) => {
    const c = campaign();
    // `funding.amount` is the DEPOSIT the operator observed (a public figure),
    // so overwriting it with another valid amount is not an injection. Every
    // other key, and `amount` on the other objects, must be refused.
    if (key !== "amount") {
      rejects(parseCampaign, { ...c, funding: { ...(c["funding"] as Json), [key]: value } });
    }
    rejects(parseCampaign, { ...c, fee_policy: { ...(c["fee_policy"] as Json), [key]: value } });
    rejects(parseCampaign, { ...c, run: { ...(c["run"] as Json), [key]: value } });
  });

  it("funding accepts its own two fields and nothing beyond them", () => {
    const c = campaign();
    const funding = c["funding"] as Json;
    expect(Object.keys(funding).sort()).toEqual(["amount", "outpoint"]);
    rejects(parseCampaign, { ...c, funding: { ...funding, recipient_amount: "150000000" } });
    rejects(parseCampaign, { ...c, funding: { ...funding, amounts: ["1"] } });
  });

  it.each(PRIVATE)("campaign: inside a warning `%s`", (key, value) => {
    const c = fixtureJson("create-valid.json") as Json;
    const warnings = (c["warnings"] as Json[]).map((w) => ({ ...w, [key]: value }));
    rejects(parseCampaign, { ...c, warnings });
  });

  it.each(PRIVATE)("list item `%s`", (key, value) => {
    const list = fixtureJson("campaigns-list.json") as Json[];
    rejects(parseCampaignList, list.map((c, i) => (i === 0 ? { ...c, [key]: value } : c)));
  });

  it.each(PRIVATE)("error envelope and row error `%s`", (key, value) => {
    const e = fixtureJson("create-row-errors.json") as { error: Json };
    rejects(parseOperatorError, { error: { ...e.error, [key]: value } });
    const errors = (e.error["errors"] as Json[]).map((r, i) => (i === 0 ? { ...r, [key]: value } : r));
    rejects(parseOperatorError, { error: { ...e.error, errors } });
  });

  it.each(PRIVATE)("health and start `%s`", (key, value) => {
    rejects(parseHealth, { ...(fixtureJson("health.json") as Json), [key]: value });
    rejects(parseStartResponse, { ...(fixtureJson("start-ok.json") as Json), [key]: value });
  });

  it.each(PRIVATE)("progress event `%s`", (key, value) => {
    rejects(parseProgressEvent, { event: "waiting", batch_index: 0, observed_depth: 0, required_depth: 3, [key]: value });
  });

  it("a missing field is refused too (null is not absence)", () => {
    for (const key of Object.keys(campaign())) {
      const c = campaign();
      delete c[key];
      rejects(parseCampaign, c);
    }
  });
});

// ---- shapes the mock chain cannot produce (from the Rust source) -------------------------------------

describe("shapes taken from the Rust source, not from a capture", () => {
  it("run states halted and stalled (crates/drop-operator/src/state.rs)", () => {
    const base = fixtureJson("campaign-running.json") as Json;
    expect(parseCampaign({ ...base, run: { state: "halted" } }).run).toEqual({ state: "halted" });
    expect(parseCampaign({ ...base, run: { state: "stalled", error: "chain unreachable" } }).run).toEqual({
      state: "stalled",
      error: "chain unreachable",
    });
    expect(() => parseCampaign({ ...base, run: { state: "stalled" } })).toThrow(ZodError);
    expect(() => parseCampaign({ ...base, run: { state: "exploded" } })).toThrow(ZodError);
  });

  it("batch state failed, with its reason (drop_core::BatchStatus)", () => {
    const base = fixtureJson("campaign-running.json") as Json;
    const batches = (base["batches"] as Json[]).map((b, i) =>
      i === 0 ? { ...b, state: "failed", reason: "rejected by the node" } : b,
    );
    const parsed = parseCampaign({ ...base, batches });
    expect(parsed.batches[0]).toMatchObject({ state: "failed", reason: "rejected by the node" });
    expect([...BATCH_STATES]).toEqual(["planned", "built", "broadcast", "confirmed", "failed"]);
    expect(() => parseCampaign({ ...base, batches: batches.map((b) => ({ ...b, state: "lost" })) })).toThrow(ZodError);
  });

  it("progress events failed and halted (drop_core::ProgressEvent)", () => {
    expect(parseProgressEvent({ event: "failed", batch_index: 1, reason: "rejected" })).toEqual({
      event: "failed",
      batchIndex: 1,
      reason: "rejected",
    });
    const halted = parseProgressEvent({ event: "halted", failed_batches: [1, 3] });
    expect(halted).toEqual({ event: "halted", failedBatches: [1, 3] });
    expect(isTerminalEvent(halted)).toBe(true);
  });

  it("the real chain's answer to fund-observed is a plain error (403 dev_only)", () => {
    expect(
      parseOperatorError({ error: { code: "dev_only", message: "funding is observed from the chain; this endpoint exists for the mock chain only" } }),
    ).toMatchObject({ code: "dev_only" });
  });
});

describe("the campaign view still has the fields the Rust source declares", () => {
  /** Field names of a Rust struct body: `name: Type,` lines at one indent. */
  const fields = (source: string, header: string): string[] =>
    [...between(source, header, "\n}").matchAll(/^ {4}(?:pub )?([a-z_]+):/gmu)].map((m) => m[1] ?? "");

  it("`CampaignView` (api.rs) lists exactly the keys of a captured campaign, in order", () => {
    const declared = fields(operatorApiSource, "struct CampaignView {");
    expect(declared.length).toBeGreaterThan(15);
    expect(Object.keys(fixtureJson("campaign-funded.json") as Json)).toEqual(declared);
  });

  it("`CampaignSummary` (api.rs) lists exactly the keys of a captured list entry", () => {
    const declared = fields(operatorApiSource, "struct CampaignSummary {");
    const first = (fixtureJson("campaigns-list.json") as Json[])[0] as Json;
    expect(Object.keys(first)).toEqual(declared);
  });

  it("`FundingProgress` (state.rs) is what the schema accepts, field for field", () => {
    const declared = fields(operatorStateSource, "pub struct FundingProgress {");
    expect(declared).toEqual(["outpoint", "amount", "confirmations", "required_depth", "sufficient"]);
  });
});

describe("new real-chain fields: edge cases beyond the golden files", () => {
  // The mock chain always answers wallet_matches = true, funding_address = null
  // and funding_progress = null. The real forms are in golden/ (golden.test.ts);
  // these cover shapes the golden files do not, and what the strict schema refuses.
  const base = fixtureJson("campaign-awaiting-funding.json") as Json;
  const TXID = "ab".repeat(32);

  it("a captured campaign has the mock chain's defaults", () => {
    const c = parseCampaign(base);
    expect(c.walletMatches).toBe(true);
    expect(c.fundingAddress).toBeNull();
    expect(c.fundingProgress).toBeNull();
  });

  it("accepts a funding address and a funding progress", () => {
    const c = parseCampaign({
      ...base,
      funding_address: "tmExampleFundingAddress",
      funding_progress: {
        outpoint: `${TXID}:1`,
        amount: "1162535000",
        confirmations: 2,
        required_depth: 10,
        sufficient: true,
      },
    });
    expect(c.fundingAddress).toBe("tmExampleFundingAddress");
    expect(c.fundingProgress).toEqual({
      outpoint: { txid: TXID, vout: 1 },
      amount: "1162535000",
      confirmations: 2,
      requiredDepth: 10,
      sufficient: true,
    });
  });

  it("refuses a malformed progress, an extra field, and an address with whitespace", () => {
    const progress = { outpoint: `${TXID}:1`, amount: "1", confirmations: 0, required_depth: 10, sufficient: false };
    expect(() => parseCampaign({ ...base, funding_progress: { ...progress, recipient: "x" } })).toThrow(ZodError);
    expect(() => parseCampaign({ ...base, funding_progress: { ...progress, sufficient: "yes" } })).toThrow(ZodError);
    expect(() => parseCampaign({ ...base, funding_progress: { ...progress, amount: "1.5" } })).toThrow(ZodError);
    expect(() => parseCampaign({ ...base, funding_address: "t m" })).toThrow(ZodError);
    expect(() => parseCampaign({ ...base, funding_address: "" })).toThrow(ZodError);
  });

  it("wallet_matches is required and must be a boolean", () => {
    const { wallet_matches: _dropped, ...without } = base;
    expect(() => parseCampaign(without)).toThrow(ZodError);
    expect(() => parseCampaign({ ...base, wallet_matches: "true" })).toThrow(ZodError);
    expect(parseCampaign({ ...base, wallet_matches: false, funding_address: null }).walletMatches).toBe(false);
  });

  it("the viewing-key export carries a warning, the campaign, the network and the key", () => {
    const body = { warning: "W", campaign_id: "c-000000000001", network: "testnet", ufvk: "uviewtest1abc" };
    expect(parseViewingKeyExport(body)).toEqual({
      warning: "W",
      campaignId: "c-000000000001",
      network: "testnet",
      ufvk: "uviewtest1abc",
    });
    expect(() => parseViewingKeyExport({ ...body, extra: 1 })).toThrow(ZodError);
    const { warning: _w, ...noWarning } = body;
    expect(() => parseViewingKeyExport(noWarning)).toThrow(ZodError);
    expect(() => parseViewingKeyExport({ ...body, ufvk: "two words" })).toThrow(ZodError);
  });
});
