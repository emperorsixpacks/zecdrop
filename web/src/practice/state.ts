// A practice campaign, and what the operator would say about it. The shapes are the operator's own (crates/drop-operator/src/
// api.rs, crates/drop-core/src/receipt.rs and phase.rs), and the page checks every one of them with the same strict parsers it
// uses for the real thing, so a field this file gets wrong is a page that refuses to draw.
//
// What is held per campaign is what the public chain would show and the operator's API already carries: counts, batch
// totals, fees, ids and the order things happened in. Not an address, an amount of a person, or a memo.

import type { FundingSource } from "@/api/types";
import { FEE_POLICIES, type FeePolicyName } from "@/lib/fees";

import type { Plan } from "./plan";

/** How many confirmations a batch needs before it counts as final. */
export const REQUIRED_DEPTH = 3;

export type BatchState =
  | { name: "planned" }
  | { name: "built"; txid: string }
  | { name: "broadcast"; txid: string }
  | { name: "confirmed"; txid: string; depth: number };

export interface Funding {
  txid: string;
  vout: number;
  /** Zatoshi. */
  amount: bigint;
  /** What the pretend deposit was said to spend (`fund-observed`'s `source`), or null when it was not said. */
  source: FundingSource | null;
}

export type RunName = "idle" | "running" | "settled";

/** A progress event as the operator sends it, in the wire's own words. */
export type WireEvent =
  | { event: "built"; batch_index: number; txid: string; outputs: number }
  | { event: "broadcast"; batch_index: number; txid: string }
  | { event: "waiting"; batch_index: number; observed_depth: number; required_depth: number }
  | { event: "confirmed"; batch_index: number; txid: string; depth: number; required_depth: number }
  | { event: "settled"; campaign_id: string; batches: number };

export const isTerminal = (event: WireEvent): boolean => event.event === "settled";

export interface Campaign {
  id: string;
  name: string;
  /** Seconds since the Unix epoch. */
  createdAt: number;
  policy: FeePolicyName;
  maxOutputs: number;
  plan: Plan;
  /** 64 hex characters that begin with the practice marker. */
  commitment: string;
  funding: Funding | null;
  states: BatchState[];
  run: RunName;
  /** Everything the run has said so far, in order: a new listener is told it all first. */
  events: WireEvent[];
  listeners: Set<(event: WireEvent) => void>;
}

// ---- the phase ------------------------------------------------------------------------------------

export type PhaseView =
  | { phase: "awaiting_funding" }
  | { phase: "funded" }
  | { phase: "sending"; done: number; total: number }
  | { phase: "settled" };

const isFinal = (state: BatchState): boolean => state.name === "confirmed" && state.depth >= REQUIRED_DEPTH;

/** `derive_phase`: settled when every batch is final, sending once any batch is past planned, else what funding says. */
export function derivePhase(funded: boolean, states: readonly BatchState[]): PhaseView {
  const total = states.length;
  const done = states.filter(isFinal).length;
  if (total > 0 && done === total) return { phase: "settled" };
  if (states.some((state) => state.name !== "planned")) return { phase: "sending", done, total };
  return funded ? { phase: "funded" } : { phase: "awaiting_funding" };
}

function phaseLabel(phase: PhaseView): string {
  switch (phase.phase) {
    case "awaiting_funding":
      return "Waiting for funds";
    case "funded":
      return "Funded, ready to send";
    case "sending":
      return `Sending: ${String(phase.done)} of ${String(phase.total)} batches confirmed`;
    case "settled":
      return "Complete: all batches confirmed";
  }
}

// ---- what the operator says about a campaign -----------------------------------------------------------

const stateName = (state: BatchState): "planned" | "built" | "broadcast" | "confirmed" => state.name;
const txidOf = (state: BatchState | undefined): string | null => (state === undefined || state.name === "planned" ? null : state.txid);

