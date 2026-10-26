import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiUrl, fetchJson, sendToApi } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stub fetch to resolve once with the given response. */
function stubFetch(response: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(response)),
  );
}

describe("apiUrl", () => {
  it("joins the base and an absolute path", () => {
    expect(apiUrl("/receipts/abc", "/api")).toBe("/api/receipts/abc");
    expect(apiUrl("/x", "https://verify.example.org/api")).toBe(
      "https://verify.example.org/api/x",
    );
  });

  it("rejects relative, protocol-relative and traversal paths", () => {
    expect(() => apiUrl("receipts", "/api")).toThrow(/start with/);
    expect(() => apiUrl("//evil.example/x", "/api")).toThrow(/start with/);
    expect(() => apiUrl("/a/../b", "/api")).toThrow(/\.\./);
  });
});

describe("fetchJson", () => {
  it("passes the parsed body through the validator", async () => {
    stubFetch(new Response(JSON.stringify({ n: 1 }), { status: 200 }));
    const out = await fetchJson("/thing", (u) => u as { n: number });
    expect(out).toEqual({ n: 1 });
  });

  it("propagates validator failures (the UI never sees unvalidated data)", async () => {
    stubFetch(new Response(JSON.stringify({ bad: true }), { status: 200 }));
    await expect(
      fetchJson("/thing", () => {
        throw new Error("schema mismatch");
      }),
    ).rejects.toThrow("schema mismatch");
  });

  it("throws ApiError with the status on non-2xx", async () => {
    stubFetch(new Response("nope", { status: 404 }));
    const err = await fetchJson("/thing", (u) => u).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  it("throws ApiError on a non-JSON body", async () => {
    stubFetch(new Response("<html>", { status: 200 }));
    await expect(fetchJson("/thing", (u) => u)).rejects.toThrow(/not valid JSON/);
  });
});

describe("sending a call", () => {
  const answer = (text: string) => () => Promise.resolve(new Response(text, { status: 200 }));

  it("goes to fetch, at the API's address", async () => {
    const fetched = vi.fn(answer("from the network"));
    vi.stubGlobal("fetch", fetched);
    const init = { method: "GET", headers: { Accept: "application/json" } };
    expect(await (await sendToApi("/health", init)).text()).toBe("from the network");
    expect(fetched).toHaveBeenCalledWith(apiUrl("/health"), init);
  });

  it("is fetch as it is when the call is made, not as it was when this file was loaded", async () => {
    const first = vi.fn(answer("first"));
    vi.stubGlobal("fetch", first);
    await sendToApi("/health", {});
    const second = vi.fn(answer("second"));
    vi.stubGlobal("fetch", second);
    expect(await (await sendToApi("/health", {})).text()).toBe("second");
    expect(first).toHaveBeenCalledTimes(1);
  });
});
