// The simulated operator and verifier against the REAL operator's captured answers (fixtures/contract/operator, written by
// scripts/capture-operator-fixtures.mjs from `drop-operator --mock-chain`). Every request the capture made is made again here,
// of the simulation, and what comes back must be the same thing: the same status, and the same body except for the values that
// are random in the real one (ids, transaction ids, the fingerprint, the time), which are compared by where they appear. Each
// answer is also read by the page's own strict parser, as the screens read it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRACTICE_REFUSAL } from "@/api/client";
import {
  parseCampaign,
  parseCampaignList,
  parseHealth,
  parseOperatorError,
  parseProgressEvent,
  parseStartResponse,
} from "@/api/operator/schemas";
import { PRACTICE_TOKEN } from "@/api/operator/session";
import { parsePublicReceipt } from "@/api/types";
import { isPracticeId } from "@/lib/practice-mode";
import { CSV, FIXTURES, fixtureJson, INDEX, type IndexEntry } from "@/test/operator-fixtures";

import { activity } from "./activity";
import { pace } from "./pace";
import { createPractice, type Practice } from "./simulation";

let practice: Practice;

/** Ids that differ from one call to the next, and are different from each other. */
function counting(): (length: number) => Uint8Array {
  let next = 1;
  return (length) => Uint8Array.from({ length }, () => (next++ * 37) % 256);
}

beforeEach(() => {
  pace.stepMs = 0;
  practice = createPractice({ random: counting(), now: () => 1_700_000_000 });
});

afterEach(() => {
  practice.dispose();
  vi.useRealTimers();
  pace.stepMs = 1_200;
});

interface Called {
  status: number;
  text: string;
  json: unknown;
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; raw?: string; type?: string | null; token?: string | null; signal?: AbortSignal } = {},
): Promise<Called> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.token !== null) headers["Authorization"] = `Bearer ${options.token ?? PRACTICE_TOKEN}`;
  const body = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (body !== undefined && options.type !== null) headers["Content-Type"] = options.type ?? "application/json";
  const response = await practice.transport(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // An event stream is text, not JSON.
  }
  return { status: response.status, text, json };
}

// ---- comparing with what the real operator said -------------------------------------------------------

const HEX32 = /[0-9a-f]{64}/gu;

/** The same JSON with its random values replaced by where they appear: each distinct 64-hex id, in the order its place is
 * read (keys sorted, so the order does not depend on how a server writes them), is named by that order; a campaign id is
 * "<campaign>"; the time is "<time>". Both sides are named by the same rule. */
function shape(value: unknown): unknown {
  const names = new Map<string, string>();
  const name = (hex: string): string => {
    const known = names.get(hex);
    if (known !== undefined) return known;
    const made = `<id ${String(names.size + 1)}>`;
    names.set(hex, made);
    return made;
  };
  const walk = (node: unknown, key: string): unknown => {
    if (typeof node === "string") {
      if (/^(c-[0-9a-f]{12}|practice-[0-9a-f]{6})$/u.test(node)) return "<campaign>";
      return node.replace(HEX32, name);
    }
    if (typeof node === "number" && key === "created_at") return "<time>";
    if (Array.isArray(node)) return node.map((item) => walk(item, key));
    if (typeof node === "object" && node !== null) {
      return Object.fromEntries(
        Object.keys(node)
          .sort()
          .map((k) => [k, walk((node as Record<string, unknown>)[k], k)]),
      );
    }
    return node;
  };
  return walk(value, "");
}

/** The fixture a capture saved, as JSON. */
const real = (file: string): unknown => fixtureJson(file);