/** `GET /campaigns/{id}`, and what creating one and recording its deposit answer. */
export function campaignView(campaign: Campaign) {
  const { plan } = campaign;
  const phase = derivePhase(campaign.funding !== null, campaign.states);
  const policy = FEE_POLICIES[campaign.policy];
  return {
    id: campaign.id,
    name: campaign.name,
    network: "testnet" as const,
    pool: "ironwood" as const,
    created_at: campaign.createdAt,
    phase,
    phase_label: phaseLabel(phase),
    recipient_count: plan.recipientCount,
    batch_count: plan.batches.length,
    max_outputs_per_batch: campaign.maxOutputs,
    fee_policy: { marginal_fee: Number(policy.marginalFee), grace_actions: Number(policy.graceActions) },
    declared_total: plan.declaredTotal.toString(),
    fee_total: plan.feeTotal.toString(),
    funding_required: plan.required.toString(),
    manifest_commitment: campaign.commitment,
    wallet_matches: true,
    // The practice chain has no address to pay: the deposit is declared, not sent.
    funding_address: null,
    funding:
      campaign.funding === null
        ? null
        : { outpoint: `${campaign.funding.txid}:${String(campaign.funding.vout)}`, amount: campaign.funding.amount.toString() },
    funding_progress: null,
    // Only what the pretend deposit declared: the practice chain has no deposit transaction to read.
    funding_source: campaign.funding?.source ?? null,
    // Practice mode has no shielded deposit address (REQ-FUND-008): the pretend deposit stands in for it.
    inbox: null,
    batches: plan.batches.map((batch, index) => {
      const state = campaign.states[index];
      return {
        index: batch.index,
        recipients: batch.recipients,
        total: batch.total.toString(),
        fee: batch.fee.toString(),
        funding_required: batch.required.toString(),
        state: state === undefined ? "planned" : stateName(state),
        txid: txidOf(state),
        confirmations: state?.name === "confirmed" ? state.depth : 0,
        reason: null,
      };
    }),
    warnings: plan.warnings,
    run: { state: campaign.run },
  };
}

/** One row of `GET /campaigns`. */
export function summaryView(campaign: Campaign) {
  const full = campaignView(campaign);
  return {
    id: full.id,
    name: full.name,
    network: full.network,
    pool: full.pool,
    created_at: full.created_at,
    phase: full.phase,
    phase_label: full.phase_label,
    recipient_count: full.recipient_count,
    batch_count: full.batch_count,
    declared_total: full.declared_total,
  };
}

// ---- the receipt -------------------------------------------------------------------------------------------

/** What a receipt says about one batch: public facts only. A batch with no transaction yet says so with nulls. */
function receiptBatch(campaign: Campaign, index: number, funding: Funding) {
  const batch = campaign.plan.batches[index];
  const state = campaign.states[index];
  return {
    index,
    txid: txidOf(state),
    funding_input: `${funding.txid}:${String(funding.vout + index)}`,
    net_into_pool: (batch?.total ?? 0n).toString(),
    fee: (batch?.fee ?? 0n).toString(),
    // The builder pads a shielded bundle to two actions.
    shielded_actions: Math.max(batch?.recipients ?? 0, 2),
    pool: "ironwood" as const,
    confirmations: state?.name === "confirmed" ? state.depth : 0,
  };
}

/** `GET /campaigns/{id}/receipt`: the receipt the operator builds, once the campaign has its deposit. */
export function operatorReceiptView(campaign: Campaign, funding: Funding) {
  return {
    campaign_id: campaign.id,
    network: "testnet" as const,
    funding_address: null,
    funding_source: funding.source,
    declared_total: campaign.plan.declaredTotal.toString(),
    fee_total: campaign.plan.feeTotal.toString(),
    batches: campaign.plan.batches.map((_, index) => receiptBatch(campaign, index, funding)),
    manifest_commitment: campaign.commitment,
    phase: derivePhase(true, campaign.states),
    findings: [] as { code: string; batch_index?: number }[],
  };
}

export { receiptBatch };
