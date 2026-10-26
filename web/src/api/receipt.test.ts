import { afterEach, describe, expect, it, vi } from "vitest";

import { RECEIPT_ENDPOINT } from "./endpoints";
import { fetchReceipt, mapFailure, ReceiptFetchError, type ReceiptFailureKind } from "./receipt";
import type { ReceiptQuery } from "./receipt-query";

const query: ReceiptQuery = {
  network: "testnet",
  txids: ["a".repeat(64), "b".repeat(64)],
  commitment: "e".repeat(64),
  declaredTotal: "485000000",
};

const wireReceipt = {
  campaign_id: "camp-01",
  network: "testnet",
  funding_address: null,
  declared_total: "485000000",
  fee_total: "20000",
  batches: [
    {
      index: 0,
      txid: "a".repeat(64),
      funding_input: `${"c".repeat(64)}:0`,
      net_into_pool: "485000000",
      fee: "20000",
      shielded_actions: 3,
      pool: "ironwood",
      confirmations: 5,
    },
  ],
  manifest_commitment: "e".repeat(64),
  phase: { phase: "settled" },
  findings: [],
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

async function failureOf(promise: Promise<unknown>): Promise<ReceiptFetchError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof ReceiptFetchError) return e;
    throw e;
  }
  throw new Error("expected a ReceiptFetchError");
}

describe("the request", () => {
  it("is a credential-free GET to the one endpoint, with the link's parameters", async () => {
    const fetchMock = respond(200, wireReceipt);
    await fetchReceipt(query);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      `/api${RECEIPT_ENDPOINT}?network=testnet&tx=${query.txids[0]}&tx=${query.txids[1]}` +
        `&commitment=${query.commitment}&declared_total=485000000`,
    );
    expect(init).toMatchObject({
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    expect(new Headers(init?.headers).get("accept")).toBe("application/json");
  });

  it("sends nothing that could be recipient data (only the four link fields)", async () => {
    const fetchMock = respond(200, wireReceipt);
    await fetchReceipt(query);
    const [url] = fetchMock.mock.calls[0] ?? [];
    const names = [...new URL(String(url), "http://x").searchParams.keys()];
    expect([...new Set(names)].sort()).toEqual(["commitment", "declared_total", "network", "tx"]);
  });
});

describe("a good answer", () => {
  it("is validated and mapped to the view", async () => {
    respond(200, wireReceipt);
    const receipt = await fetchReceipt(query);
    expect(receipt.campaignId).toBe("camp-01");
    expect(receipt.batches[0]?.shieldedActions).toBe(3);
    expect(receipt.phase).toEqual({ phase: "settled" });
  });
});

describe("failures are sorted into kinds", () => {
  const statuses: [number, ReceiptFailureKind][] = [
    [404, "not_found"],
    [400, "rejected"],
    [422, "rejected"],
    [429, "unreachable"],
    [500, "unreachable"],
    [502, "unreachable"],
    [503, "unreachable"],
    [418, "unreachable"],
  ];

  it.each(statuses)("HTTP %i is %s", async (status, kind) => {
    respond(status, { anything: true });
    const error = await failureOf(fetchReceipt(query));
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(mapFailure(status)).toBe(kind);
  });

  it("a network error is unreachable", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    expect((await failureOf(fetchReceipt(query))).kind).toBe("unreachable");
  });

  it("a body that is not JSON is an invalid response", async () => {
    respond(200, "<html>not json</html>");
    expect((await failureOf(fetchReceipt(query))).kind).toBe("invalid_response");
  });

  it("a receipt that breaks the strict schema is an invalid response", async () => {
    respond(200, { ...wireReceipt, recipients: ["u1leak"] });
    expect((await failureOf(fetchReceipt(query))).kind).toBe("invalid_response");
  });

  it("the error message never contains what the verifier sent", async () => {
    respond(200, { ...wireReceipt, memo: "sentinel-memo-text" });
    const error = await failureOf(fetchReceipt(query));
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain("sentinel-memo-text");
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
    const outcome = failureOf(fetchReceipt(query, { timeoutMs: 5_000 }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await outcome).kind).toBe("unreachable");
  });

  it("cancelling from outside is NOT reported as a failure of the verifier", async () => {
    hang();
    const controller = new AbortController();
    const outcome = fetchReceipt(query, { signal: controller.signal });
    controller.abort();
    await expect(outcome).rejects.toMatchObject({ name: "AbortError" });
  });

  it("an already-cancelled signal never starts a request", async () => {
    const fetchMock = hang();
    const controller = new AbortController();
    controller.abort();
    const outcome = await fetchReceipt(query, { signal: controller.signal }).catch((e: unknown) => e);
    expect(outcome).not.toBeInstanceOf(ReceiptFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
