// Calls to the local operator API. Every protected call carries the bearer
// token from session.ts in a header. Responses are parsed with the strict
// schemas in schemas.ts before anything else sees them.
//
// The create call is the only one that carries recipient data (the CSV). It is
// sent once, to the loopback operator, and is never logged, stored or put in a
// URL; the response, like every response, contains none of it.

import { sendToApi } from "@/api/client";
import { parsePublicReceipt, type FundingSource, type OutPointView, type PublicReceipt } from "@/api/types";

import { getToken, rejectToken } from "./session";
import {
  parseNearDryQuote,
  parseNearLiveQuote,
  parseNearPreview,
  parseNearStatus,
  parseNearTokens,
  type NearAsset,
  type NearDryQuoteView,
  type NearLiveQuoteView,
  type NearPriceView,
  type NearStatusView,
} from "./near-schemas";
import {
  parseCampaign,
  parseCampaignList,
  parseHealth,
  parseOperatorError,
  parseInboxReturn,
  parsePayslipsExport,
  parseViewingKeyExport,
  parseStartResponse,
  type InboxReturnResponse,
  type OperatorCampaign,
  type OperatorCampaignSummary,
  type OperatorError,
  type OperatorHealth,
  type PayslipsExport,
  type StartResponse,
  type ViewingKeyExport,
} from "./schemas";

export type OperatorFailureKind =
  /** There is no token to send. */
  | "no_token"
  /** The operator answered 401: the token is wrong or from an older run. */
  | "unauthorized"
  /** The operator answered with an error it explained. */
  | "api"
  /** The operator could not be reached. */
  | "unreachable"
  /** It answered, but not in a shape we accept. */
  | "invalid_response";

export class OperatorApiError extends Error {
  override readonly name = "OperatorApiError";
  readonly kind: OperatorFailureKind;
  readonly status: number | null;
  /** What the operator said, for `api` failures. */
  readonly api: OperatorError | null;

  constructor(kind: OperatorFailureKind, status: number | null = null, api: OperatorError | null = null) {
    super(`operator request failed: ${kind}${api ? ` (${api.code})` : ""}`);
    this.kind = kind;
    this.status = status;
    this.api = api;
  }
}

const CAMPAIGN_ID = /^[A-Za-z0-9._-]{1,64}$/u;

function campaignPath(id: string, suffix = ""): string {
  if (!CAMPAIGN_ID.test(id)) throw new OperatorApiError("api", 404, { code: "not_found", message: "campaign not found" });
  return `/campaigns/${encodeURIComponent(id)}${suffix}`;
}

