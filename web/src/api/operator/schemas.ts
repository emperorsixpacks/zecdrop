// What the local operator API sends, validated strictly.
//
// Built from REAL responses captured from `drop-operator --mock-chain`
// (fixtures/contract/operator, produced by scripts/capture-operator-fixtures.mjs)
// and from the serde types in crates/drop-operator and crates/drop-core. Every
// object is `.strict()`: a field the schema does not know about is an error,
// never silently dropped. In particular there is NO field anywhere here for a
// recipient's address, amount or memo, so none can be accepted or rendered
// (REQ-PRIV-001, REQ-PRIV-002). The operator's own responses carry counts,
// batch totals, txids, warnings and the commitment only.
//
// Wire is snake_case; the exported view types are camelCase.

import { z } from "zod";

import { parseWarningViews, type PrivacyWarning } from "@/api/warnings";
import {
  hex32Wire,
  outPointWire,
  phaseWire,
  RECEIPT_POOLS,
  u32Wire,
  zatoshiWire,
  type OutPointView,
  type ReceiptPool,
} from "@/api/types";
import type { PhaseState } from "@/lib/phase";

// ---- small pieces ----------------------------------------------------------

const campaignId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/u, "invalid campaign id");
const network = z.enum(["testnet", "mainnet"]);
/** Seconds since the Unix epoch, as a JS-safe integer. */
const unixSeconds = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const smallCount = z.number().int().min(0).max(1_000_000);
/** Text the server produced; bounded so a bad response cannot flood the page. */
const shortText = z.string().max(500);

// ---- health ------------------------------------------------------------------

export interface OperatorHealth {
  network: "testnet" | "mainnet";
  /** True on the fake in-process chain, false on a real one, null when the
   * operator did not say (an older build). Null is treated as "unknown": no
   * development controls, no claim either way. */
  mock: boolean | null;
}

const healthWire = z
  .object({ ok: z.literal(true), network, mock: z.boolean().optional() })
  .strict()
  .transform((h): OperatorHealth => ({ network: h.network, mock: h.mock ?? null }));

export function parseHealth(input: unknown): OperatorHealth {
  return healthWire.parse(input);
}

// ---- row errors (CSV import) -------------------------------------------------

const amountReason = z.discriminatedUnion("code", [
  z.object({ code: z.literal("empty") }).strict(),
  z.object({ code: z.literal("negative") }).strict(),
  z.object({ code: z.literal("scientific_notation") }).strict(),
  z.object({ code: z.literal("invalid_character") }).strict(),
  z.object({ code: z.literal("malformed_decimal") }).strict(),
  z.object({ code: z.literal("too_many_decimals") }).strict(),
  z.object({ code: z.literal("exceeds_max_money") }).strict(),
]);

const addressReason = z.discriminatedUnion("code", [
  z.object({ code: z.literal("empty") }).strict(),
  z.object({ code: z.literal("malformed"), reason: shortText }).strict(),
  z.object({ code: z.literal("wrong_network") }).strict(),
  z.object({ code: z.literal("unsupported_receiver") }).strict(),
  z.object({ code: z.literal("transparent_not_allowed") }).strict(),
]);

const columnName = z.enum(["address", "amount", "memo"]);

const rowErrorKind = z.discriminatedUnion("code", [
  z.object({ code: z.literal("missing_header") }).strict(),
  z.object({ code: z.literal("unknown_column"), position: smallCount }).strict(),
  z.object({ code: z.literal("duplicate_column"), name: columnName }).strict(),
  z.object({ code: z.literal("missing_column"), name: columnName }).strict(),
  z.object({ code: z.literal("field_count"), expected: smallCount, found: smallCount }).strict(),
  z.object({ code: z.literal("unterminated_quote") }).strict(),
  z.object({ code: z.literal("malformed_quote") }).strict(),
  z.object({ code: z.literal("missing_address") }).strict(),
  z.object({ code: z.literal("invalid_address"), reason: addressReason }).strict(),
  z.object({ code: z.literal("invalid_amount"), reason: amountReason }).strict(),
  z.object({ code: z.literal("zero_amount") }).strict(),
  z.object({ code: z.literal("memo_too_long"), bytes: smallCount, max: smallCount }).strict(),
  z.object({ code: z.literal("duplicate_address"), first_line: z.number().int().min(1) }).strict(),
]);

