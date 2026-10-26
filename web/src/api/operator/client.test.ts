// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixtureJson } from "@/test/operator-fixtures";
import { FIXTURE_CAMPAIGN_ID, installFakeOperator, replyWith, replyWithGolden } from "@/test/fake-operator";

import {
  checkFunding,
  createCampaign,
  DISCLOSURE_ACKNOWLEDGEMENT,
  DISCLOSURE_HEADER,
  exportViewingKey,
  getCampaign,
  getCampaignReceipt,
  getHealth,
  getNearStatus,
  getNearTokens,
  listCampaigns,
  NEAR_CONFIRM_ACKNOWLEDGEMENT,
  NEAR_CONFIRM_HEADER,
  OperatorApiError,
  postNearDryQuote,
  postNearLiveQuote,
  postNearPreview,
  recordFunding,
  startCampaign,
} from "./client";
import { adoptTokenFromLocation, clearSession, getToken, useSession } from "./session";

const TOKEN = "ab".repeat(32);

function signIn() {
  adoptTokenFromLocation({ hash: `#token=${TOKEN}`, pathname: "/", search: "" }, { replaceState: () => undefined, state: null });
}

beforeEach(() => {
  clearSession();
  signIn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
});

const failureOf = async (promise: Promise<unknown>): Promise<OperatorApiError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OperatorApiError) return error;
    throw error;
  }
  throw new Error("expected an OperatorApiError");
};

