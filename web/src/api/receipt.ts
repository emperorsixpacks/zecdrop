// Ask the key-less verifier for a receipt, and sort failures into the few
// kinds the page knows how to explain.
//
// The endpoint path lives in endpoints.ts.
//
// A campaign whose figures do not check out is NOT a failed request: the
// verifier answers 200 with a receipt whose `findings` say what is wrong
// (REQ-VER-001). So the failures here are only about getting an answer at all.

import { RECEIPT_ENDPOINT } from "./endpoints";
import { apiUrl } from "./client";
import { receiptSearchParams, type ReceiptQuery } from "./receipt-query";
import { parsePublicReceipt, type PublicReceipt } from "./types";

export type ReceiptFailureKind =
  /** Network error, timeout, or the verifier is down or busy. */
  | "unreachable"
  /** The verifier knows nothing about these transactions. */
  | "not_found"
  /** The verifier refused the request as malformed. */
  | "rejected"
  /** It answered, but not in the receipt format we accept. */
  | "invalid_response";

export class ReceiptFetchError extends Error {
  override readonly name = "ReceiptFetchError";
  readonly kind: ReceiptFailureKind;
  readonly status: number | null;

  constructor(kind: ReceiptFailureKind, status: number | null = null) {
    super(`receipt request failed: ${kind}`);
    this.kind = kind;
    this.status = status;
  }
}

/** Status code to failure kind. */
export function mapFailure(status: number): ReceiptFailureKind {
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "rejected";
  return "unreachable"; // 5xx, 429 and anything unexpected: try again later
}

export interface FetchReceiptOptions {
  /** Caller cancellation (react-query passes one). */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchReceipt(
  query: ReceiptQuery,
  options: FetchReceiptOptions = {},
): Promise<PublicReceipt> {
  const url = `${apiUrl(RECEIPT_ENDPOINT)}?${receiptSearchParams(query).toString()}`;

  // Already cancelled: do not start a request nobody wants.
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("The request was cancelled", "AbortError");
  }

  // One controller for both the caller's cancellation and our timeout, so we
  // can tell the two apart.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onCallerAbort = () => {
    controller.abort();
  };
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch (error) {
      // Cancelled by the caller: let it propagate untouched.
      if (options.signal?.aborted) throw error;
      throw new ReceiptFetchError("unreachable");
    }

    if (!response.ok) throw new ReceiptFetchError(mapFailure(response.status), response.status);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ReceiptFetchError(timedOut ? "unreachable" : "invalid_response", response.status);
    }
    try {
      return parsePublicReceipt(body);
    } catch {
      throw new ReceiptFetchError("invalid_response", response.status);
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}
