// Ask the hosted verifier to check a payslip, and sort failures into the few kinds the page knows
// how to explain.
//
// The endpoint path lives in endpoints.ts.
//
// A payslip that does not match the chain is NOT a failed request: the verifier answers 200 with a
// verdict (REQ-VER-006). So the failures here are only about getting an answer at all.
//
// A payslip names a receiver and an amount, and its `rseed` also opens one output's memo. It goes in
// the body of one POST to the one URL, and nowhere else: not in the address, not in storage, not in a
// message, not in an error. An error carries its kind and the status; nothing the verifier said.

import { z } from "zod";

import { PRACTICE_REFUSAL, sendToApi } from "./client";
import { PAYSLIP_ENDPOINT } from "./endpoints";
import { parsePayslipAnswer, type PayslipAnswer } from "./payslip-answer";
import { payslipBody, type Payslip } from "./payslip-input";

export type PayslipFailureKind =
  /** Network error, timeout, or the verifier is down, busy or does not offer this check. */
  | "unreachable"
  /** The verifier refused the request as not a payslip it reads. */
  | "rejected"
  /** The verifier answered that it does not serve the payslip's network. */
  | "network_not_served"
  /** The verifier says the request is too large. */
  | "too_large"
  /** Practice mode answered: it asks no verifier and reads no chain, so it checks no payslip. */
  | "practice"
  /** The verifier could not read the chain, or its source of chain data contradicted itself. */
  | "chain_unavailable"
  /** It answered, but not in the format we accept, or about another payslip than the one sent. */
  | "invalid_response";

export class PayslipFetchError extends Error {
  override readonly name = "PayslipFetchError";
  readonly kind: PayslipFailureKind;
  readonly status: number | null;

  constructor(kind: PayslipFailureKind, status: number | null = null) {
    super(`payslip request failed: ${kind}`);
    this.kind = kind;
    this.status = status;
  }
}

/** Status, and the code the verifier gave with it, to failure kind. */
export function mapFailure(status: number, code: string | null = null): PayslipFailureKind {
  if (status === 409 && code === PRACTICE_REFUSAL) return "practice";
  if (status === 413) return "too_large";
  if (status === 400 && code === "network_not_configured") return "network_not_served";
  if (status === 400 || status === 422) return "rejected";
  if ((status === 502 || status === 503) && (code === "chain_unavailable" || code === "chain_inconsistent")) {
    return "chain_unavailable";
  }
  return "unreachable"; // 404 or 405 (no such check here), 429, any other 5xx: try again later
}

/** The verifier's refusal: `{"error": {"code", "message"}}`. Only the code is ever read. */
const refusalWire = z.looseObject({ error: z.looseObject({ code: z.string() }) });

/** The code of a refusal, for the statuses where it changes what the refusal means; null otherwise.
 * The verifier's words are never read or kept. */
async function refusalCode(response: Response): Promise<string | null> {
  if (response.status !== 400 && response.status !== 409 && response.status !== 502 && response.status !== 503) return null;
  try {
    const refusal = refusalWire.safeParse(await response.json());
    return refusal.success ? refusal.data.error.code : null;
  } catch {
    return null;
  }
}

export interface CheckPayslipOptions {
  /** Caller cancellation. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

export async function checkPayslip(payslip: Payslip, options: CheckPayslipOptions = {}): Promise<PayslipAnswer> {
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
      response = await sendToApi(PAYSLIP_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: payslipBody(payslip),
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        // The payslip goes to this one address. A redirect would send it on to another.
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      // Cancelled by the caller: let it propagate untouched.
      if (options.signal?.aborted) throw error;
      throw new PayslipFetchError("unreachable");
    }

    if (!response.ok) throw new PayslipFetchError(mapFailure(response.status, await refusalCode(response)), response.status);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new PayslipFetchError(timedOut ? "unreachable" : "invalid_response", response.status);
    }
    let answer: PayslipAnswer;
    try {
      answer = parsePayslipAnswer(body);
    } catch {
      throw new PayslipFetchError("invalid_response", response.status);
    }
    // An answer about some other payslip is no answer to this one.
    if (answer.network !== payslip.network || answer.txid !== payslip.txid || answer.action !== payslip.action) {
      throw new PayslipFetchError("invalid_response", response.status);
    }
    return answer;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}