// covers: REQ-OPS-002
describe("the bearer token", () => {
  it("is sent as a header on every protected call, and never in a URL", async () => {
    const fake = installFakeOperator({
      "GET /api/campaigns": () => replyWith("campaigns-list.json"),
      "GET /api/campaigns/:id": () => replyWith("campaign-funded.json"),
      "GET /api/campaigns/:id/receipt": () => replyWith("receipt-settled.json"),
      "POST /api/campaigns/:id/start": () => replyWith("start-ok.json", 202),
      "POST /api/campaigns/:id/fund-observed": () => replyWith("fund-ok.json"),
      "POST /api/campaigns": () => replyWith("create-valid.json", 201),
    });
    await listCampaigns();
    await getCampaign(FIXTURE_CAMPAIGN_ID);
    await getCampaignReceipt(FIXTURE_CAMPAIGN_ID);
    await startCampaign(FIXTURE_CAMPAIGN_ID);
    await recordFunding(FIXTURE_CAMPAIGN_ID, { outpoint: { txid: "cd".repeat(32), vout: 0 }, amount: "1" });
    await createCampaign({ name: "x", csv: "address,amount\n", maxOutputsPerBatch: 3, feePolicy: "zip317_text" });

    expect(fake.calls).toHaveLength(6);
    for (const call of fake.calls) {
      expect(call.headers.get("authorization"), `${call.method} ${call.path}`).toBe(`Bearer ${TOKEN}`);
      expect(call.path).not.toContain(TOKEN);
    }
  });

  it("health needs no token, and none is sent", async () => {
    const fake = installFakeOperator({ "GET /api/health": () => replyWith("health.json") });
    clearSession();
    await expect(getHealth()).resolves.toEqual({ network: "testnet", mock: true });
    expect(fake.calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("without a token a protected call fails before touching the network", async () => {
    const fake = installFakeOperator({});
    clearSession();
    const error = await failureOf(listCampaigns());
    expect(error.kind).toBe("no_token");
    expect(fake.calls).toHaveLength(0);
  });

  it("a 401 forgets the token and marks the session rejected", async () => {
    installFakeOperator({ "GET /api/campaigns": () => replyWith("unauthorized-wrong-token.json", 401) });
    const error = await failureOf(listCampaigns());
    expect(error.kind).toBe("unauthorized");
    expect(getToken()).toBeNull();
    expect(useSession.getState().status).toBe("rejected");
  });
});

describe("results", () => {
  it("returns parsed views, not raw JSON", async () => {
    installFakeOperator({
      "GET /api/campaigns/:id": () => replyWith("campaign-settled.json"),
      "GET /api/campaigns/:id/receipt": () => replyWith("receipt-settled.json"),
      "POST /api/campaigns/:id/start": () => replyWith("start-ok.json", 202),
    });
    const campaign = await getCampaign(FIXTURE_CAMPAIGN_ID);
    expect(campaign.declaredTotal).toBe("1162500000");
    expect(campaign.manifestCommitment).toMatch(/^[0-9a-f]{64}$/u);
    expect((await getCampaignReceipt(FIXTURE_CAMPAIGN_ID)).findings).toEqual([]);
    expect(await startCampaign(FIXTURE_CAMPAIGN_ID)).toEqual({ started: true, run: { state: "running" } });
  });
});

describe("failures", () => {
  it("API errors keep the operator's code, message and details", async () => {
    installFakeOperator({
      "POST /api/campaigns/:id/fund-observed": () => replyWith("fund-insufficient.json", 422),
      "POST /api/campaigns/:id/start": () => replyWith("start-not-funded.json", 409),
    });
    const funding = await failureOf(
      recordFunding(FIXTURE_CAMPAIGN_ID, { outpoint: { txid: "cd".repeat(32), vout: 0 }, amount: "1000" }),
    );
    expect(funding).toMatchObject({ kind: "api", status: 422, api: { code: "insufficient_funding", required: "1162535000" } });

    const start = await failureOf(startCampaign(FIXTURE_CAMPAIGN_ID));
    expect(start.api?.code).toBe("not_funded");
  });

  it("CSV problems arrive as line-numbered row errors", async () => {
    installFakeOperator({ "POST /api/campaigns": () => replyWith("create-row-errors.json", 422) });
    const error = await failureOf(createCampaign({ name: "x", csv: "stale", maxOutputsPerBatch: 3, feePolicy: "zip317_text" }));
    expect(error.api).toMatchObject({ code: "import_failed", errorCount: 15 });
    expect(error.api && "errors" in error.api && error.api.errors[0]).toMatchObject({ line: 3, code: "invalid_address" });
  });

  it("an unreachable operator is its own kind", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    expect((await failureOf(listCampaigns())).kind).toBe("unreachable");
  });

  it("a cancelled request is NOT reported as the operator being down", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new DOMException("aborted", "AbortError"))));
    const controller = new AbortController();
    controller.abort();
    await expect(listCampaigns(controller.signal)).rejects.not.toBeInstanceOf(OperatorApiError);
  });

  it("a body that is not JSON, or not the expected shape, is an invalid response", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("<html>", { status: 200 }))));
    expect((await failureOf(listCampaigns())).kind).toBe("invalid_response");

    installFakeOperator({ "GET /api/campaigns": () => ({ body: [{ id: "c-000000000001", recipients: ["u1x"] }] }) });
    expect((await failureOf(listCampaigns())).kind).toBe("invalid_response");
  });

  it("a response carrying a recipient field is refused as a whole", async () => {
    const leaked = { ...(fixtureJson("campaign-settled.json") as object), recipients: [{ address: "u1x" }] };
    installFakeOperator({ "GET /api/campaigns/:id": () => ({ body: leaked }) });
    expect((await failureOf(getCampaign(FIXTURE_CAMPAIGN_ID))).kind).toBe("invalid_response");
  });

  it("an error body in an unknown shape is still an error with its status, not a crash", async () => {
    installFakeOperator({ "GET /api/campaigns": () => ({ status: 500, body: { oops: true } }) });
    const error = await failureOf(listCampaigns());
    expect(error).toMatchObject({ kind: "api", status: 500, api: null });
  });

  it("an error that is not JSON at all (a proxy page, a plain refusal) is the same", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("<html>Misdirected Request</html>", { status: 421 }))));
    expect(await failureOf(listCampaigns())).toMatchObject({ kind: "api", status: 421, api: null });
  });

  it("an unknown error code keeps its code and message and drops what else it carries", async () => {
    installFakeOperator({
      "GET /api/campaigns": () => ({
        status: 422,
        body: { error: { code: "too_many_outputs", message: "a batch may hold at most 330 outputs", limit: 330, secret: "x" } },
      }),
    });
    const error = await failureOf(listCampaigns());
    expect(error).toMatchObject({ kind: "api", status: 422, api: { code: "too_many_outputs", message: "a batch may hold at most 330 outputs" } });
    expect(JSON.stringify(error.api)).not.toContain("secret");
  });

  it("a KNOWN error code with an unexpected extra is still refused as a bad envelope", async () => {
    installFakeOperator({
      "GET /api/campaigns/:id": () => ({ status: 404, body: { error: { code: "not_found", message: "campaign not found", extra: 1 } } }),
    });
    expect(await failureOf(getCampaign(FIXTURE_CAMPAIGN_ID))).toMatchObject({ kind: "api", status: 404, api: null });
  });
});

