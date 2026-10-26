// The operator's HTTP contract and the public verifier's, answered from memory. Every route the screens call is here, with the
// statuses, the error codes and the error sentences the real operator gives on its practice chain (`drop-operator --mock-chain`,
// captured in fixtures/contract/operator, which server.test.ts compares this file's answers with). A request never leaves
// the page: it comes in through the transport (api/client.ts), and the answer is made here.
//
// What is kept is in state.ts: counts, batch totals, fees, ids. A list is read once, in `create`, and dropped.

import { PRACTICE_REFUSAL } from "@/api/client";
import { FUNDING_SOURCES, type FundingSource } from "@/api/types";
import { PRACTICE_TOKEN } from "@/api/operator/session";
import { parseReceiptLink } from "@/api/receipt-query";

import { activity } from "./activity";
import { importCsv, MAX_MONEY, MAX_REPORTED_ROW_ERRORS } from "./csv";
import { openEventStream, type OpenStream } from "./events";
import { planCampaign } from "./plan";
import { practiceCampaignId, practiceHex32, type RandomBytes } from "./random";
import { startRun } from "./run";
import { Scheduler } from "./scheduler";
import { campaignView, operatorReceiptView, summaryView, type Campaign } from "./state";
import { receiptFromQuery } from "./verifier";

/** One transaction can pay at most this many recipients (ZIP-218): crates/drop-zcash/src/builder.rs. */
const MAX_RECIPIENTS_PER_TRANSACTION = 330;
/** The largest list the operator reads: crates/drop-core/src/import.rs. */
const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
const U32_MAX = 4_294_967_295;

interface Reply {
  status: number;
  body: unknown;
}

const reply = (status: number, body: unknown): Reply => ({ status, body });
const failure = (status: number, code: string, message: string, details: Record<string, unknown> = {}): Reply =>
  reply(status, { error: { code, message, ...details } });
const notFound = (what: string): Reply => failure(404, "not_found", `${what} not found`);

const CAMPAIGN_ID = /^[A-Za-z0-9._-]{1,64}$/u;
const OUTPOINT = /^([0-9a-f]{64}):(0|[1-9][0-9]{0,9})$/u;
const ZATOSHI = /^(0|[1-9][0-9]{0,19})$/u;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Exactly these keys and no others, as the operator's request bodies are (`deny_unknown_fields`). */
const hasExactlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const BAD_BODY = failure(400, "invalid_body", "the request body has missing, extra or mistyped fields");

const isFundingSource = (value: unknown): value is FundingSource =>
  typeof value === "string" && (FUNDING_SOURCES as readonly string[]).includes(value);

type Body = { ok: true; value: unknown } | { ok: false; reply: Reply };

function readBody(init: RequestInit): Body {
  const type = new Headers(init.headers).get("content-type") ?? "";
  if (!/^application\/json\b/iu.test(type)) return { ok: false, reply: failure(415, "unsupported_media_type", "send the body as application/json") };
  try {
    return { ok: true, value: JSON.parse(typeof init.body === "string" ? init.body : "") as unknown };
  } catch {
    return { ok: false, reply: failure(400, "invalid_body", "the request body is not valid JSON") };
  }
}

// eslint-disable-next-line no-control-regex -- detecting control characters is the point
const hasControlCharacter = (text: string): boolean => /[\u0000-\u001f\u007f-\u009f]/u.test(text);

export class PracticeServer {
  readonly #random: RandomBytes;
  readonly #now: () => number;
  readonly #campaigns = new Map<string, Campaign>();
  readonly #scheduler = new Scheduler();
  readonly #streams = new Set<OpenStream>();

  constructor(random: RandomBytes, now: () => number) {
    this.#random = random;
    this.#now = now;
  }

