// The link an operator hands out so someone else can check a campaign's
// receipt on the public page. It is built from the operator's receipt, which is
// public chain data plus two public claims (the commitment and the declared
// total). There is no field in it for a recipient, an amount or a memo.

import { parseReceiptLink, receiptSearchParams } from "@/api/receipt-query";
import type { PublicReceipt } from "@/api/types";

/** Why a link cannot be offered yet. */
export type NoLink = "no_transactions_yet" | "some_batches_not_built";

export type LinkResult = { ok: true; path: string; txCount: number } | { ok: false; reason: NoLink };

/** `/r/<campaign>?network=…&tx=…&commitment=…&declared_total=…`.
 *
 * Offered only when EVERY batch has a transaction id: the verifier compares the
 * declared total with the batches it is told about, so a link that leaves some
 * out would show a mismatch that is not real. */
export function receiptLinkPath(campaignId: string, receipt: PublicReceipt): LinkResult {
  if (receipt.batches.length === 0) return { ok: false, reason: "no_transactions_yet" };
  const txids: string[] = [];
  for (const batch of receipt.batches) {
    if (batch.txid === null) return { ok: false, reason: "some_batches_not_built" };
    txids.push(batch.txid);
  }
  const query = {
    network: receipt.network,
    txids,
    commitment: receipt.manifestCommitment,
    declaredTotal: receipt.declaredTotal,
  };
  // Never hand out a link the receipt page itself would refuse.
  const params = receiptSearchParams(query);
  if (!parseReceiptLink(params).ok) return { ok: false, reason: "some_batches_not_built" };
  return { ok: true, path: `/r/${encodeURIComponent(campaignId)}?${params.toString()}`, txCount: txids.length };
}

/** The full link when a public host is configured, else the path alone. */
export function withPublicHost(path: string, publicBase: string | null): { text: string; complete: boolean } {
  return publicBase === null ? { text: path, complete: false } : { text: `${publicBase}${path}`, complete: true };
}
