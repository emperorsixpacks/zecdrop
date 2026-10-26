// What the operator's NEAR Intents routes send, validated strictly.
//
// Built from the operator's own golden files (fixtures/contract/operator/golden/near-*.json): the token
// list, the preview and the dry quote are CAPTURED shapes; the live quote and the statuses are written
// from the operator's documentation and its source (crates/drop-operator/src/api_near.rs), and say so.
// Every object is `.strict()`: a field the page does not know is an error, never quietly dropped.
//
// What the page is told is either a number checked to be a number, plain text (letters, digits and
// . - _ : +), or a word from a closed set: the operator never repeats the service's own sentences.
// Nothing here can say a campaign is funded: `campaign_funded` is read and not used for that (a
// campaign is funded only when the operator sees the coin on chain, and says so in its own fields).

import { z } from "zod";

import { hex32Wire, zatoshiWire } from "@/api/types";

/** An integer in a token's smallest unit, as text. */
const smallestUnits = z.string().regex(/^[0-9]{1,40}$/u);
/** A decimal figure ("7.679013"), as text. */
const decimalText = z.string().regex(/^[0-9]{1,30}(\.[0-9]{1,30})?$/u);
/** What the operator checked to be plain: an address, a memo, an asset id. */
const plain = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9._:+-]+$/u);
/** A time as the operator writes it, e.g. 2026-10-08T06:00:00Z. */
const timeText = z.string().min(20).max(40).regex(/^[0-9T:.Z-]+$/u);
const seconds = z.number().int().min(0).max(10_000_000);

const assetWire = z
  .object({
    asset_id: plain(200),
    blockchain: plain(40),
    decimals: z.number().int().min(0).max(36),
    symbol: plain(40),
  })
  .strict();

export interface NearAsset {
  /** The service's id for it, passed back to ask for a price in it. */
  id: string;
  symbol: string;
  /** The chain it lives on, e.g. "near", "eth", "sol". */
  chain: string;
  decimals: number;
}

const asAsset = (a: z.infer<typeof assetWire>): NearAsset => ({ id: a.asset_id, symbol: a.symbol, chain: a.blockchain, decimals: a.decimals });

// ---- GET /api/near/tokens ---------------------------------------------------------

const tokensWire = z
  .object({ count: z.number().int().min(0).max(100_000), tokens: z.array(assetWire).max(5_000) })
  .strict()
  .transform((t) => t.tokens.map(asAsset));

export function parseNearTokens(input: unknown): NearAsset[] {
  return tokensWire.parse(input);
}

// ---- prices -----------------------------------------------------------------------

/** What delivering the campaign's ZEC would cost, in the funder's asset. */
export interface NearPriceView {
  token: NearAsset;
  /** What the funder would send, in the token's smallest unit. */
  amountIn: string;
  /** What the campaign would receive, in zatoshi. */
  amountOut: string;
  /** How long the service says it takes, if it says. */
  timeEstimateSeconds: number | null;
}

const previewWire = z
  .object({
    amount_in: smallestUnits,
    amount_in_formatted: decimalText.nullable(),
    amount_in_usd: decimalText.nullable(),
    amount_out_zat: zatoshiWire,
    destination_asset: assetWire,
    min_amount_in: smallestUnits.nullable(),
    note: z.string().max(1_000),
    origin_asset: assetWire,
    preview: z.literal(true),
    slippage_bps: z.number().int().min(0).max(10_000),
    time_estimate_seconds: seconds.nullable(),
  })
  .strict()
  .transform((p): NearPriceView => ({ token: asAsset(p.origin_asset), amountIn: p.amount_in, amountOut: p.amount_out_zat, timeEstimateSeconds: p.time_estimate_seconds }));

/** `POST /api/near/preview`: a dry quote that creates nothing. */
export function parseNearPreview(input: unknown): NearPriceView {
  return previewWire.parse(input);
}

export interface NearDryQuoteView extends NearPriceView {
  /** How long it stays good, in seconds (ten minutes). */
  validForSeconds: number;
}