interface RequestOptions<T> {
  method?: "GET" | "POST";
  body?: unknown;
  parse: (input: unknown) => T;
  /** Health needs no token. */
  authenticated?: boolean;
  /** Headers beyond the standard ones. */
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions<T>): Promise<T> {
  const authenticated = options.authenticated ?? true;
  const token = authenticated ? getToken() : null;
  if (authenticated && token === null) throw new OperatorApiError("no_token");

  const headers: Record<string, string> = { Accept: "application/json" };
  if (token !== null) headers["Authorization"] = `Bearer ${token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  Object.assign(headers, options.extraHeaders);

  let response: Response;
  try {
    response = await sendToApi(path, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: options.signal ?? null,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error; // cancelled by the caller: not a failure
    throw new OperatorApiError("unreachable");
  }

  if (response.status === 401) {
    rejectToken();
    throw new OperatorApiError("unauthorized", 401);
  }

  // An error answer that is not the operator's envelope (a proxy, a security
  // layer, a crash page) is still an answer with a status: the page explains it
  // by that status instead of calling the whole operator unreadable.
  if (!response.ok) {
    let api: OperatorError | null;
    try {
      api = parseOperatorError(await response.json());
    } catch {
      api = null;
    }
    throw new OperatorApiError("api", response.status, api);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OperatorApiError("invalid_response", response.status);
  }

  try {
    return options.parse(body);
  } catch {
    throw new OperatorApiError("invalid_response", response.status);
  }
}

// ---- the API ----------------------------------------------------------------------

export async function getHealth(signal?: AbortSignal): Promise<OperatorHealth> {
  return await request("/health", { parse: parseHealth, authenticated: false, ...(signal ? { signal } : {}) });
}

export async function listCampaigns(signal?: AbortSignal): Promise<OperatorCampaignSummary[]> {
  return await request("/campaigns", { parse: parseCampaignList, ...(signal ? { signal } : {}) });
}

export async function getCampaign(id: string, signal?: AbortSignal): Promise<OperatorCampaign> {
  return await request(campaignPath(id), { parse: parseCampaign, ...(signal ? { signal } : {}) });
}

/** The receipt the operator builds. Same strict shape as the public page's. */
export async function getCampaignReceipt(id: string, signal?: AbortSignal): Promise<PublicReceipt> {
  return await request(campaignPath(id, "/receipt"), { parse: parsePublicReceipt, ...(signal ? { signal } : {}) });
}

export type FeePolicyName = "zip317_text" | "zebra_main";

export interface CreateCampaignInput {
  name: string;
  /** The recipients, as CSV text. Held in memory by the caller; never stored. */
  csv: string;
  maxOutputsPerBatch: number;
  feePolicy: FeePolicyName;
}

export async function createCampaign(input: CreateCampaignInput, signal?: AbortSignal): Promise<OperatorCampaign> {
  return await request("/campaigns", {
    method: "POST",
    body: {
      name: input.name,
      csv: input.csv,
      max_outputs_per_batch: input.maxOutputsPerBatch,
      fee_policy: input.feePolicy,
    },
    parse: parseCampaign,
    ...(signal ? { signal } : {}),
  });
}

/** Mock chain only: record the funding deposit, and optionally what it spent (to show either kind). */
export async function recordFunding(
  id: string,
  deposit: { outpoint: OutPointView; amount: string; source?: FundingSource },
  signal?: AbortSignal,
): Promise<OperatorCampaign> {
  return await request(campaignPath(id, "/fund-observed"), {
    method: "POST",
    body: {
      outpoint: `${deposit.outpoint.txid}:${String(deposit.outpoint.vout)}`,
      amount: deposit.amount,
      ...(deposit.source === undefined ? {} : { source: deposit.source }),
    },
    parse: parseCampaign,
    ...(signal ? { signal } : {}),
  });
}

/** Real chain: ask the operator to look for the deposit now (it also looks on its own). */
export async function checkFunding(id: string, signal?: AbortSignal): Promise<OperatorCampaign> {
  return await request(campaignPath(id, "/check-funding"), {
    method: "POST",
    parse: parseCampaign,
    ...(signal ? { signal } : {}),
  });
}

/** The header that acknowledges a viewing key discloses every payout, for good.
 * Sent only after the person has been shown the warning and agreed (see AuditorStep). */
export const DISCLOSURE_HEADER = "X-Zecdrop-Confirm-Disclosure";
export const DISCLOSURE_ACKNOWLEDGEMENT = "I-UNDERSTAND";

/** Ask for the campaign's viewing key. The caller must already have shown the
 * person the disclosure warning and got their agreement. The key is returned to
 * the caller and kept nowhere else. */
export async function exportViewingKey(id: string, signal?: AbortSignal): Promise<ViewingKeyExport> {
  return await request(campaignPath(id, "/audit-ufvk-export"), {
    parse: parseViewingKeyExport,
    extraHeaders: { [DISCLOSURE_HEADER]: DISCLOSURE_ACKNOWLEDGEMENT },
    ...(signal ? { signal } : {}),
  });
}

/** Ask for the payslips of a settled campaign: every payout with its own payslip (REQ-PAY-005). The caller must
 * already have shown the person what a payslip discloses. They are returned to the caller and kept nowhere else. */
export async function exportPayslips(id: string, signal?: AbortSignal): Promise<PayslipsExport> {
  return await request(campaignPath(id, "/payslips"), {
    parse: parsePayslipsExport,
    extraHeaders: { [DISCLOSURE_HEADER]: DISCLOSURE_ACKNOWLEDGEMENT },
    ...(signal ? { signal } : {}),
  });
}

/** The header that confirms a send-back, which moves money and cannot be undone (REQ-FUND-007). Sent only after the
 * person has confirmed where it goes (see InboxReturn). */
export const SEND_HEADER = "X-Zecdrop-Confirm-Send";

/** Send everything spendable in a payout's shielded deposit address, less the fee, back to the shielded address `to`. */
export async function returnInbox(id: string, to: string, signal?: AbortSignal): Promise<InboxReturnResponse> {
  return await request(campaignPath(id, "/inbox/return"), {
    method: "POST",
    body: { to },
    parse: parseInboxReturn,
    extraHeaders: { [SEND_HEADER]: DISCLOSURE_ACKNOWLEDGEMENT },
    ...(signal ? { signal } : {}),
  });
}

export async function startCampaign(id: string, signal?: AbortSignal): Promise<StartResponse> {
  return await request(campaignPath(id, "/start"), {
    method: "POST",
    parse: parseStartResponse,
    ...(signal ? { signal } : {}),
  });
}

// ---- NEAR Intents (funding from another coin) -----------------------------------------
//
// The operator is the only thing that talks to the price service. Three of these five calls
// create nothing (the asset list, a preview, a dry quote); `getNearLiveQuote` asks for a real
// deposit address and is sent only after the person has ticked the acknowledgement.

/** The assets a funder could pay with (never ZEC), as the operator lists them. */
export async function getNearTokens(signal?: AbortSignal): Promise<NearAsset[]> {
  return await request("/near/tokens", { parse: parseNearTokens, ...(signal ? { signal } : {}) });
}

/** A dry price for delivering `amountZat` zatoshi of mainnet ZEC. Creates nothing; works on testnet. */
export async function postNearPreview(
  input: { originAssetId: string; amountZat: string },
  signal?: AbortSignal,
): Promise<NearPriceView> {
  return await request("/near/preview", {
    method: "POST",
    body: { origin_asset_id: input.originAssetId, amount_zat: input.amountZat },
    parse: parseNearPreview,
    ...(signal ? { signal } : {}),
  });
}

/** A dry quote for exactly what a mainnet campaign needs. Creates nothing; good for ten minutes. */
export async function postNearDryQuote(
  id: string,
  input: { originAssetId: string; refundTo: string },
  signal?: AbortSignal,
): Promise<NearDryQuoteView> {
  return await request(campaignPath(id, "/funding/near/dry-quote"), {
    method: "POST",
    body: { origin_asset_id: input.originAssetId, refund_to: input.refundTo },
    parse: parseNearDryQuote,
    ...(signal ? { signal } : {}),
  });
}

/** The header that acknowledges a deposit address starts a real swap. */
export const NEAR_CONFIRM_HEADER = "X-Zecdrop-Confirm-Near";
export const NEAR_CONFIRM_ACKNOWLEDGEMENT = "I-UNDERSTAND";

/** Ask for a deposit address. Real money goes where this points: the caller must already have
 * shown the warning and got the person's agreement, and a dry quote must have just been taken. */
export async function postNearLiveQuote(id: string, signal?: AbortSignal): Promise<NearLiveQuoteView> {
  return await request(campaignPath(id, "/funding/near/live-quote"), {
    method: "POST",
    parse: parseNearLiveQuote,
    extraHeaders: { [NEAR_CONFIRM_HEADER]: NEAR_CONFIRM_ACKNOWLEDGEMENT },
    ...(signal ? { signal } : {}),
  });
}

/** Where the swap stands, as the operator's closed set of words. Never says the campaign is funded. */
export async function getNearStatus(id: string, signal?: AbortSignal): Promise<NearStatusView> {
  return await request(campaignPath(id, "/funding/near/status"), { parse: parseNearStatus, ...(signal ? { signal } : {}) });
}
