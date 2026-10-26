import { afterEach, describe, expect, it, vi } from "vitest";

import { PAYSLIP_ENDPOINT } from "./endpoints";
import { checkPayslip, mapFailure, PayslipFetchError, type PayslipFailureKind } from "./payslip";
import { PAYSLIP_NOT_PROVEN } from "./payslip-answer";
import { payslipBody, readPayslip, type Payslip } from "./payslip-input";

const TXID = "6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955";
const RECEIVER = "380decb3bc9fd833dc528ebb455958f71a626c2ea66b9a48f6a9750dbb5c66665571e614426d42d92e6310";
const RSEED = "71b88bf428e8edfa6f17d9196ddd697c3ab400a467ce07093df9da929f9e7ecb";

const payslip: Payslip = { version: 1, network: "testnet", txid: TXID, action: 5, receiver: RECEIVER, value: "90000", rseed: RSEED };

const wireAnswer = {
  network: "testnet",
  txid: TXID,
  action: 5,
  verdict: "verified",
  reason: null,
  confirmations: 19,
  required_depth: 3,
  ironwood_actions: 8,
  not_proven: [...PAYSLIP_NOT_PROVEN],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const stubFetch = (impl: (url: string, init: RequestInit) => Promise<Response>) => {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
};

const respond = (status: number, body: unknown = "") =>
  stubFetch(() =>
    Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status })),
  );

async function failureOf(promise: Promise<unknown>): Promise<PayslipFetchError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof PayslipFetchError) return e;
    throw e;
  }
  throw new Error("expected a PayslipFetchError");
}

/** The body of a call to fetch, which must have been text. */
function bodyOf(call: [string, RequestInit] | undefined): string {
  const body = call?.[1].body;
  if (typeof body !== "string") throw new Error("expected the body to be text");
  return body;
}

const refusal = (code: unknown) => ({ error: { code, message: "words the page must not keep" } });

