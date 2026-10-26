import { afterEach, describe, expect, it, vi } from "vitest";

import { FIXTURES } from "@/test/operator-fixtures";

import { defaultBackoffMs, SseParser, subscribeToEvents, type SseMessage, type StreamStatus } from "./events";
import { isTerminalEvent, parseProgressEvent, type ProgressEvent } from "./schemas";

/** Parse `text` delivered in the given chunks. */
function parse(...chunks: string[]): SseMessage[] {
  const out: SseMessage[] = [];
  const parser = new SseParser((m) => out.push(m));
  for (const chunk of chunks) parser.push(chunk);
  return out;
}

const SETTLED = FIXTURES["events-settled.sse.txt"] ?? "";
const RUNNING = FIXTURES["events-running.sse.txt"] ?? "";

// ---- the parser (text/event-stream) -----------------------------------------------

describe("SseParser", () => {
  it("reads event and data fields", () => {
    expect(parse("event: progress\ndata: {\"a\":1}\n\n")).toEqual([{ event: "progress", data: '{"a":1}' }]);
  });

  it("defaults the event name to 'message'", () => {
    expect(parse("data: hi\n\n")).toEqual([{ event: "message", data: "hi" }]);
  });

  it("joins multiple data lines with a newline", () => {
    expect(parse("data: one\ndata: two\n\n")[0]?.data).toBe("one\ntwo");
  });

  it("strips exactly one leading space from a value", () => {
    expect(parse("data:  two spaces\n\n")[0]?.data).toBe(" two spaces");
    expect(parse("data:none\n\n")[0]?.data).toBe("none");
  });

  it("ignores comments (keep-alives) and unknown fields", () => {
    expect(parse(": keep-alive\n\nretry: 3000\nfoo: bar\ndata: x\n\n")).toEqual([{ event: "message", data: "x" }]);
  });

  it("accepts \\n, \\r\\n and \\r line endings", () => {
    const want = [{ event: "progress", data: "x" }];
    expect(parse("event: progress\ndata: x\n\n")).toEqual(want);
    expect(parse("event: progress\r\ndata: x\r\n\r\n")).toEqual(want);
    expect(parse("event: progress\rdata: x\r\r")).toEqual(want);
  });

  it("handles \\r\\n split across chunks without making a phantom blank line", () => {
    expect(parse("data: x\r", "\n\r", "\n")).toEqual([{ event: "message", data: "x" }]);
    expect(parse("data: x\r\n", "data: y\r\n\r\n")).toEqual([{ event: "message", data: "x\ny" }]);
  });

  it("drops one BOM at the very start only", () => {
    expect(parse("﻿data: x\n\n")).toEqual([{ event: "message", data: "x" }]);
  });

  it("drops an event with no data, and an unfinished event at end of input", () => {
    expect(parse("event: progress\n\n")).toEqual([]);
    expect(parse("data: never terminated")).toEqual([]);
  });

  it("keeps the id when one is given and ignores one containing NUL", () => {
    expect(parse("id: 7\ndata: x\n\n")[0]?.id).toBe("7");
    expect(parse("id: a\0b\ndata: x\n\n")[0]?.id).toBeUndefined();
  });

  it("resets the event name between messages", () => {
    const out = parse("event: a\ndata: 1\n\ndata: 2\n\n");
    expect(out.map((m) => m.event)).toEqual(["a", "message"]);
  });

  it("does not emit until the blank line arrives", () => {
    const out: SseMessage[] = [];
    const parser = new SseParser((m) => out.push(m));
    parser.push("data: x\n");
    expect(out).toEqual([]);
    parser.push("\n");
    expect(out).toHaveLength(1);
  });
});

// ---- the parser against REAL transcripts --------------------------------------------

function events(text: string): ProgressEvent[] {
  return parse(text)
    .filter((m) => m.event === "progress")
    .map((m) => parseProgressEvent(JSON.parse(m.data)));
}