const csv = (path: string): string => {
  const text = CSV[path.replace(/^csv\//u, "")];
  if (text === undefined) throw new Error(`no sentinel list ${path}`);
  return text;
};

const create = (name: string, list: string, maxOutputsPerBatch = 3, feePolicy = "zip317_text") =>
  call("POST", "/campaigns", { body: { name, csv: list, max_outputs_per_batch: maxOutputsPerBatch, fee_policy: feePolicy } });

/** What the capture script deposited: one transaction, enough for the whole plan. */
const DEPOSIT = "cd".repeat(32);
const fund = (id: string, amount: string, outpoint = `${DEPOSIT}:0`) =>
  call("POST", `/campaigns/${id}/fund-observed`, { body: { outpoint, amount } });

const idOf = (called: Called): string => (called.json as { id: string }).id;

// ---- creating a campaign: every request the capture made --------------------------------------------------------

describe("creating a campaign", () => {
  const created = INDEX.filter((entry): entry is IndexEntry & { request: NonNullable<IndexEntry["request"]> } => entry.method === "POST" && entry.path === "/api/campaigns" && entry.request !== undefined);

  it("has the captures to compare with", () => {
    expect(created.length).toBeGreaterThanOrEqual(12);
  });

  it.each(created.map((entry) => [entry.file, entry] as const))("answers %s as the operator did", async (_file, entry) => {
    const answer = await create(entry.request.name, csv(entry.request.csv), entry.request.max_outputs_per_batch, entry.request.fee_policy);
    expect(answer.status).toBe(entry.status);
    expect(shape(answer.json)).toEqual(shape(real(entry.file)));
    if (entry.status === 201) {
      const campaign = parseCampaign(answer.json);
      expect(campaign.walletMatches).toBe(true);
      expect(campaign.fundingAddress).toBeNull();
    } else {
      // Read by the page as an error with a code and a sentence, row errors included.
      expect(parseOperatorError(answer.json).code).toBe((real(entry.file) as { error: { code: string } }).error.code);
    }
  });

  it("refuses a blank name, a batch size that cannot be split, and a body that is not a request, in the operator's words", async () => {
    const blank = await create("   ", csv("csv/valid.csv"));
    expect(blank.status).toBe(422);
    expect(shape(blank.json)).toEqual(shape(real("create-invalid-name.json")));
    const none = await create("x", csv("csv/valid.csv"), 0);
    expect(none.status).toBe(422);
    expect(shape(none.json)).toEqual(shape(real("create-plan-failed.json")));

    const notJson = await call("POST", "/campaigns", { raw: "{" });
    expect(notJson.status).toBe(400);
    expect((notJson.json as { error: { code: string } }).error.code).toBe("invalid_body");
    const extra = await call("POST", "/campaigns", { body: { name: "x", csv: csv("csv/valid.csv"), max_outputs_per_batch: 3, fee_policy: "zip317_text", extra: 1 } });
    expect(extra.status).toBe(400);
    expect((extra.json as { error: { code: string } }).error.code).toBe("invalid_body");
    const policy = await create("x", csv("csv/valid.csv"), 3, "free");
    expect(policy.status).toBe(400);
    expect((policy.json as { error: { code: string } }).error.code).toBe("invalid_body");
    const media = await call("POST", "/campaigns", { raw: "name=x", type: "text/plain" });
    expect(media.status).toBe(415);
    expect(media.json).toEqual(real("create-wrong-media-type.json"));
  });

  it("refuses a batch size no transaction could hold, and a list that is not one batch", async () => {
    const big = await create("x", csv("csv/valid.csv"), 331);
    expect(big.status).toBe(422);
    expect(big.json).toEqual({
      error: { code: "batch_size_too_large", message: "max_outputs_per_batch is 331 but one transaction can pay at most 330 recipients" },
    });
    // Three recipients in batches of at most two cannot be split without a batch of one.
    const three = await create("x", csv("csv/small.csv"), 2);
    expect(three.status).toBe(422);
    expect(three.json).toEqual({
      error: {
        code: "plan_failed",
        message: "cannot split 3 recipients into batches of at most 2 without a single-recipient batch; raise the batch size",
      },
    });
    // A header and nothing else.
    const empty = await create("x", "address,amount,memo\n");
    expect(empty.json).toEqual({ error: { code: "plan_failed", message: "there are no recipients to plan" } });
  });

  it("holds none of the list: what it answers has no address, no memo and no amount of a person", async () => {
    const answer = await create("Counts only", csv("csv/valid.csv"));
    const text = answer.text;
    for (const secret of ["u1sentineladdress", "zs1sentineladdress", "memo-sentinel", "2.25", "4.125"]) expect(text).not.toContain(secret);
    expect(parseCampaign(answer.json).recipientCount).toBe(5);
  });
});

// ---- the routes around it ---------------------------------------------------------------------------------------------

describe("what every call needs, and what is not there", () => {
  it("answers health with no token, as the practice chain does", async () => {
    const answer = await call("GET", "/health", { token: null });
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual(real("health.json"));
    expect(parseHealth(answer.json)).toEqual({ network: "testnet", mock: true });
  });

  it("wants the token for everything else, and says so as the operator does", async () => {
    for (const token of [null, "wrong"]) {
      const answer = await call("GET", "/campaigns", { token });
      expect(answer.status).toBe(401);
      expect(answer.json).toEqual(real("unauthorized-no-token.json"));
    }
    expect((await call("POST", "/campaigns", { token: null, body: {} })).status).toBe(401);
  });

  it("answers a route it does not have with the operator's not-found", async () => {
    const answer = await call("GET", "/nope");
    expect(answer.status).toBe(404);
    expect(answer.json).toEqual(real("route-not-found.json"));
    // The funding-from-another-coin routes belong to a real chain.
    expect((await call("GET", "/near/tokens")).status).toBe(404);
  });

  it("says there is no such campaign, for one that does not exist and for an id that is not even an id", async () => {
    const unknown = await call("GET", "/campaigns/practice-000000");
    expect(unknown.status).toBe(404);
    expect(unknown.json).toEqual(real("campaign-not-found.json"));
    const bad = await call("GET", `/campaigns/${encodeURIComponent("not an id!")}`);
    expect(bad.status).toBe(404);
    expect(bad.json).toEqual(real("campaign-bad-id.json"));
    expect((await call("GET", "/campaigns/practice-000000/events")).json).toEqual(real("events-not-found.json"));
    expect((await call("POST", "/campaigns/practice-000000/start")).status).toBe(404);
    expect((await call("GET", "/campaigns/practice-000000/receipt")).status).toBe(404);
    expect((await fund("practice-000000", "1")).status).toBe(404);
  });

  it("has no viewing key, no payslips and no funding address to look at, as the practice chain says", async () => {
    const made = await create("x", csv("csv/valid.csv"));
    const key = await call("GET", `/campaigns/${idOf(made)}/audit-ufvk-export`);
    expect(key.status).toBe(409);
    expect(key.json).toEqual(real("export-ufvk-mock.json"));
    const payslips = await call("GET", `/campaigns/${idOf(made)}/payslips`);
    expect(payslips.status).toBe(409);
    expect(payslips.json).toEqual(real("payslips-mock.json"));
    const check = await call("POST", `/campaigns/${idOf(made)}/check-funding`);
    expect(check.status).toBe(409);
    expect(check.json).toEqual(real("check-funding-mock.json"));
  });

  it("lists what it has made, in the order it was made", async () => {
    const empty = await call("GET", "/campaigns");
    expect(empty.json).toEqual(real("campaigns-empty.json"));
    await create("Sentinel campaign", csv("csv/valid.csv"));
    await create("Lower fee campaign", csv("csv/valid.csv"), 3, "zebra_main");
    await create("Equal amounts", csv("csv/uniform.csv"));
    await create("One recipient", csv("csv/single.csv"), 10);
    await create("Three recipients", csv("csv/small.csv"), 10);
    const list = await call("GET", "/campaigns");
    expect(shape(list.json)).toEqual(shape(real("campaigns-list.json")));
    expect(parseCampaignList(list.json)).toHaveLength(5);
  });
});

// ---- funding, sending, and what the run says ----------------------------------------------------------------------------

describe("funding a campaign", () => {
  it("takes a deposit that covers it, takes the same one again, and refuses another", async () => {
    const made = await create("Sentinel campaign", csv("csv/valid.csv"));
    const id = idOf(made);
    const funded = await fund(id, "1162535000");
    expect(funded.status).toBe(200);
    expect(shape(funded.json)).toEqual(shape(real("fund-ok.json")));
    expect(parseCampaign(funded.json).phase).toEqual({ phase: "funded" });

    const again = await fund(id, "1162535000");
    expect(again.status).toBe(200);
    expect(shape(again.json)).toEqual(shape(real("fund-same-again.json")));

    const other = await fund(id, "1162535001");
    expect(other.status).toBe(409);
    expect(shape(other.json)).toEqual(shape(real("fund-conflict.json")));
    expect(parseOperatorError(other.json).code).toBe("funding_conflict");
  });

  it("refuses a deposit that is too small, with both figures", async () => {
    const id = idOf(await create("Sentinel campaign", csv("csv/valid.csv")));
    const small = await fund(id, "1000");
    expect(small.status).toBe(422);
    expect(small.json).toEqual(real("fund-insufficient.json"));
  });

  it("refuses a request that is not a deposit", async () => {
    const id = idOf(await create("Sentinel campaign", csv("csv/valid.csv")));
    for (const body of [{ outpoint: "nonsense", amount: "1162535000" }, { outpoint: `${DEPOSIT}:0` }, { outpoint: `${DEPOSIT}:0`, amount: "1.5" }, "text"]) {
      const answer = await call("POST", `/campaigns/${id}/fund-observed`, { body });
      expect(answer.status).toBe(400);
      expect((answer.json as { error: { code: string } }).error.code).toBe("invalid_body");
    }
    // An output index so large that the last batch would not have one it can write.
    const last = await fund(id, "1162535000", `${DEPOSIT}:4294967295`);
    expect(last.status).toBe(422);
    expect((last.json as { error: { code: string } }).error.code).toBe("invalid_outpoint");
  });

  it("has a receipt only once there is a deposit, and one with no transaction in it before the first is built", async () => {
    const id = idOf(await create("Sentinel campaign", csv("csv/valid.csv")));
    const before = await call("GET", `/campaigns/${id}/receipt`);
    expect(before.status).toBe(409);
    expect(before.json).toEqual(real("receipt-not-funded.json"));
    await fund(id, "1162535000");
    const after = await call("GET", `/campaigns/${id}/receipt`);
    expect(after.status).toBe(200);
    expect(shape(after.json)).toEqual(shape(real("receipt-funded.json")));
    expect(parsePublicReceipt(after.json).phase).toEqual({ phase: "funded" });
  });
});

describe("a run", () => {
  it("will not start before the deposit, starts once, and says it is already running", async () => {
    const id = idOf(await create("Sentinel campaign", csv("csv/valid.csv")));
    const early = await call("POST", `/campaigns/${id}/start`);
    expect(early.status).toBe(409);
    expect(early.json).toEqual(real("start-not-funded.json"));

    await fund(id, "1162535000");
    const first = await call("POST", `/campaigns/${id}/start`);
    expect(first.status).toBe(202);
    expect(first.json).toEqual(real("start-ok.json"));
    expect(parseStartResponse(first.json)).toEqual({ started: true, run: { state: "running" } });
    const second = await call("POST", `/campaigns/${id}/start`);
    expect(second.status).toBe(202);
    expect(second.json).toEqual(real("start-again.json"));
  });

  it("tells the same story the operator told, event for event, and ends with the campaign settled", async () => {
    const id = idOf(await create("Sentinel campaign", csv("csv/valid.csv")));
    await fund(id, "1162535000");
    await call("POST", `/campaigns/${id}/start`);
    const stream = await call("GET", `/campaigns/${id}/events`);
    expect(stream.status).toBe(200);

    const framesOf = (text: string): string[] => text.split("\n\n").filter((frame) => frame !== "");
    const told = framesOf(stream.text).map((frame) => shape(frame));
    const known = framesOf(FIXTURES["events-settled.sse.txt"] ?? "").map((frame) => shape(frame));
    // Each frame is `event: progress` and its data; compared as JSON so that the order of a frame's keys does not matter.
    const asEvents = (frames: string[]) => frames.map((frame) => shape(JSON.parse(frame.split("data: ")[1] ?? "null")));
    expect(told).toHaveLength(known.length);
    expect(framesOf(stream.text).every((frame) => frame.startsWith("event: progress\ndata: "))).toBe(true);
    expect(asEvents(framesOf(stream.text))).toEqual(asEvents(framesOf(FIXTURES["events-settled.sse.txt"] ?? "")));
    for (const frame of framesOf(stream.text)) expect(parseProgressEvent(JSON.parse(frame.split("data: ")[1] ?? "null"))).toBeDefined();

    // And the campaign says what the story said.
    const view = await call("GET", `/campaigns/${id}`);
    expect(shape(view.json)).toEqual(shape(real("campaign-settled.json")));
    expect(parseCampaign(view.json).run).toEqual({ state: "settled" });
    const receipt = await call("GET", `/campaigns/${id}/receipt`);
    expect(shape(receipt.json)).toEqual(shape(real("receipt-settled.json")));
    expect(parsePublicReceipt(receipt.json).phase).toEqual({ phase: "settled" });
    expect(activity.timers).toBe(0);
    expect(activity.streams).toBe(0);
  });

  it("is a story told in time: built, sent, waiting, one confirmation at a time, settled", async () => {
    vi.useFakeTimers();
    pace.stepMs = 1_000;
    const id = idOf(await create("In progress", csv("csv/valid.csv")));
    await fund(id, "1162535000");
    await call("POST", `/campaigns/${id}/start`);
    const phaseAt = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      return parseCampaign((await call("GET", `/campaigns/${id}`)).json);
    };

    // Nothing is built in the first moment; then the first batch is built, then sent, then the second ...
    expect((await phaseAt(500)).batches.map((b) => b.state)).toEqual(["planned", "planned"]);
    expect((await phaseAt(600)).batches.map((b) => b.state)).toEqual(["built", "planned"]);
    expect((await phaseAt(700)).batches.map((b) => b.state)).toEqual(["broadcast", "planned"]);
    await vi.advanceTimersByTimeAsync(1_700);
    // ... both sent, no block yet: this is what the operator showed a run in progress.
    const running = await call("GET", `/campaigns/${id}`);
    expect(shape(running.json)).toEqual(shape(real("campaign-running.json")));
    const receipt = await call("GET", `/campaigns/${id}/receipt`);
    expect(shape(receipt.json)).toEqual(shape(real("receipt-running.json")));

    // Each block adds a confirmation to every batch, and the campaign is final when they all have three.
    const depths: number[][] = [];
    for (let block = 0; block < 4; block += 1) {
      const campaign = await phaseAt(1_000);
      depths.push(campaign.batches.map((b) => b.confirmations));
    }
    expect(depths).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]]);
    const settled = await phaseAt(1_000);
    expect(settled.run).toEqual({ state: "settled" });
    expect(settled.phase).toEqual({ phase: "settled" });
  });

  it("is told afresh to a stream that connects late, and a stream that is cancelled leaves nothing running", async () => {
    vi.useFakeTimers();
    pace.stepMs = 1_000;
    const id = idOf(await create("Late", csv("csv/valid.csv")));
    await fund(id, "1162535000");
    await call("POST", `/campaigns/${id}/start`);
    await vi.advanceTimersByTimeAsync(3_300);

    const controller = new AbortController();
    const response = await practice.transport(`/campaigns/${id}/events`, {
      method: "GET",
      headers: { Authorization: `Bearer ${PRACTICE_TOKEN}` },
      signal: controller.signal,
    });
    const reader = (response.body ?? new ReadableStream<Uint8Array>()).getReader();
    // Everything that has happened so far comes first, one frame at a time: both transactions built, both sent.
    let told = "";
    for (let frames = 0; frames < 4; frames += 1) told += new TextDecoder().decode((await reader.read()).value);
    expect(told.match(/event: progress/gu)).toHaveLength(4);
    expect(told.match(/"event":"(built|broadcast)"/gu)).toHaveLength(4);
    expect(activity.streams).toBe(1);

    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    expect(activity.streams).toBe(0);
    await reader.cancel().catch(() => undefined);
  });

  it("refuses a call that was cancelled before it was answered, as a network does", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(call("GET", "/campaigns", { signal: controller.signal })).rejects.toThrow(/aborted/u);
  });
});