// covers: REQ-VER-006
describe("the request", () => {
  it("is a credential-free POST of JSON to the one endpoint, that follows no redirect", async () => {
    const fetchMock = respond(200, wireAnswer);
    await checkPayslip(payslip);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api${PAYSLIP_ENDPOINT}`);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      redirect: "error",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("has the payslip, and exactly the payslip, as its body", async () => {
    const fetchMock = respond(200, wireAnswer);
    await checkPayslip(payslip);
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body).toBe(payslipBody(payslip));
    expect(JSON.parse(body)).toEqual(payslip);
    expect(Object.keys(JSON.parse(body) as object)).toEqual([
      "version",
      "network",
      "txid",
      "action",
      "receiver",
      "value",
      "rseed",
    ]);
  });

  it("puts nothing of the payslip in the address, or anywhere but the body", async () => {
    const fetchMock = respond(200, wireAnswer);
    await checkPayslip(payslip);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).not.toMatch(/[?#]/u);
    for (const secret of [TXID, RECEIVER, RSEED, "90000"]) {
      expect(String(url)).not.toContain(secret);
      expect(JSON.stringify({ ...init, body: undefined }), "the options").not.toContain(secret);
    }
  });

  it("is one request, however it ends", async () => {
    for (const status of [200, 400, 413, 503]) {
      const fetchMock = respond(status, status === 200 ? wireAnswer : refusal("x"));
      await checkPayslip(payslip).catch(() => undefined);
      expect(fetchMock, String(status)).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    }
  });
});

describe("a good answer", () => {
  it("is validated and mapped to the view", async () => {
    respond(200, wireAnswer);
    const answer = await checkPayslip(payslip);
    expect(answer.outcome).toEqual({ verdict: "verified", confirmations: 19, ironwoodActions: 8 });
    expect(answer.requiredDepth).toBe(3);
    expect(answer.notProven).toEqual(PAYSLIP_NOT_PROVEN);
  });

  it("is also an answer when the payslip does not match: that is a verdict, not a failure", async () => {
    respond(200, { ...wireAnswer, verdict: "invalid", reason: "does_not_match", confirmations: null, ironwood_actions: null });
    expect((await checkPayslip(payslip)).outcome).toEqual({ verdict: "invalid", reason: "does_not_match" });
  });
});

describe("failures are sorted into kinds", () => {
  const cases: [status: number, code: string | null, kind: PayslipFailureKind][] = [
    [413, "payload_too_large", "too_large"],
    [413, null, "too_large"],
    [409, "practice_mode", "practice"],
    [409, "something_else", "unreachable"],
    [409, null, "unreachable"],
    [400, "invalid_payslip", "rejected"],
    [400, "viewing_key_refused", "rejected"],
    [400, null, "rejected"],
    [400, "network_not_configured", "network_not_served"],
    [422, "anything", "rejected"],
    [503, "chain_unavailable", "chain_unavailable"],
    [502, "chain_inconsistent", "chain_unavailable"],
    [503, "overloaded", "unreachable"],
    [503, null, "unreachable"],
    [502, null, "unreachable"],
    [504, null, "unreachable"],
    [500, "internal_error", "unreachable"],
    [404, "not_found", "unreachable"],
    [405, null, "unreachable"],
    [429, null, "unreachable"],
    [401, null, "unreachable"],
    [418, null, "unreachable"],
  ];

  it.each(cases)("HTTP %i with the code %s is %s", async (status, code, kind) => {
    respond(status, code === null ? "" : refusal(code));
    const error = await failureOf(checkPayslip(payslip));
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(mapFailure(status, code)).toBe(kind);
  });

  it("only the codes that change what a refusal means are read, and only where they can", () => {
    // The same code on another status is sorted by the status alone.
    expect(mapFailure(404, "network_not_configured")).toBe("unreachable");
    expect(mapFailure(500, "chain_unavailable")).toBe("unreachable");
    expect(mapFailure(400, "chain_unavailable")).toBe("rejected");
    expect(mapFailure(503, "network_not_configured")).toBe("unreachable");
    // Practice mode's refusal is only that on the status it is given with.
    expect(mapFailure(400, "practice_mode")).toBe("rejected");
    expect(mapFailure(500, "practice_mode")).toBe("unreachable");
  });

  it.each([
    ["an empty body", ""],
    ["text that is not JSON", "<html>bad gateway</html>"],
    ["JSON without an error", {}],
    ["an error without a code", { error: { message: "x" } }],
    ["a code that is not text", refusal(7)],
    ["a code in the wrong place", { code: "network_not_configured" }],
  ])("a 400 with %s is simply rejected", async (_label, body) => {
    respond(400, body);
    expect((await failureOf(checkPayslip(payslip))).kind).toBe("rejected");
  });

  it("a network error is unreachable", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    expect((await failureOf(checkPayslip(payslip))).kind).toBe("unreachable");
  });

  it("a redirect, which the request refuses to follow, is unreachable too", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch: redirect mode is set to error")));
    expect((await failureOf(checkPayslip(payslip))).kind).toBe("unreachable");
  });

  it("a body that is not JSON is an invalid response", async () => {
    respond(200, "<html>not json</html>");
    expect((await failureOf(checkPayslip(payslip))).kind).toBe("invalid_response");
  });

  it("an answer that breaks the strict schema is an invalid response", async () => {
    respond(200, { ...wireAnswer, receiver: RECEIVER });
    expect((await failureOf(checkPayslip(payslip))).kind).toBe("invalid_response");
    respond(200, { ...wireAnswer, verdict: "pending" });
    expect((await failureOf(checkPayslip(payslip))).kind).toBe("invalid_response");
  });

  it.each([
    ["another transaction", { txid: "a".repeat(64) }],
    ["another network", { network: "mainnet" }],
    ["another action", { action: 6 }],
  ])("an answer about %s is no answer to this payslip", async (_what, change) => {
    respond(200, { ...wireAnswer, ...change });
    const error = await failureOf(checkPayslip(payslip));
    expect(error.kind).toBe("invalid_response");
    expect(error.status).toBe(200);
  });

  it("the error carries the kind and the status, and nothing the verifier or the payslip said", async () => {
    respond(400, refusal("network_not_configured"));
    const refused = await failureOf(checkPayslip(payslip));
    respond(200, { ...wireAnswer, memo: "sentinel-memo-text" });
    const strange = await failureOf(checkPayslip(payslip));
    for (const error of [refused, strange]) {
      const shown = `${error.message} ${JSON.stringify(error)} ${String(error.stack)}`;
      for (const secret of ["words the page must not keep", "sentinel-memo-text", RECEIVER, RSEED, "90000"]) {
        expect(shown).not.toContain(secret);
      }
    }
  });

  it("the payslip a person pasted survives the whole trip unchanged, as the same object", async () => {
    const read = readPayslip(JSON.stringify(payslip, null, 2));
    if (!read.ok) throw new Error("expected a payslip");
    const fetchMock = respond(200, wireAnswer);
    await checkPayslip(read.payslip);
    expect(JSON.parse(bodyOf(fetchMock.mock.calls[0]))).toEqual(payslip);
  });
});

describe("timeout and cancellation", () => {
  /** A fetch that never answers but honours its abort signal. */
  const hang = () =>
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

  it("a verifier that never answers becomes unreachable after the timeout", async () => {
    vi.useFakeTimers();
    hang();
    const outcome = failureOf(checkPayslip(payslip, { timeoutMs: 5_000 }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await outcome).kind).toBe("unreachable");
  });

  it("waits 15 seconds unless told otherwise", async () => {
    vi.useFakeTimers();
    hang();
    let settled = false;
    const outcome = failureOf(checkPayslip(payslip)).then((error) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await outcome).kind).toBe("unreachable");
  });

  it("cancelling from outside is NOT reported as a failure of the verifier", async () => {
    hang();
    const controller = new AbortController();
    const outcome = checkPayslip(payslip, { signal: controller.signal });
    controller.abort();
    await expect(outcome).rejects.toMatchObject({ name: "AbortError" });
  });

  it("an already-cancelled signal never starts a request", async () => {
    const fetchMock = hang();
    const controller = new AbortController();
    controller.abort();
    const outcome = await checkPayslip(payslip, { signal: controller.signal }).catch((e: unknown) => e);
    expect(outcome).not.toBeInstanceOf(PayslipFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