describe("requests", () => {
  it("create sends the documented body, with snake_case keys", async () => {
    const fake = installFakeOperator({ "POST /api/campaigns": () => replyWith("create-valid.json", 201) });
    await createCampaign({ name: "Spring", csv: "address,amount\nu1x,1\n", maxOutputsPerBatch: 50, feePolicy: "zebra_main" });
    expect(fake.calls[0]?.body).toEqual({
      name: "Spring",
      csv: "address,amount\nu1x,1\n",
      max_outputs_per_batch: 50,
      fee_policy: "zebra_main",
    });
    expect(fake.calls[0]?.headers.get("content-type")).toBe("application/json");
  });

  it("funding sends the outpoint as 'txid:vout'", async () => {
    const fake = installFakeOperator({ "POST /api/campaigns/:id/fund-observed": () => replyWith("fund-ok.json") });
    await recordFunding(FIXTURE_CAMPAIGN_ID, { outpoint: { txid: "cd".repeat(32), vout: 2 }, amount: "1162535000" });
    expect(fake.calls[0]?.body).toEqual({ outpoint: `${"cd".repeat(32)}:2`, amount: "1162535000" });
  });

  it("an id that could climb out of the path is refused before any request", async () => {
    const fake = installFakeOperator({});
    for (const bad of ["../health", "a/b", "", "x".repeat(65), "c-1?x=1", "c 1"]) {
      expect((await failureOf(getCampaign(bad))).status).toBe(404);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("never sends cookies, caches, or a referrer", async () => {
    installFakeOperator({ "GET /api/campaigns": () => replyWith("campaigns-empty.json") });
    await listCampaigns();
    const init = (vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init).toMatchObject({ credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
  });
});

describe("checking for the deposit (real chain)", () => {
  it("POSTs to check-funding and returns the campaign", async () => {
    const fake = installFakeOperator({ "POST /api/campaigns/:id/check-funding": () => replyWith("campaign-funded.json") });
    const campaign = await checkFunding(FIXTURE_CAMPAIGN_ID);
    expect(campaign.funding).not.toBeNull();
    expect(fake.calls[0]).toMatchObject({ method: "POST", path: `/api/campaigns/${FIXTURE_CAMPAIGN_ID}/check-funding` });
    expect(fake.calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("the mock chain's answer is a 409 that keeps its code", async () => {
    installFakeOperator({ "POST /api/campaigns/:id/check-funding": () => replyWith("check-funding-mock.json", 409) });
    expect((await failureOf(checkFunding(FIXTURE_CAMPAIGN_ID))).api?.code).toBe("not_applicable");
  });
});

describe("the viewing key", () => {
  const body = { warning: "W", campaign_id: FIXTURE_CAMPAIGN_ID, network: "testnet", ufvk: "uviewtest1abc" };

  it("is asked for with the disclosure acknowledgement header, and returned to the caller", async () => {
    const fake = installFakeOperator({ "GET /api/campaigns/:id/audit-ufvk-export": () => ({ body }) });
    const key = await exportViewingKey(FIXTURE_CAMPAIGN_ID);
    expect(key).toEqual({ warning: "W", campaignId: FIXTURE_CAMPAIGN_ID, network: "testnet", ufvk: "uviewtest1abc" });
    expect(fake.calls[0]?.headers.get(DISCLOSURE_HEADER)).toBe(DISCLOSURE_ACKNOWLEDGEMENT);
    expect(DISCLOSURE_ACKNOWLEDGEMENT).toBe("I-UNDERSTAND");
    expect(fake.calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("the header is sent only for the key, on no other call", async () => {
    const fake = installFakeOperator({
      "GET /api/campaigns/:id": () => replyWith("campaign-funded.json"),
      "POST /api/campaigns/:id/start": () => replyWith("start-ok.json", 202),
    });
    await getCampaign(FIXTURE_CAMPAIGN_ID);
    await startCampaign(FIXTURE_CAMPAIGN_ID);
    for (const call of fake.calls) expect(call.headers.get(DISCLOSURE_HEADER)).toBeNull();
  });

  it("the mock chain refuses with not_available, whether or not the header was sent", async () => {
    installFakeOperator({ "GET /api/campaigns/:id/audit-ufvk-export": () => replyWith("export-ufvk-mock.json", 409) });
    const error = await failureOf(exportViewingKey(FIXTURE_CAMPAIGN_ID));
    expect(error).toMatchObject({ kind: "api", status: 409, api: { code: "not_available" } });
  });

  it("a response with an extra field is refused, not trimmed", async () => {
    installFakeOperator({ "GET /api/campaigns/:id/audit-ufvk-export": () => ({ body: { ...body, seed: "x" } }) });
    expect((await failureOf(exportViewingKey(FIXTURE_CAMPAIGN_ID))).kind).toBe("invalid_response");
  });

  it("the key is not in the error when the call fails", async () => {
    installFakeOperator({ "GET /api/campaigns/:id/audit-ufvk-export": () => ({ status: 500, body: { error: { code: "internal_error", message: "the operator hit an internal error" } } }) });
    const error = await failureOf(exportViewingKey(FIXTURE_CAMPAIGN_ID));
    expect(JSON.stringify({ message: error.message, api: error.api })).not.toContain("uview");
  });
});

describe("the NEAR calls", () => {
  const routes = () =>
    installFakeOperator({
      "GET /api/near/tokens": () => replyWithGolden("near-tokens.json"),
      "POST /api/near/preview": () => replyWithGolden("near-preview.json"),
      "POST /api/campaigns/:id/funding/near/dry-quote": () => replyWithGolden("near-dry-quote.json"),
      "POST /api/campaigns/:id/funding/near/live-quote": () => replyWithGolden("near-live-quote.json"),
      "GET /api/campaigns/:id/funding/near/status": () => replyWithGolden("near-status-pending-deposit.json"),
    });

  it("ask the operator, carrying the token, with the bodies the operator expects", async () => {
    const fake = routes();
    const tokens = await getNearTokens();
    expect(tokens.length).toBeGreaterThan(0);
    const preview = await postNearPreview({ originAssetId: tokens[0]?.id ?? "", amountZat: "545000" });
    expect(preview.amountOut).toBe("545000");
    const dry = await postNearDryQuote(FIXTURE_CAMPAIGN_ID, { originAssetId: "nep141:usdc.near", refundTo: "refund-account.near" });
    expect(dry.validForSeconds).toBe(600);
    const status = await getNearStatus(FIXTURE_CAMPAIGN_ID);
    expect(status.status).toBe("pending_deposit");
    expect(status.campaignFunded).toBe(false);

    expect(fake.to("POST", "/api/near/preview")[0]?.body).toEqual({ origin_asset_id: tokens[0]?.id, amount_zat: "545000" });
    expect(fake.to("POST", /dry-quote$/u)[0]?.body).toEqual({ origin_asset_id: "nep141:usdc.near", refund_to: "refund-account.near" });
    for (const call of fake.calls) expect(call.headers.get("authorization"), call.path).toBe(`Bearer ${TOKEN}`);
  });

  it("send the acknowledgement header on the deposit-address call and on no other", async () => {
    const fake = routes();
    await getNearTokens();
    await postNearPreview({ originAssetId: "a", amountZat: "1" });
    await postNearDryQuote(FIXTURE_CAMPAIGN_ID, { originAssetId: "a", refundTo: "b" });
    await getNearStatus(FIXTURE_CAMPAIGN_ID);
    expect(fake.calls.every((c) => c.headers.get(NEAR_CONFIRM_HEADER) === null)).toBe(true);

    const live = await postNearLiveQuote(FIXTURE_CAMPAIGN_ID);
    expect(live.depositAddress.length).toBeGreaterThan(0);
    const call = fake.to("POST", /live-quote$/u)[0];
    expect(call?.headers.get(NEAR_CONFIRM_HEADER)).toBe(NEAR_CONFIRM_ACKNOWLEDGEMENT);
    expect(call?.body).toBeUndefined();
  });

  it("refuse an id that is not a campaign id, before anything is sent", async () => {
    const fake = routes();
    const error = await failureOf(getNearStatus("../x"));
    expect(error.status).toBe(404);
    expect(fake.calls).toHaveLength(0);
  });

  it("report the operator's refusal with its code", async () => {
    installFakeOperator({
      "POST /api/campaigns/:id/funding/near/live-quote": () => ({ status: 400, body: { error: { code: "confirmation_required", message: "x", warning: "w" } } }),
    });
    const error = await failureOf(postNearLiveQuote(FIXTURE_CAMPAIGN_ID));
    expect(error.kind).toBe("api");
    expect(error.api?.code).toBe("confirmation_required");
  });

  it("report an answer that is not in the shape the page accepts as invalid, never as data", async () => {
    installFakeOperator({
      "GET /api/campaigns/:id/funding/near/status": () => ({ body: { status: "funded", step: "await_deposit" } }),
    });
    const error = await failureOf(getNearStatus(FIXTURE_CAMPAIGN_ID));
    expect(error.kind).toBe("invalid_response");
  });
});