  /** Stop everything that is running, close every stream and forget every campaign. */
  dispose(): void {
    this.#scheduler.stop();
    for (const stream of this.#streams) stream.close();
    this.#streams.clear();
    this.#campaigns.clear();
  }

  /** The answer to one call, as a `Response`, the way `fetch` would give it. It takes a turn of the event loop, as the network does. */
  async answer(path: string, init: RequestInit): Promise<Response> {
    activity.requests += 1;
    const refuseIfCancelled = (): void => {
      if (init.signal?.aborted === true) throw new DOMException("The operation was aborted.", "AbortError");
    };
    refuseIfCancelled();
    await Promise.resolve();
    refuseIfCancelled();

    const result = this.#route((init.method ?? "GET").toUpperCase(), path, init);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "Content-Type": "application/json" } });
  }

  // ---- routing ---------------------------------------------------------------------------------------

  #route(method: string, path: string, init: RequestInit): Reply | Response {
    const cut = path.indexOf("?");
    const pathname = cut === -1 ? path : path.slice(0, cut);
    const query = cut === -1 ? "" : path.slice(cut + 1);
    const parts = pathname.split("/").filter((part) => part !== "");
    const [first, second, third] = parts;

    if (method === "GET" && parts.length === 1 && first === "health") return reply(200, { ok: true, network: "testnet", mock: true });
    if (first === "v1") return this.#verifier(method, parts, query);

    // Everything else is the operator's, and needs its token.
    if (new Headers(init.headers).get("authorization") !== `Bearer ${PRACTICE_TOKEN}`) {
      return failure(401, "unauthorized", "a valid bearer token is required");
    }
    if (first === "campaigns") {
      if (parts.length === 1 && method === "GET") return reply(200, [...this.#campaigns.values()].map(summaryView));
      if (parts.length === 1 && method === "POST") return this.#create(init);
      if (second !== undefined && (parts.length === 2 || (parts.length === 3 && third !== undefined))) {
        const action = third ?? "";
        if (method === "GET" && action === "") return this.#withCampaign(second, (campaign) => reply(200, campaignView(campaign)));
        if (method === "GET" && action === "receipt") return this.#withCampaign(second, (campaign) => this.#receipt(campaign));
        if (method === "GET" && action === "events") return this.#events(second, init);
        if (method === "GET" && action === "audit-ufvk-export") return failure(409, "not_available", "the mock chain has no real viewing keys");
        if (method === "GET" && action === "payslips") return failure(409, "not_available", "the mock chain has no real transactions to prove");
        if (method === "POST" && action === "fund-observed") return this.#withCampaign(second, (campaign) => this.#fund(campaign, init));
        if (method === "POST" && action === "check-funding") {
          return CAMPAIGN_ID.test(decode(second)) ? failure(409, "not_applicable", "this chain backend has no funding addresses; declare the deposit with fund-observed") : notFound("campaign");
        }
        if (method === "POST" && action === "start") return this.#withCampaign(second, (campaign) => this.#start(campaign));
      }
    }
    return failure(404, "not_found", "route not found");
  }

  #withCampaign(rawId: string, then: (campaign: Campaign) => Reply): Reply {
    const id = decode(rawId);
    const campaign = CAMPAIGN_ID.test(id) ? this.#campaigns.get(id) : undefined;
    return campaign === undefined ? notFound("campaign") : then(campaign);
  }

  // ---- the operator's routes ----------------------------------------------------------------------------

  /** `POST /campaigns`: read the list once, plan it, keep the plan. The checks come in the operator's own order. */
  #create(init: RequestInit): Reply {
    const read = readBody(init);
    if (!read.ok) return read.reply;
    const body = read.value;
    if (!isPlainObject(body) || !hasExactlyKeys(body, ["name", "csv", "max_outputs_per_batch", "fee_policy"])) return BAD_BODY;
    const { name, csv, max_outputs_per_batch: maxOutputs, fee_policy: policy } = body;
    if (typeof name !== "string" || typeof csv !== "string") return BAD_BODY;
    if (typeof maxOutputs !== "number" || !Number.isSafeInteger(maxOutputs) || maxOutputs < 0) return BAD_BODY;
    if (policy !== "zip317_text" && policy !== "zebra_main") return BAD_BODY;

    const trimmed = name.trim();
    if (trimmed === "" || [...trimmed].length > 100 || hasControlCharacter(trimmed)) {
      return failure(422, "invalid_name", "the campaign name must be 1 to 100 characters without control characters");
    }
    if (maxOutputs > MAX_RECIPIENTS_PER_TRANSACTION) {
      return failure(
        422,
        "batch_size_too_large",
        `max_outputs_per_batch is ${String(maxOutputs)} but one transaction can pay at most ${String(MAX_RECIPIENTS_PER_TRANSACTION)} recipients`,
      );
    }
    if (new TextEncoder().encode(csv).length > MAX_IMPORT_BYTES) return failure(413, "csv_too_large", "the CSV is too large");

    const report = importCsv(csv);
    if (report.errors.length > 0) {
      return failure(422, "import_failed", `the CSV has ${String(report.errors.length)} problem(s); fix them and try again`, {
        error_count: report.errors.length,
        errors: report.errors.slice(0, MAX_REPORTED_ROW_ERRORS),
      });
    }
    const planned = planCampaign(report.rows, maxOutputs, policy);
    if (!planned.ok) return failure(422, "plan_failed", planned.message);

    let id = practiceCampaignId(this.#random);
    while (this.#campaigns.has(id)) id = practiceCampaignId(this.#random);
    const campaign: Campaign = {
      id,
      name: trimmed,
      createdAt: this.#now(),
      policy,
      maxOutputs,
      plan: planned.plan,
      commitment: practiceHex32(this.#random),
      funding: null,
      states: planned.plan.batches.map(() => ({ name: "planned" as const })),
      run: "idle",
      events: [],
      listeners: new Set(),
    };
    this.#campaigns.set(id, campaign);
    return reply(201, campaignView(campaign));
  }

  /** `POST /campaigns/{id}/fund-observed`: the pretend deposit, which the practice chain takes on trust. */
  #fund(campaign: Campaign, init: RequestInit): Reply {
    const read = readBody(init);
    if (!read.ok) return read.reply;
    const body = read.value;
    if (!isPlainObject(body)) return BAD_BODY;
    if (!hasExactlyKeys(body, ["outpoint", "amount"]) && !hasExactlyKeys(body, ["outpoint", "amount", "source"])) return BAD_BODY;
    const { outpoint, amount, source } = body;
    if (typeof outpoint !== "string" || typeof amount !== "string") return BAD_BODY;
    // Like the operator's `Option`: a null source is a deposit that says nothing.
    if (source !== undefined && source !== null && !isFundingSource(source)) return BAD_BODY;
    const at = OUTPOINT.exec(outpoint);
    if (at === null || !ZATOSHI.test(amount)) return BAD_BODY;
    const txid = at[1] ?? "";
    const vout = Number(at[2]);
    const zatoshi = BigInt(amount);
    if (vout > U32_MAX || zatoshi > MAX_MONEY) return BAD_BODY;

    // The operator spends one output of the deposit for each batch, one after the other from this one: so the deposit must cover
    // the plan, and the last of those outputs must still be a number it can write.
    if (zatoshi < campaign.plan.required) {
      return failure(422, "insufficient_funding", "the deposit does not cover the declared total plus fees", {
        required: campaign.plan.required.toString(),
        observed: zatoshi.toString(),
      });
    }
    if (vout + campaign.plan.batches.length - 1 > U32_MAX) {
      return failure(422, "invalid_outpoint", "the output index is too large for this plan");
    }
    const recorded = campaign.funding;
    if (recorded !== null && (recorded.txid !== txid || recorded.vout !== vout || recorded.amount !== zatoshi)) {
      return failure(409, "funding_conflict", "different funding is already recorded for this campaign", {
        recorded: { outpoint: `${recorded.txid}:${String(recorded.vout)}`, amount: recorded.amount.toString() },
      });
    }
    campaign.funding ??= { txid, vout, amount: zatoshi, source: null };
    // Like the operator, a declared source is taken (again) for the deposit on record.
    if (isFundingSource(source)) campaign.funding.source = source;
    return reply(200, campaignView(campaign));
  }

  /** `POST /campaigns/{id}/start`: begin the run, once. */
  #start(campaign: Campaign): Reply {
    if (campaign.funding === null) return failure(409, "not_funded", "record the funding deposit before starting");
    if (campaign.run !== "idle") return reply(202, { started: false, run: { state: campaign.run } });
    startRun(campaign, this.#scheduler, this.#random);
    return reply(202, { started: true, run: { state: "running" } });
  }

  /** `GET /campaigns/{id}/receipt`: the receipt the operator builds, once there is a deposit to spend from. */
  #receipt(campaign: Campaign): Reply {
    if (campaign.funding === null) return failure(409, "not_funded", "record the funding deposit first");
    return reply(200, operatorReceiptView(campaign, campaign.funding));
  }

  /** `GET /campaigns/{id}/events`: the run's story, told from the start and closed at its end. */
  #events(rawId: string, init: RequestInit): Reply | Response {
    const id = decode(rawId);
    const campaign = CAMPAIGN_ID.test(id) ? this.#campaigns.get(id) : undefined;
    if (campaign === undefined) return notFound("campaign");
    const stream = openEventStream(campaign, init.signal);
    this.#streams.add(stream);
    return stream.response;
  }

  // ---- the verifier's routes -----------------------------------------------------------------------------

  #verifier(method: string, parts: readonly string[], query: string): Reply {
    const [, route] = parts;
    if (parts.length === 2 && method === "GET" && route === "receipt") {
      const link = parseReceiptLink(new URLSearchParams(query));
      if (!link.ok) return failure(400, "invalid_query", "the request is not a receipt link this verifier reads");
      if (link.query.network !== "testnet") {
        return failure(400, "network_not_configured", "this verifier is not configured for that network");
      }
      const receipt = receiptFromQuery(this.#campaigns.values(), link.query);
      // A transaction it did not hand out is one it cannot read: there is no chain here to ask.
      return receipt === null ? failure(409, PRACTICE_REFUSAL, "practice mode reads no chain, so it shows no receipt it did not make") : reply(200, receipt);
    }
    // The check of a payslip reads a chain, which practice mode has not got, so it says so and checks nothing.
    if (parts.length === 2 && method === "POST" && route === "payslip") {
      return failure(409, PRACTICE_REFUSAL, "practice mode reads no chain, so it checks no payslip");
    }
    return failure(404, "not_found", "no such route");
  }
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return "";
  }
}