/** One problem with one line of the CSV. Never carries the line's content. */
export interface RowError {
  /** 1-based line number where the offending record starts. */
  line: number;
  /** The server's sentence. Static text plus numbers, never the input. */
  message: string;
  /** The kind, e.g. "invalid_amount". */
  code: z.infer<typeof rowErrorKind>["code"];
  /** For `duplicate_address`: the line of the first occurrence. */
  firstLine?: number;
}

const rowErrorWire = z
  .object({ line: z.number().int().min(1), kind: rowErrorKind, message: shortText })
  .strict()
  .transform((e): RowError => {
    const base = { line: e.line, message: e.message, code: e.kind.code };
    return e.kind.code === "duplicate_address" ? { ...base, firstLine: e.kind.first_line } : base;
  });

// ---- errors ------------------------------------------------------------------

export type OperatorError =
  | { code: "import_failed"; message: string; errorCount: number; errors: RowError[] }
  | { code: "insufficient_funding"; message: string; required?: string; observed?: string }
  | { code: "funding_conflict"; message: string; recorded: { outpoint: OutPointView; amount: string } }
  /** The key was asked for without the acknowledgement header. Carries the disclosure warning. */
  | { code: "confirmation_required"; message: string; warning: string }
  /** The deposit address was made but could not be kept: it is said here so it is not stranded. */
  | { code: "near_quote_not_saved"; message: string; depositAddress: string; deadline: string | null }
  | { code: string; message: string };

const errorWire = z.union([
  z
    .object({
      code: z.literal("import_failed"),
      message: shortText,
      error_count: smallCount,
      errors: z.array(rowErrorWire).max(200),
    })
    .strict()
    .transform(
      (e): OperatorError => ({
        code: "import_failed",
        message: e.message,
        errorCount: e.error_count,
        errors: e.errors,
      }),
    ),
  z
    .object({
      code: z.literal("insufficient_funding"),
      message: shortText,
      required: zatoshiWire,
      observed: zatoshiWire,
    })
    .strict()
    .transform(
      (e): OperatorError => ({
        code: "insufficient_funding",
        message: e.message,
        required: e.required,
        observed: e.observed,
      }),
    ),
  z
    .object({
      code: z.literal("funding_conflict"),
      message: shortText,
      recorded: z.object({ outpoint: outPointWire, amount: zatoshiWire }).strict(),
    })
    .strict()
    .transform(
      (e): OperatorError => ({
        code: "funding_conflict",
        message: e.message,
        recorded: e.recorded,
      }),
    ),
  z
    .object({ code: z.literal("confirmation_required"), message: shortText, warning: z.string().min(1).max(2_000) })
    .strict()
    .transform(
      (e): OperatorError => ({ code: "confirmation_required", message: e.message, warning: e.warning }),
    ),
  z
    .object({
      code: z.literal("near_quote_not_saved"),
      message: shortText,
      deposit_address: z.string().min(1).max(128),
      deadline: z.string().min(1).max(40).nullable(),
    })
    .strict()
    .transform(
      (e): OperatorError => ({ code: "near_quote_not_saved", message: e.message, depositAddress: e.deposit_address, deadline: e.deadline }),
    ),
  // Every other error is just a code and a sentence.
  z
    .object({ code: z.string().min(1).max(64), message: shortText })
    .strict()
    .transform((e): OperatorError => ({ code: e.code, message: e.message })),
]);

/** Every error code the page has a sentence for (see features/operator/messages.ts;
 * messages.test.ts fails if the operator's source raises one that is missing here).
 * A code NOT in this list is not an error in the page: it is shown with a sentence
 * chosen by its HTTP status and the operator's own words, and its extra fields
 * are ignored. A code that IS in the list keeps the strict shape. */
export const KNOWN_ERROR_CODES = [
  "unauthorized",
  "not_found",
  "not_funded",
  "insufficient_funding",
  "funding_conflict",
  "invalid_name",
  "plan_failed",
  "batch_size_too_large",
  "amount_too_large",
  "csv_too_large",
  "body_too_large",
  "import_failed",
  "dev_only",
  "invalid_body",
  "invalid_outpoint",
  "unsupported_media_type",
  "unreadable_body",
  "internal_error",
  "needs_funding_split",
  "wrong_wallet_seed",
  "chain_unavailable",
  "not_applicable",
  "not_available",
  "confirmation_required",
  "account_registry_error",
  "host_not_allowed",
  "store_corrupt",
  // The NEAR Intents funding routes.
  "near_unavailable",
  "near_rejected",
  "near_unauthorized",
  "near_quote_mismatch",
  "near_bad_response",
  "near_zec_not_listed",
  "near_quote_not_saved",
  "mainnet_not_enabled",
  "amount_out_of_range",
  "already_funded",
  "live_quote_exists",
  "no_dry_quote",
  "dry_quote_expired",
  "dry_quote_stale",
  "no_live_quote",
  "unknown_origin_asset",
  "zec_origin_not_allowed",
  "invalid_refund_address",
] as const;

