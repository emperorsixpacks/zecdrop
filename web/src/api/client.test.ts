import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiUrl, fetchJson, hasApiTransport, installApiTransport, sendToApi } from "./client";

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

// covers: REQ-DEMO-001
describe("the transport", () => {
  const answer = (text: string) => () => Promise.resolve(new Response(text, { status: 200 }));

  it("is the network until something takes its place: a call goes to fetch, at the API's address", async () => {
    const fetched = vi.fn(answer("from the network"));
    vi.stubGlobal("fetch", fetched);
    expect(hasApiTransport()).toBe(false);
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

  it("answers every call itself while one is installed, and never falls back to the network", async () => {
    const fetched = vi.fn(answer("from the network"));
    vi.stubGlobal("fetch", fetched);
    const uninstall = installApiTransport((path, init) => Promise.resolve(new Response(`${init.method ?? "GET"} ${path}`)));
    expect(hasApiTransport()).toBe(true);
    expect(await (await sendToApi("/campaigns?x=1", { method: "POST" })).text()).toBe("POST /campaigns?x=1");
    // Even a call that is not an API path is the transport's to answer, or to refuse: it is not sent anywhere else.
    await expect(sendToApi("/v1/receipt?network=testnet", {})).resolves.toBeInstanceOf(Response);
    expect(fetched).not.toHaveBeenCalled();

    uninstall();
    expect(hasApiTransport()).toBe(false);
    expect(await (await sendToApi("/health", {})).text()).toBe("from the network");
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it("is given the path with its query, which is what the simulation routes on", async () => {
    const seen: string[] = [];
    const uninstall = installApiTransport((path) => {
      seen.push(path);
      return Promise.resolve(new Response("{}"));
    });
    await fetchJson("/thing", (u) => u);
    await sendToApi("/v1/receipt?network=testnet&tx=a", {});
    uninstall();
    expect(seen).toEqual(["/thing", "/v1/receipt?network=testnet&tx=a"]);
  });

  it("is taken out only by the one who put it in: an old uninstall does not remove a newer transport", async () => {
    const first = installApiTransport(() => Promise.resolve(new Response("first")));
    const second = installApiTransport(() => Promise.resolve(new Response("second")));
    first();
    expect(hasApiTransport()).toBe(true);
    expect(await (await sendToApi("/x", {})).text()).toBe("second");
    second();
    expect(hasApiTransport()).toBe(false);
  });
});
