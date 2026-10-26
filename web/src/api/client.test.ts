import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiUrl, fetchJson } from "./client";

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