describe("a real settled run", () => {
  const all = events(SETTLED);

  it("every message is a progress event the schema accepts", () => {
    expect(parse(SETTLED).every((m) => m.event === "progress")).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(8);
  });

  it("builds and broadcasts each batch, confirms them, then settles", () => {
    expect(all[0]).toMatchObject({ event: "built", batchIndex: 0 });
    expect(all.at(-1)).toMatchObject({ event: "settled", batches: 2 });
    for (const index of [0, 1]) {
      const kinds = all.filter((e) => "batchIndex" in e && e.batchIndex === index).map((e) => e.event);
      expect(kinds.indexOf("built")).toBeLessThan(kinds.indexOf("broadcast"));
      expect(kinds.indexOf("broadcast")).toBeLessThan(kinds.lastIndexOf("confirmed"));
    }
  });

  it("is terminal only at the end", () => {
    expect(all.filter(isTerminalEvent)).toHaveLength(1);
    expect(isTerminalEvent(all.at(-1) as ProgressEvent)).toBe(true);
  });

  it("confirmation depth rises to the required depth and never beyond", () => {
    const confirmed = all.filter((e): e is Extract<ProgressEvent, { event: "confirmed" }> => e.event === "confirmed");
    expect(confirmed.every((e) => e.depth >= 1 && e.depth <= e.requiredDepth)).toBe(true);
    expect(Math.max(...confirmed.map((e) => e.depth))).toBe(3);
  });

  it("gives the same events wherever the stream is cut into chunks", () => {
    const want = parse(SETTLED);
    for (let cut = 0; cut <= SETTLED.length; cut += 7) {
      expect(parse(SETTLED.slice(0, cut), SETTLED.slice(cut))).toEqual(want);
    }
  });

  it("gives the same events one character at a time", () => {
    expect(parse(...SETTLED)).toEqual(parse(SETTLED));
  });

  it("and with Windows line endings", () => {
    expect(parse(SETTLED.replaceAll("\n", "\r\n"))).toEqual(parse(SETTLED));
  });
});

describe("a real run cut off while waiting for blocks", () => {
  it("has no terminal event", () => {
    const all = events(RUNNING);
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(all.some(isTerminalEvent)).toBe(false);
    expect(all.at(-1)?.event).toBe("waiting");
  });
});

describe("multi-byte text split across chunk boundaries", () => {
  it("decodes through the subscription's TextDecoder without corruption", () => {
    const text = 'event: progress\ndata: {"event":"failed","batch_index":0,"reason":"café \u{1F512}"}\n\n';
    const bytes = new TextEncoder().encode(text);
    const decoder = new TextDecoder("utf-8");
    const out: SseMessage[] = [];
    const parser = new SseParser((m) => out.push(m));
    for (let i = 0; i < bytes.length; i += 3) parser.push(decoder.decode(bytes.slice(i, i + 3), { stream: true }));
    parser.push(decoder.decode());
    expect(parseProgressEvent(JSON.parse(out[0]?.data ?? ""))).toEqual({
      event: "failed",
      batchIndex: 0,
      reason: "café \u{1F512}",
    });
  });
});

// ---- the subscription ----------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const encoder = new TextEncoder();

/** A Response whose body delivers `chunks` and then closes (or hangs open). */
function streamResponse(chunks: string[], { hang = false, status = 200 }: { hang?: boolean; status?: number } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!hang) controller.close();
    },
  });
  return new Response(status === 200 ? body : null, { status });
}

interface Harness {
  statuses: StreamStatus[];
  received: ProgressEvent[];
  opens: number;
  unauthorized: number;
  unreadable: number;
  controller: AbortController;
}

function harness(): Harness {
  return { statuses: [], received: [], opens: 0, unauthorized: 0, unreadable: 0, controller: new AbortController() };
}

function run(
  h: Harness,
  getToken: () => string | null = () => "t".repeat(64),
  backoffMs: (attempt: number) => number = () => 0,
) {
  return subscribeToEvents({
    campaignId: "c-000000000001",
    getToken,
    signal: h.controller.signal,
    onOpen: () => {
      h.opens += 1;
      h.received.length = 0; // the server replays history on every connect
    },
    onEvent: (e) => h.received.push(e),
    onStatus: (s) => h.statuses.push(s),
    onUnauthorized: () => {
      h.unauthorized += 1;
    },
    onUnreadable: () => {
      h.unreadable += 1;
    },
    backoffMs,
  });
}