const dryWire = z
  .object({
    amount_in: smallestUnits,
    amount_in_formatted: decimalText.nullable(),
    amount_in_usd: decimalText.nullable(),
    campaign_funding_address: plain(128),
    campaign_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/u),
    dry: z.literal(true),
    expires_at: timeText,
    funding_required_zat: zatoshiWire,
    min_amount_in: smallestUnits.nullable(),
    note: z.string().max(1_000),
    origin_asset: assetWire,
    time_estimate_seconds: seconds.nullable(),
    valid_for_seconds: seconds,
  })
  .strict()
  .transform(
    (q): NearDryQuoteView => ({
      token: asAsset(q.origin_asset),
      amountIn: q.amount_in,
      amountOut: q.funding_required_zat,
      timeEstimateSeconds: q.time_estimate_seconds,
      validForSeconds: q.valid_for_seconds,
    }),
  );

/** `POST /api/campaigns/{id}/funding/near/dry-quote` (mainnet campaigns). */
export function parseNearDryQuote(input: unknown): NearDryQuoteView {
  return dryWire.parse(input);
}

// ---- the deposit address ----------------------------------------------------------

export interface NearLiveQuoteView extends NearPriceView {
  depositAddress: string;
  depositMemo: string | null;
  deadline: string | null;
  validUntil: string;
  refundTo: string;
}

const liveWire = z
  .object({
    amount_in: smallestUnits,
    amount_in_formatted: decimalText.nullable(),
    campaign_funded: z.boolean(),
    campaign_funding_address: plain(128),
    deadline: timeText.nullable(),
    deposit_address: plain(128),
    deposit_memo: plain(64).nullable(),
    instructions: z.array(z.string().max(600)).max(10),
    live: z.literal(true),
    origin_asset: assetWire,
    refund_to: plain(200),
    valid_until: timeText,
    zec_out_zat: zatoshiWire,
  })
  .strict()
  .transform(
    (q): NearLiveQuoteView => ({
      token: asAsset(q.origin_asset),
      amountIn: q.amount_in,
      amountOut: q.zec_out_zat,
      timeEstimateSeconds: null,
      depositAddress: q.deposit_address,
      depositMemo: q.deposit_memo,
      deadline: q.deadline,
      validUntil: q.valid_until,
      refundTo: q.refund_to,
    }),
  );

/** `POST /api/campaigns/{id}/funding/near/live-quote`. Written from the documentation: never captured. */
export function parseNearLiveQuote(input: unknown): NearLiveQuoteView {
  return liveWire.parse(input);
}

// ---- where the swap stands --------------------------------------------------------

/** The closed set of words the operator uses for the service's statuses. */
export const NEAR_STATUS_WORDS = [
  "pending_deposit",
  "known_deposit_tx",
  "processing",
  "success",
  "incomplete_deposit",
  "refunded",
  "failed",
  "unknown",
] as const;

export const NEAR_STEPS = [
  "await_deposit",
  "await_swap",
  "verify_on_chain",
  "top_up_or_await_refund",
  "ended_refunded",
  "ended_failed",
  "investigate",
] as const;

export interface NearStatusView {
  status: (typeof NEAR_STATUS_WORDS)[number];
  step: (typeof NEAR_STEPS)[number];
  /** Whether the operator's own record says the campaign is funded (it is the operator that decides, never the service). */
  campaignFunded: boolean;
  /** The swap's deposit address, as the operator kept it. */
  depositAddress: string;
  expired: boolean;
  validUntil: string;
  zecTxids: string[];
}

const statusWire = z
  .object({
    campaign_funded: z.boolean(),
    deposit_address: plain(128),
    expired: z.boolean(),
    message: z.string().max(500),
    status: z.enum(NEAR_STATUS_WORDS),
    step: z.enum(NEAR_STEPS),
    valid_until: timeText,
    zec_txids: z.array(hex32Wire).max(20),
  })
  .strict()
  .transform(
    (s): NearStatusView => ({
      status: s.status,
      step: s.step,
      campaignFunded: s.campaign_funded,
      depositAddress: s.deposit_address,
      expired: s.expired,
      validUntil: s.valid_until,
      zecTxids: s.zec_txids,
    }),
  );

/** `GET /api/campaigns/{id}/funding/near/status`. Written from the documentation: never captured. */
export function parseNearStatus(input: unknown): NearStatusView {
  return statusWire.parse(input);
}