// ---- the public verifier ---------------------------------------------------------------------------------------------------

describe("the public verifier", () => {
  async function settled(): Promise<{ id: string; txids: string[]; commitment: string; total: string }> {
    const made = await create("Sentinel campaign", csv("csv/valid.csv"));
    const id = idOf(made);
    await fund(id, "1162535000");
    await call("POST", `/campaigns/${id}/start`);
    await call("GET", `/campaigns/${id}/events`);
    const view = parseCampaign((await call("GET", `/campaigns/${id}`)).json);
    return {
      id,
      txids: view.batches.map((b) => b.txid ?? ""),
      commitment: view.manifestCommitment,
      total: view.declaredTotal,
    };
  }

  const link = (c: { txids: string[]; commitment: string; total: string }, network = "testnet", total = c.total): string =>
    `/v1/receipt?network=${network}&${c.txids.map((t) => `tx=${t}`).join("&")}&commitment=${c.commitment}&declared_total=${total}`;

  it("marks every id it made with the practice marker, which no chain's id has", async () => {
    const c = await settled();
    for (const txid of c.txids) expect(isPracticeId(txid)).toBe(true);
    expect(isPracticeId(c.commitment)).toBe(true);
  });

  it("reads back a payout it made, as a receipt that is not told which campaign it is about", async () => {
    const c = await settled();
    const answer = await call("GET", link(c), { token: null });
    expect(answer.status).toBe(200);
    const receipt = parsePublicReceipt(answer.json);
    expect(receipt.campaignId).toBeNull();
    expect(receipt.phase).toEqual({ phase: "settled" });
    expect(receipt.findings).toEqual([]);
    expect(receipt.declaredTotal).toBe(c.total);
    expect(receipt.manifestCommitment).toBe(c.commitment);
    expect(receipt.batches.map((b) => b.txid)).toEqual(c.txids);
    // The operator's own receipt and the verifier's agree about everything the verifier can know.
    const theirs = parsePublicReceipt((await call("GET", `/campaigns/${c.id}/receipt`)).json);
    expect(receipt.batches).toEqual(theirs.batches);
  });

  it("says a batch that is not yet three blocks deep is not yet confirmed, and its phase is still sending", async () => {
    vi.useFakeTimers();
    pace.stepMs = 1_000;
    const made = await create("In progress", csv("csv/valid.csv"));
    const id = idOf(made);
    await fund(id, "1162535000");
    await call("POST", `/campaigns/${id}/start`);
    await vi.advanceTimersByTimeAsync(6_300);
    const view = parseCampaign((await call("GET", `/campaigns/${id}`)).json);
    const c = { txids: view.batches.map((b) => b.txid ?? ""), commitment: view.manifestCommitment, total: view.declaredTotal };
    const receipt = parsePublicReceipt((await call("GET", link(c), { token: null })).json);
    expect(receipt.findings).toEqual([
      { code: "batch_pending", batchIndex: 0 },
      { code: "batch_pending", batchIndex: 1 },
    ]);
    expect(receipt.phase).toEqual({ phase: "sending", done: 0, total: 2 });
  });

  it("flags a declared total that is not what the batches add up to", async () => {
    const c = await settled();
    const receipt = parsePublicReceipt((await call("GET", link(c, "testnet", "1"), { token: null })).json);
    expect(receipt.findings).toEqual([{ code: "declared_total_mismatch" }]);
    expect(receipt.phase).toEqual({ phase: "failed" });
  });

  it("does not know a transaction it did not make, and says it reads no chain", async () => {
    const c = await settled();
    const stranger = { ...c, txids: ["ab".repeat(32)] };
    const none = await call("GET", link(stranger), { token: null });
    expect(none.status).toBe(409);
    expect((none.json as { error: { code: string } }).error.code).toBe(PRACTICE_REFUSAL);
    // One it knows and one it does not: the unknown one is a finding, not a refusal.
    const mixed = parsePublicReceipt((await call("GET", link({ ...c, txids: [c.txids[0] ?? "", "ab".repeat(32)] }), { token: null })).json);
    expect(mixed.findings.map((f) => f.code)).toContain("tx_not_found");
  });

  it("is set up for the practice testnet only, and for links that are links", async () => {
    const c = await settled();
    const mainnet = await call("GET", link(c, "mainnet"), { token: null });
    expect(mainnet.status).toBe(400);
    expect((mainnet.json as { error: { code: string } }).error.code).toBe("network_not_configured");
    const bad = await call("GET", "/v1/receipt?network=testnet", { token: null });
    expect(bad.status).toBe(400);
  });

  it("checks no payslip: it reads no chain, and says so with the code the page turns into a sentence", async () => {
    const answer = await call("POST", "/v1/payslip", { token: null, body: { version: 1 } });
    expect(answer.status).toBe(409);
    expect((answer.json as { error: { code: string } }).error.code).toBe(PRACTICE_REFUSAL);
    expect((await call("GET", "/v1/nope", { token: null })).status).toBe(404);
  });
});

// ---- what leaving does ------------------------------------------------------------------------------------------------------

describe("disposing of it", () => {
  it("stops a run in the middle, closes its streams and forgets every campaign", async () => {
    vi.useFakeTimers();
    pace.stepMs = 1_000;
    const id = idOf(await create("Interrupted", csv("csv/valid.csv")));
    await fund(id, "1162535000");
    await call("POST", `/campaigns/${id}/start`);
    const open = await practice.transport(`/campaigns/${id}/events`, { headers: { Authorization: `Bearer ${PRACTICE_TOKEN}` } });
    expect(open.status).toBe(200);
    expect(activity.timers).toBe(1);
    expect(activity.streams).toBe(1);

    practice.dispose();
    expect(activity.timers).toBe(0);
    expect(activity.streams).toBe(0);
    // Nothing happens afterwards: no timer is left to fire.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(activity.timers).toBe(0);
    // And it holds nothing: a fresh look finds no campaign.
    expect((await call("GET", "/campaigns")).json).toEqual([]);
  });
});