describe("subscribeToEvents", () => {
  it("sends the bearer token in a header, never in the URL", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(streamResponse([SETTLED])));
    vi.stubGlobal("fetch", fetchMock);
    await run(harness());

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/campaigns/c-000000000001/events");
    expect(url).not.toContain("t".repeat(64));
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${"t".repeat(64)}`);
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(init).toMatchObject({ credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
  });

  it("delivers a whole run and stops by itself after the terminal event", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(streamResponse([SETTLED]))));
    const h = harness();
    await run(h);
    expect(h.received.at(-1)?.event).toBe("settled");
    expect(h.statuses).toEqual(["connecting", "open", "finished"]);
    expect(h.opens).toBe(1);
  });

  it("copes with the stream arriving in tiny pieces", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(streamResponse([...SETTLED.match(/[\s\S]{1,11}/gu)!]))));
    const h = harness();
    await run(h);
    expect(h.received).toEqual(events(SETTLED));
  });

  it("stops and reports 401 without retrying", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 401 })));
    vi.stubGlobal("fetch", fetchMock);
    const h = harness();
    await run(h);
    expect(h.unauthorized).toBe(1);
    expect(h.statuses.at(-1)).toBe("stopped");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops quietly when the campaign does not exist", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 404 })));
    vi.stubGlobal("fetch", fetchMock);
    const h = harness();
    await run(h);
    expect(h.statuses.at(-1)).toBe("stopped");
    expect(h.unauthorized).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not even connect without a token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const h = harness();
    await run(h, () => null);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.unauthorized).toBe(1);
  });

  it("reconnects when the stream ends before a terminal event, replaying cleanly", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(streamResponse([RUNNING]))
      .mockResolvedValueOnce(streamResponse([SETTLED]));
    vi.stubGlobal("fetch", fetchMock);
    const backoff = vi.fn((_attempt: number) => 0);
    const h = harness();
    await run(h, () => "t".repeat(64), backoff);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(backoff).toHaveBeenCalledWith(0);
    expect(h.opens).toBe(2);
    // The second connection replayed history; the log was reset, not doubled.
    expect(h.received).toEqual(events(SETTLED));
    expect(h.statuses).toEqual(["connecting", "open", "reconnecting", "reconnecting", "open", "finished"]);
  });

  it("retries after a network failure, and backs off further each time", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(streamResponse([SETTLED]));
    vi.stubGlobal("fetch", fetchMock);
    const backoff = vi.fn((_attempt: number) => 0);
    const h = harness();
    await run(h, () => "t".repeat(64), backoff);

    expect(backoff.mock.calls.map(([n]) => n)).toEqual([0, 1]);
    expect(h.received.at(-1)?.event).toBe("settled");
  });

  it("treats a 5xx as a reason to retry, not to stop", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(streamResponse([SETTLED]));
    vi.stubGlobal("fetch", fetchMock);
    const h = harness();
    await run(h);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.statuses.at(-1)).toBe("finished");
  });

  it("skips an unreadable event, reports it, and keeps going", async () => {
    const bad = 'event: progress\ndata: {"event":"mystery"}\n\n';
    const notJson = "event: progress\ndata: <html>\n\n";
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(streamResponse([bad, notJson, SETTLED]))));
    const h = harness();
    await run(h);
    expect(h.unreadable).toBe(2);
    expect(h.received.at(-1)?.event).toBe("settled");
  });

  it("ignores messages that are not progress events", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(streamResponse(['data: {"event":"settled"}\n\n', SETTLED]))));
    const h = harness();
    await run(h);
    expect(h.received).toEqual(events(SETTLED));
    expect(h.unreadable).toBe(0);
  });

  it("stops promptly and cleanly when aborted mid-stream", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      const response = streamResponse([RUNNING], { hang: true });
      init.signal?.addEventListener("abort", () => undefined);
      return Promise.resolve(response);
    }));
    const h = harness();
    const done = run(h);
    await vi.waitFor(() => {
      expect(h.received.length).toBeGreaterThan(2);
    });
    h.controller.abort();
    await expect(done).resolves.toBeUndefined();
    const countAtAbort = h.received.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(h.received.length).toBe(countAtAbort);
    expect(h.statuses.at(-1)).not.toBe("finished");
  });

  it("an abort during the wait before a retry also ends it", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("down"))));
    const h = harness();
    const done = run(h, () => "t".repeat(64), () => 60_000);
    await vi.waitFor(() => {
      expect(h.statuses).toContain("reconnecting");
    });
    h.controller.abort();
    await expect(done).resolves.toBeUndefined();
  });

  it("never starts when already aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const h = harness();
    h.controller.abort();
    await run(h);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("defaultBackoffMs", () => {
  it("doubles from one second up to fifteen", () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(defaultBackoffMs)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
  });
});