const KNOWN = new Set<string>(KNOWN_ERROR_CODES);

/** `{ error: { code, message, ... } }` and nothing beside `error`. */
const errorShell = z
  .object({ error: z.looseObject({ code: z.string().min(1).max(64), message: shortText }) })
  .strict();

/** Parse an error body: `{"error": {"code", "message", ...details}}`.
 *
 * Known codes are parsed strictly. An unknown code (the operator is newer than
 * this page) degrades: its code and message are kept, anything else it carries
 * is dropped and never shown. A body that is not an error envelope at all throws. */
export function parseOperatorError(input: unknown): OperatorError {
  const { code, message } = errorShell.parse(input).error;
  if (!KNOWN.has(code)) return { code, message };
  return errorWire.parse((input as { error: unknown }).error);
}

// ---- campaigns ---------------------------------------------------------------

export const BATCH_STATES = ["planned", "built", "broadcast", "confirmed", "failed"] as const;
export type BatchStateName = (typeof BATCH_STATES)[number];

export type RunState =
  | { state: "idle" }
  | { state: "running" }
  | { state: "settled" }
  | { state: "halted" }
  | { state: "stalled"; error: string }
  | { state: "crashed" };

const runWire = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle") }).strict(),
  z.object({ state: z.literal("running") }).strict(),
  z.object({ state: z.literal("settled") }).strict(),
  z.object({ state: z.literal("halted") }).strict(),
  z.object({ state: z.literal("stalled"), error: shortText }).strict(),
  z.object({ state: z.literal("crashed") }).strict(),
]);

export interface OperatorBatch {
  index: number;
  /** How many recipients: a count, public as the batch's action count. */
  recipients: number;
  /** Zatoshi: the batch's total, public as the value entering the pool. */
  total: string;
  fee: string;
  /** Total plus fee. */
  fundingRequired: string;
  state: BatchStateName;
  txid: string | null;
  confirmations: number;
  /** Why a batch failed. Server text, free of recipient data. */
  reason: string | null;
}

const batchWire = z
  .object({
    index: u32Wire,
    recipients: u32Wire,
    total: zatoshiWire,
    fee: zatoshiWire,
    funding_required: zatoshiWire,
    state: z.enum(BATCH_STATES),
    txid: hex32Wire.nullable(),
    confirmations: u32Wire,
    reason: shortText.nullable(),
  })
  .strict()
  .transform(
    (b): OperatorBatch => ({
      index: b.index,
      recipients: b.recipients,
      total: b.total,
      fee: b.fee,
      fundingRequired: b.funding_required,
      state: b.state,
      txid: b.txid,
      confirmations: b.confirmations,
      reason: b.reason,
    }),
  );

export interface FeePolicyView {
  marginalFee: number;
  graceActions: number;
}

const feePolicyWire = z
  .object({ marginal_fee: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), grace_actions: u32Wire })
  .strict()
  .transform((f): FeePolicyView => ({ marginalFee: f.marginal_fee, graceActions: f.grace_actions }));

const fundingWire = z
  .object({ outpoint: outPointWire, amount: zatoshiWire })
  .strict()
  .transform((f) => ({ outpoint: f.outpoint, amount: f.amount }));

/** What the funding poll has seen at the campaign's address (real chain only).
 * The mock chain always answers `null`, so this shape comes from
 * fixtures/contract/operator/golden/ (written by the operator's own Rust test)
 * and `FundingProgress` in crates/drop-operator/src/state.rs, not from a real node. */
export interface FundingProgressView {
  outpoint: OutPointView;
  /** Zatoshi. */
  amount: string;
  confirmations: number;
  requiredDepth: number;
  /** Whether the value covers the declared total plus fees. */
  sufficient: boolean;
}

const fundingProgressWire = z
  .object({
    outpoint: outPointWire,
    amount: zatoshiWire,
    confirmations: u32Wire,
    required_depth: u32Wire,
    sufficient: z.boolean(),
  })
  .strict()
  .transform(
    (p): FundingProgressView => ({
      outpoint: p.outpoint,
      amount: p.amount,
      confirmations: p.confirmations,
      requiredDepth: p.required_depth,
      sufficient: p.sufficient,
    }),
  );

