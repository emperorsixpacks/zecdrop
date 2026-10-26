// The public receipt page's verifier, as practice mode plays it. The real one reads a chain; this one has no chain, so it can
// read only what practice mode made: a transaction id it handed out is one it knows, and anything else is not. A real
// receipt link, a mainnet one, a payslip: it does not pretend to read them (the payslip check is refused outright).
//
// The answer is shaped as crates/drop-core/src/receipt.rs shapes a receipt built from chain facts (`from_chain_facts`): it is
// not told which campaign it is about (`campaign_id` is null), it echoes the commitment it was given and checks the declared
// total against the batches, it says "not yet confirmed" for a batch below the required depth, and its phase follows from
// its findings.

import type { ReceiptQuery } from "@/api/receipt-query";

import { receiptBatch, REQUIRED_DEPTH, type Campaign } from "./state";

interface Finding {
  code: string;
  batch_index?: number;
}

interface VerifierBatch {
  index: number;
  txid: string;
  funding_input: string | null;
  net_into_pool: string | null;
  fee: string | null;
  shielded_actions: number | null;
  pool: "ironwood" | null;
  confirmations: number;
}

/** Whether a finding means the campaign is wrong, as opposed to merely not yet final (`Finding::is_failure`). */
const isFailure = (finding: Finding): boolean => finding.code !== "tx_not_found" && finding.code !== "prevout_unresolved" && finding.code !== "batch_pending";

/** The receipt for what a link asks about, or null when none of its transactions is one practice mode made. */
export function receiptFromQuery(campaigns: Iterable<Campaign>, query: ReceiptQuery) {
  const known = new Map<string, { campaign: Campaign; index: number }>();
  for (const campaign of campaigns) {
    campaign.states.forEach((state, index) => {
      if (state.name !== "planned") known.set(state.txid, { campaign, index });
    });
  }
  if (!query.txids.some((txid) => known.has(txid))) return null;

  const findings: Finding[] = [];
  const batches: VerifierBatch[] = query.txids.map((txid, position) => {
    const found = known.get(txid);
    const funding = found?.campaign.funding;
    if (found === undefined || funding === null || funding === undefined) {
      findings.push({ code: "tx_not_found", batch_index: position });
      return {
        index: position,
        txid,
        funding_input: null,
        net_into_pool: null,
        fee: null,
        shielded_actions: null,
        pool: null,
        confirmations: 0,
      };
    }
    return { ...receiptBatch(found.campaign, found.index, funding), index: position, txid };
  });

  const located = batches.filter((batch) => batch.net_into_pool !== null);
  for (const batch of located) {
    if (batch.confirmations < REQUIRED_DEPTH) findings.push({ code: "batch_pending", batch_index: batch.index });
  }
  const everyNetKnown = located.length === batches.length;
  const netSum = located.reduce((sum, batch) => sum + BigInt(batch.net_into_pool ?? "0"), 0n);
  if (everyNetKnown && netSum.toString() !== query.declaredTotal) findings.push({ code: "declared_total_mismatch" });

  const finalWithoutFinding = batches.filter(
    (batch) => batch.confirmations >= REQUIRED_DEPTH && !findings.some((finding) => finding.batch_index === batch.index),
  ).length;
  const phase = findings.some(isFailure)
    ? { phase: "failed" as const }
    : findings.length === 0
      ? { phase: "settled" as const }
      : { phase: "sending" as const, done: finalWithoutFinding, total: batches.length };

  return {
    campaign_id: null,
    network: "testnet" as const,
    funding_address: null,
    declared_total: query.declaredTotal,
    fee_total: batches.every((batch) => batch.fee !== null) ? batches.reduce((sum, batch) => sum + BigInt(batch.fee ?? "0"), 0n).toString() : null,
    batches,
    manifest_commitment: query.commitment,
    phase,
    findings,
  };
}
