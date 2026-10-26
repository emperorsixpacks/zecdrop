// A fetch stand-in for the operator API that answers from the CAPTURED
// fixtures (fixtures/contract/operator), so tests exercise real response
// shapes. Routes are keyed "METHOD /api/path/:param".

import { vi } from "vitest";

import { FIXTURES, fixtureJson, goldenJson } from "./operator-fixtures";

export interface RecordedCall {
  method: string;
  path: string;
  headers: Headers;
  /** The parsed JSON request body, or undefined. */
  body: unknown;
}

export interface RouteReply {
  status?: number;
  body: unknown;
  /** Send this text as-is with this content type (for the event stream) instead of JSON. */
  raw?: { text: string; contentType: string };
}

export type RouteHandler = (call: RecordedCall, params: Record<string, string>) => RouteReply | Promise<RouteReply>;

export interface FakeOperator {
  calls: RecordedCall[];
  /** Calls whose path matches, in order. */
  to(method: string, path: RegExp | string): RecordedCall[];
}

function compile(pattern: string): { method: string; regex: RegExp; names: string[] } {
  const [method, path] = pattern.split(" ") as [string, string];
  const names: string[] = [];
  const source = path.replace(/:([a-z]+)/gu, (_m, name: string) => {
    names.push(name);
    return "([^/]+)";
  });
  return { method, regex: new RegExp(`^${source}$`, "u"), names };
}

/** Install the fake as global fetch. Unlisted routes answer a 500 so a test
 * that reaches for something unexpected fails loudly. */
export function installFakeOperator(routes: Record<string, RouteHandler>): FakeOperator {
  const compiled = Object.entries(routes).map(([pattern, handler]) => ({ ...compile(pattern), handler }));
  const calls: RecordedCall[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(target, "http://operator.test");
      const method = (init?.method ?? "GET").toUpperCase();
      let body: unknown;
      if (typeof init?.body === "string") body = JSON.parse(init.body);
      const call: RecordedCall = { method, path: url.pathname, headers: new Headers(init?.headers), body };
      calls.push(call);

      for (const route of compiled) {
        const match = route.regex.exec(url.pathname);
        if (route.method !== method || !match) continue;
        const params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1] ?? "")]));
        const reply = await route.handler(call, params);
        if (reply.raw) {
          return new Response(reply.raw.text, {
            status: reply.status ?? 200,
            headers: { "Content-Type": reply.raw.contentType },
          });
        }
        return new Response(JSON.stringify(reply.body), {
          status: reply.status ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: { code: "unexpected_route", message: `${method} ${url.pathname}` } }), {
        status: 500,
      });
    }),
  );

  return {
    calls,
    to: (method, path) =>
      calls.filter((c) => c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path))),
  };
}

/** Reply with a captured fixture and its real status. */
export function replyWith(file: string, status = 200): RouteReply {
  return { status, body: fixtureJson(file) };
}

/** Reply with a real-chain golden file (written by the operator's Rust test) and its real status. */
export function replyWithGolden(file: string, status = 200): RouteReply {
  return { status, body: goldenJson(file) };
}

/** Reply with a captured event-stream transcript. */
export function replyWithStream(file: string): RouteReply {
  const text = FIXTURES[file];
  if (text === undefined) throw new Error(`no operator fixture named ${file}`);
  return { body: null, raw: { text, contentType: "text/event-stream" } };
}

/** An id as it appears in the fixtures. */
export const FIXTURE_CAMPAIGN_ID = "c-000000000001";