/** An address the server produced. Bounded and free of whitespace. */
const addressText = z.string().min(1).max(512).regex(/^\S+$/u, "address contains whitespace");

export interface OperatorCampaign {
  id: string;
  name: string;
  network: "testnet" | "mainnet";
  pool: ReceiptPool;
  /** Seconds since the Unix epoch. */
  createdAt: number;
  phase: PhaseState;
  recipientCount: number;
  batchCount: number;
  maxOutputsPerBatch: number;
  feePolicy: FeePolicyView;
  declaredTotal: string;
  feeTotal: string;
  fundingRequired: string;
  manifestCommitment: string;
  /** False when the wallet in use is not the one this campaign was created with:
   * it can then be neither funded nor run from this operator. */
  walletMatches: boolean;
  /** Where to send the deposit. `null` on the mock chain and when the wallet does not match. */
  fundingAddress: string | null;
  funding: { outpoint: OutPointView; amount: string } | null;
  /** The best candidate deposit seen so far, while the campaign is unfunded. */
  fundingProgress: FundingProgressView | null;
  batches: OperatorBatch[];
  warnings: PrivacyWarning[];
  run: RunState;
}

const campaignWire = z
  .object({
    id: campaignId,
    name: z.string().min(1).max(100),
    network,
    pool: z.enum(RECEIPT_POOLS),
    created_at: unixSeconds,
    phase: phaseWire,
    phase_label: shortText,
    recipient_count: u32Wire,
    batch_count: u32Wire,
    max_outputs_per_batch: z.number().int().min(1).max(1_000_000),
    fee_policy: feePolicyWire,
    declared_total: zatoshiWire,
    fee_total: zatoshiWire,
    funding_required: zatoshiWire,
    manifest_commitment: hex32Wire,
    wallet_matches: z.boolean(),
    funding_address: addressText.nullable(),
    funding: fundingWire.nullable(),
    funding_progress: fundingProgressWire.nullable(),
    batches: z.array(batchWire).max(10_000),
    warnings: z.unknown().transform((value, ctx) => {
      try {
        return parseWarningViews(value);
      } catch {
        ctx.addIssue({ code: "custom", message: "warnings are not in the expected shape" });
        return z.NEVER;
      }
    }),
    run: runWire,
  })
  .strict()
  .transform(
    (c): OperatorCampaign => ({
      id: c.id,
      name: c.name,
      network: c.network,
      pool: c.pool,
      createdAt: c.created_at,
      phase: c.phase,
      recipientCount: c.recipient_count,
      batchCount: c.batch_count,
      maxOutputsPerBatch: c.max_outputs_per_batch,
      feePolicy: c.fee_policy,
      declaredTotal: c.declared_total,
      feeTotal: c.fee_total,
      fundingRequired: c.funding_required,
      manifestCommitment: c.manifest_commitment,
      walletMatches: c.wallet_matches,
      fundingAddress: c.funding_address,
      funding: c.funding,
      fundingProgress: c.funding_progress,
      batches: c.batches,
      warnings: c.warnings,
      run: c.run,
    }),
  );

export function parseCampaign(input: unknown): OperatorCampaign {
  return campaignWire.parse(input);
}

export interface OperatorCampaignSummary {
  id: string;
  name: string;
  network: "testnet" | "mainnet";
  pool: ReceiptPool;
  createdAt: number;
  phase: PhaseState;
  recipientCount: number;
  batchCount: number;
  declaredTotal: string;
}

const summaryWire = z
  .object({
    id: campaignId,
    name: z.string().min(1).max(100),
    network,
    pool: z.enum(RECEIPT_POOLS),
    created_at: unixSeconds,
    phase: phaseWire,
    phase_label: shortText,
    recipient_count: u32Wire,
    batch_count: u32Wire,
    declared_total: zatoshiWire,
  })
  .strict()
  .transform(
    (c): OperatorCampaignSummary => ({
      id: c.id,
      name: c.name,
      network: c.network,
      pool: c.pool,
      createdAt: c.created_at,
      phase: c.phase,
      recipientCount: c.recipient_count,
      batchCount: c.batch_count,
      declaredTotal: c.declared_total,
    }),
  );

export function parseCampaignList(input: unknown): OperatorCampaignSummary[] {
  return z.array(summaryWire).max(10_000).parse(input);
}

