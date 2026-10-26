// What a receipt link asks the verifier to check.
//
// The verifier is key-less: it is not told which campaign this is, only which
// transactions to read and what the operator CLAIMS about them (the manifest
// commitment and the declared total). The same parameter names are used in
// the page URL (/r/<id>?...) and in the verifier call, so a link can be pasted
// straight into either.
//
//   network=testnet&tx=<txid>&tx=<txid>&commitment=<hex>&declared_total=<zatoshi>
//
// Everything in a link is already public chain data or a public claim about
// it. No recipient data can be expressed here: there is no field for it.

import type { ZecNetwork } from "@/lib/config";
import { isMoneyZatoshiString } from "@/lib/zec";

export interface ReceiptQuery {
  network: ZecNetwork;
  /** Batch transaction ids, 64 lowercase hex characters each, in batch order. */
  txids: readonly string[];
  /** Salted manifest commitment: 64 lowercase hex characters. */
  commitment: string;
  /** Zatoshi, decimal string: the total the operator declares. */
  declaredTotal: string;
}

export const RECEIPT_PARAMS = {
  network: "network",
  tx: "tx",
  commitment: "commitment",
  declaredTotal: "declared_total",
} as const;

/** Keeps links within what servers and browsers accept (64 chars per id). */
export const MAX_RECEIPT_TXIDS = 100;

export type LinkProblem =
  | "missing_network"
  | "bad_network"
  | "no_transactions"
  | "too_many_transactions"
  | "bad_transaction"
  | "duplicate_transaction"
  | "missing_commitment"
  | "bad_commitment"
  | "missing_declared_total"
  | "bad_declared_total"
  | "repeated_parameter";

/** Plain-language explanation. Never includes the offending value. */
export const LINK_PROBLEM_TEXT: Record<LinkProblem, string> = {
  missing_network: "The link does not say which network (testnet or mainnet) to check.",
  bad_network: "The network in the link is not testnet or mainnet.",
  no_transactions: "The link does not list any transactions to check.",
  too_many_transactions: `The link lists more than ${String(MAX_RECEIPT_TXIDS)} transactions.`,
  bad_transaction: "One of the transaction ids in the link is not valid.",
  duplicate_transaction: "A transaction id appears more than once in the link.",
  missing_commitment: "The link does not include the manifest commitment.",
  bad_commitment: "The manifest commitment in the link is not valid.",
  missing_declared_total: "The link does not include the declared total.",
  bad_declared_total: "The declared total in the link is not valid.",
  repeated_parameter: "The link repeats a value that should appear once.",
};

export type ReceiptLinkResult =
  | { ok: true; query: ReceiptQuery }
  | { ok: false; problem: LinkProblem };

const HEX32 = /^[0-9a-f]{64}$/u;

/** Marks a parameter that appeared more than once. A symbol, so no real value can equal it. */
const REPEATED = Symbol("repeated");

const fail = (problem: LinkProblem): ReceiptLinkResult => ({ ok: false, problem });

/** Read and strictly validate a receipt link. Unknown parameters are ignored
 * (a shared link may carry tracking junk) but never forwarded. */
export function parseReceiptLink(params: URLSearchParams): ReceiptLinkResult {
  const single = (name: string): string | null | typeof REPEATED => {
    const all = params.getAll(name);
    if (all.length > 1) return REPEATED;
    return all[0] ?? null;
  };

  const network = single(RECEIPT_PARAMS.network);
  const commitment = single(RECEIPT_PARAMS.commitment);
  const declaredTotal = single(RECEIPT_PARAMS.declaredTotal);
  if (network === REPEATED || commitment === REPEATED || declaredTotal === REPEATED) {
    return fail("repeated_parameter");
  }

  if (network === null) return fail("missing_network");
  if (network !== "testnet" && network !== "mainnet") return fail("bad_network");

  const txids = params.getAll(RECEIPT_PARAMS.tx);
  if (txids.length === 0) return fail("no_transactions");
  if (txids.length > MAX_RECEIPT_TXIDS) return fail("too_many_transactions");
  if (!txids.every((t) => HEX32.test(t))) return fail("bad_transaction");
  if (new Set(txids).size !== txids.length) return fail("duplicate_transaction");

  if (commitment === null) return fail("missing_commitment");
  if (!HEX32.test(commitment)) return fail("bad_commitment");

  if (declaredTotal === null) return fail("missing_declared_total");
  if (!isMoneyZatoshiString(declaredTotal)) return fail("bad_declared_total");

  return { ok: true, query: { network, txids, commitment, declaredTotal } };
}

/** The query string for a query: used for both the page link and the API call. */
export function receiptSearchParams(query: ReceiptQuery): URLSearchParams {
  const params = new URLSearchParams();
  params.set(RECEIPT_PARAMS.network, query.network);
  for (const txid of query.txids) params.append(RECEIPT_PARAMS.tx, txid);
  params.set(RECEIPT_PARAMS.commitment, query.commitment);
  params.set(RECEIPT_PARAMS.declaredTotal, query.declaredTotal);
  return params;
}
