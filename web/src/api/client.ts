// Thin fetch boundary. The parse step is a REQUIRED argument so an API
// response can never reach UI code without passing a runtime validator
// (e.g. parsePublicReceipt).

import { config } from "@/lib/config";

export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Join the configured API base with an absolute API path ("/receipts/x").
 * Callers must `encodeURIComponent` any dynamic segment themselves. */
export function apiUrl(path: string, base: string = config.apiBaseUrl): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`API path must start with a single "/": "${path}"`);
  }
  if (path.split("/").includes("..")) {
    throw new Error("API path must not contain '..' segments");
  }
  return `${base}${path}`;
}

/** Answers an API call in place of the network. `path` is the API path with its query string, as given to {@link apiUrl}
 * ("/campaigns/c-1", "/v1/receipt?network=testnet&..."). */
export type ApiTransport = (path: string, init: RequestInit) => Promise<Response>;

let installed: ApiTransport | null = null;

/** Practice mode answers every API call from inside the page (src/practice). While a transport is installed, no call
 * reaches the network: {@link sendToApi} never falls back to `fetch`. Returns the function that takes it out again. */
export function installApiTransport(transport: ApiTransport): () => void {
  installed = transport;
  return () => {
    if (installed === transport) installed = null;
  };
}

/** The error code practice mode answers with when it is asked to read a chain it has not got (a receipt that is not its own, a
 * payslip): the pages that make such a call turn it into a sentence of their own. */
export const PRACTICE_REFUSAL = "practice_mode";

/** Whether something other than the network is answering the API. */
export function hasApiTransport(): boolean {
  return installed !== null;
}

/** The one place the app's API calls leave the page: the operator's, the receipt's and the payslip's, the event stream's.
 * `fetch` is looked up when called, so a test that replaces it after this module has loaded still takes effect. */
export function sendToApi(path: string, init: RequestInit): Promise<Response> {
  return installed !== null ? installed(path, init) : fetch(apiUrl(path), init);
}

export async function fetchJson<T>(
  path: string,
  parse: (input: unknown) => T,
  init: { signal?: AbortSignal } = {},
): Promise<T> {
  const res = await sendToApi(path, {
    headers: { Accept: "application/json" },
    signal: init.signal ?? null,
  });
  if (!res.ok) {
    throw new ApiError(`request failed with status ${String(res.status)}`, res.status);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError("response was not valid JSON", res.status);
  }
  return parse(body);
}