// ---- exporting the viewing key ----------------------------------------------------------
//
// The mock chain answers 409 `not_available`, so the success shape comes from
// fixtures/contract/operator/golden/audit-ufvk-export.json (written by the
// operator's own Rust test) and `export_ufvk` in crates/drop-operator/src/api.rs,
// not from a real node. The response carries a `warning` that the person must be
// shown before the key leaves the screen.

export interface ViewingKeyExport {
  /** The operator's disclosure warning. Shown to the person, never skipped. */
  warning: string;
  campaignId: string;
  network: "testnet" | "mainnet";
  /** The unified full viewing key. Whoever holds it sees every payout. */
  ufvk: string;
}

const viewingKeyWire = z
  .object({
    warning: z.string().min(1).max(2_000),
    campaign_id: campaignId,
    network,
    ufvk: z.string().min(1).max(8_192).regex(/^\S+$/u, "key contains whitespace"),
  })
  .strict()
  .transform(
    (k): ViewingKeyExport => ({ warning: k.warning, campaignId: k.campaign_id, network: k.network, ufvk: k.ufvk }),
  );

export function parseViewingKeyExport(input: unknown): ViewingKeyExport {
  return viewingKeyWire.parse(input);
}

// ---- starting a run ------------------------------------------------------------

export interface StartResponse {
  /** False when a run was already in progress. */
  started: boolean;
  run: RunState;
}

const startWire = z
  .object({ started: z.boolean(), run: runWire })
  .strict()
  .transform((s): StartResponse => ({ started: s.started, run: s.run }));

export function parseStartResponse(input: unknown): StartResponse {
  return startWire.parse(input);
}

// ---- progress events (the SSE stream) ------------------------------------------

export type ProgressEvent =
  | { event: "built"; batchIndex: number; txid: string; outputs: number }
  | { event: "broadcast"; batchIndex: number; txid: string }
  | { event: "confirmed"; batchIndex: number; txid: string; depth: number; requiredDepth: number }
  | { event: "waiting"; batchIndex: number; observedDepth: number; requiredDepth: number }
  | { event: "failed"; batchIndex: number; reason: string }
  | { event: "halted"; failedBatches: number[] }
  | { event: "settled"; campaignId: string; batches: number };

const eventWire = z
  .discriminatedUnion("event", [
    z.object({ event: z.literal("built"), batch_index: u32Wire, txid: hex32Wire, outputs: u32Wire }).strict(),
    z.object({ event: z.literal("broadcast"), batch_index: u32Wire, txid: hex32Wire }).strict(),
    z
      .object({
        event: z.literal("confirmed"),
        batch_index: u32Wire,
        txid: hex32Wire,
        depth: u32Wire,
        required_depth: u32Wire,
      })
      .strict(),
    z
      .object({
        event: z.literal("waiting"),
        batch_index: u32Wire,
        observed_depth: u32Wire,
        required_depth: u32Wire,
      })
      .strict(),
    z.object({ event: z.literal("failed"), batch_index: u32Wire, reason: shortText }).strict(),
    z.object({ event: z.literal("halted"), failed_batches: z.array(u32Wire).max(10_000) }).strict(),
    z.object({ event: z.literal("settled"), campaign_id: campaignId, batches: u32Wire }).strict(),
  ])
  .transform((e): ProgressEvent => {
    switch (e.event) {
      case "built":
        return { event: "built", batchIndex: e.batch_index, txid: e.txid, outputs: e.outputs };
      case "broadcast":
        return { event: "broadcast", batchIndex: e.batch_index, txid: e.txid };
      case "confirmed":
        return {
          event: "confirmed",
          batchIndex: e.batch_index,
          txid: e.txid,
          depth: e.depth,
          requiredDepth: e.required_depth,
        };
      case "waiting":
        return {
          event: "waiting",
          batchIndex: e.batch_index,
          observedDepth: e.observed_depth,
          requiredDepth: e.required_depth,
        };
      case "failed":
        return { event: "failed", batchIndex: e.batch_index, reason: e.reason };
      case "halted":
        return { event: "halted", failedBatches: e.failed_batches };
      case "settled":
        return { event: "settled", campaignId: e.campaign_id, batches: e.batches };
    }
  });

export function parseProgressEvent(input: unknown): ProgressEvent {
  return eventWire.parse(input);
}

/** True for the events after which the server closes the stream. */
export function isTerminalEvent(event: ProgressEvent): boolean {
  return event.event === "settled" || event.event === "halted";
}
