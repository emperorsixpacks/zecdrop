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

export async function fetchJson<T>(
  path: string,
  parse: (input: unknown) => T,
  init: { signal?: AbortSignal } = {},
): Promise<T> {
  const res = await fetch(apiUrl(path), {
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
