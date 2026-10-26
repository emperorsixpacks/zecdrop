// Server-Sent Events over fetch.
//
// The browser's EventSource cannot send an Authorization header, and the
// operator API needs the bearer token on every request, so the stream is read
// with fetch and a streaming reader. This file has two parts:
//
//   SseParser            a pure parser for the text/event-stream format
//                        (https://html.spec.whatwg.org/multipage/server-sent-events.html)
//   subscribeToEvents    the connection: auth, reconnect with backoff, clean abort
//
// The server replays a campaign's whole event history to every new subscriber
// and closes the stream after a terminal event (`settled` or `halted`). So on
// every (re)connect the consumer is told to start its log afresh (`onOpen`),
// and a reconnect never double-counts.

import { sendToApi } from "@/api/client";

import { isTerminalEvent, parseProgressEvent, type ProgressEvent } from "./schemas";

// ---- parser ------------------------------------------------------------------

export interface SseMessage {
  /** The `event:` field, "message" when absent. */
  event: string;
  /** The `data:` lines joined with "\n". */
  data: string;
  id?: string;
}

/** Incremental text/event-stream parser. Feed it text in any chunking. */
export class SseParser {
  #buffer = "";
  #data: string[] = [];
  #event = "";
  #id: string | undefined;
  #started = false;
  #skipLeadingLf = false;

  readonly #onMessage: (message: SseMessage) => void;

  constructor(onMessage: (message: SseMessage) => void) {
    this.#onMessage = onMessage;
  }

  /** Add decoded text. Messages are delivered as soon as they are complete. */
  push(text: string): void {
    let chunk = text;
    if (!this.#started && chunk.length > 0) {
      this.#started = true;
      if (chunk.startsWith("﻿")) chunk = chunk.slice(1); // one BOM at the very start
    }
    // A "\r" at the end of the previous chunk may be the first half of "\r\n".
    if (this.#skipLeadingLf && chunk.length > 0) {
      if (chunk.startsWith("\n")) chunk = chunk.slice(1);
      this.#skipLeadingLf = false;
    }
    this.#buffer += chunk;

    for (;;) {
      const match = /\r\n|\n|\r/u.exec(this.#buffer);
      if (!match) return;
      const end = match.index + match[0].length;
      // A lone "\r" at the very end might be followed by "\n" next time.
      if (match[0] === "\r" && end === this.#buffer.length) {
        this.#skipLeadingLf = true;
      }
      const line = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(end);
      this.#line(line);
    }
  }

  #line(line: string): void {
    if (line === "") {
      this.#dispatch();
      return;
    }
    if (line.startsWith(":")) return; // comment (keep-alive)
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.#event = value;
        break;
      case "data":
        this.#data.push(value);
        break;
      case "id":
        if (!value.includes("\0")) this.#id = value;
        break;
      default:
        // retry: and unknown fields are ignored; we manage our own backoff.
        break;
    }
  }

  #dispatch(): void {
    if (this.#data.length > 0) {
      const message: SseMessage = {
        event: this.#event === "" ? "message" : this.#event,
        data: this.#data.join("\n"),
      };
      if (this.#id !== undefined) message.id = this.#id;
      this.#onMessage(message);
    }
    // Per the spec an event with no data is dropped; either way, reset.
    this.#data = [];
    this.#event = "";
  }
}

// ---- subscription -------------------------------------------------------------

export type StreamStatus =
  | "connecting"
  | "open"
  /** The stream ended without a terminal event; trying again shortly. */
  | "reconnecting"
  /** A terminal event arrived; the server closed the stream. */
  | "finished"
  /** Stopped for good: unauthorised or the campaign does not exist. */
  | "stopped";

export interface SubscribeOptions {
  campaignId: string;
  /** The bearer token, read at connect time so a rejected token is not reused. */
  getToken: () => string | null;
  signal: AbortSignal;
  /** Called at the start of every (re)connection: the history is replayed. */
  onOpen: () => void;
  onEvent: (event: ProgressEvent) => void;
  onStatus: (status: StreamStatus) => void;
  /** The server answered 401. */
  onUnauthorized: () => void;
  /** An event could not be read. It is skipped; the stream continues. */
  onUnreadable?: () => void;
  /** Delay before reconnect attempt `n` (0-based). */
  backoffMs?: (attempt: number) => number;
}

export const defaultBackoffMs = (attempt: number): number => Math.min(1_000 * 2 ** attempt, 15_000);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Read a campaign's progress events until a terminal event, a fatal answer,
 * or `signal` aborts. Resolves when it stops; never throws for network trouble
 * (it reconnects instead). */
export async function subscribeToEvents(options: SubscribeOptions): Promise<void> {
  const { campaignId, getToken, signal } = options;
  const backoff = options.backoffMs ?? defaultBackoffMs;
  let attempt = 0;

  while (!signal.aborted) {
    const token = getToken();
    if (token === null) {
      options.onUnauthorized();
      options.onStatus("stopped");
      return;
    }

    options.onStatus(attempt === 0 ? "connecting" : "reconnecting");
    try {
      const response = await sendToApi(`/campaigns/${encodeURIComponent(campaignId)}/events`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal,
      });
      if (response.status === 401) {
        options.onUnauthorized();
        options.onStatus("stopped");
        return;
      }
      if (response.status === 404) {
        options.onStatus("stopped");
        return;
      }
      if (!response.ok || response.body === null) throw new Error("stream refused");

      options.onOpen();
      options.onStatus("open");
      attempt = 0;

      let finished = false;
      const parser = new SseParser((message) => {
        if (message.event !== "progress") return;
        try {
          const event = parseProgressEvent(JSON.parse(message.data));
          options.onEvent(event);
          if (isTerminalEvent(event)) finished = true;
        } catch {
          options.onUnreadable?.();
        }
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      // Cancelling the reader ends a pending read() at once. Do not rely on the
      // fetch implementation erroring the body when the signal aborts.
      const stopReading = () => {
        void reader.cancel().catch(() => undefined);
      };
      signal.addEventListener("abort", stopReading, { once: true });
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
          if (finished) break;
        }
        parser.push(decoder.decode());
      } finally {
        signal.removeEventListener("abort", stopReading);
        await reader.cancel().catch(() => undefined);
      }
      if (signal.aborted) return;
      if (finished) {
        options.onStatus("finished");
        return;
      }
    } catch {
      if (signal.aborted) return;
    }

    // The stream ended (or failed) before a terminal event: try again.
    if (signal.aborted) return;
    options.onStatus("reconnecting");
    await sleep(backoff(attempt), signal);
    attempt += 1;
  }
}
