// What the NEAR funding panel shows, as the panel's own types.
//
// These are the UI's view of a token, a price and a deposit. They are NOT the
// operator's wire format: the operator's NEAR routes have their own response
// shapes, which are parsed with strict schemas (written from the operator's
// golden files) and mapped into these. Keeping the two apart means the panel and
// its tests never depend on a guess about the wire.

/** An asset a funder could pay with. */
export interface NearToken {
  /** The service's id for it, passed back to ask for a price in it. */
  id: string;
  symbol: string;
  /** The chain it lives on, e.g. "near", "eth", "sol". */
  chain: string;
  decimals: number;
}

/** What it would cost, in the funder's asset, to deliver the campaign's
 * funding as ZEC. Amounts are integers in the smallest unit, as strings. */
export interface NearPrice {
  token: NearToken;
  /** What the funder would send, in `token`'s smallest unit. */
  amountIn: string;
  /** What the campaign would receive, in zatoshi. */
  amountOut: string;
}

/** A real quote: the price plus where to send the deposit. Created only after
 * the person has confirmed, because it creates a deposit address. */
export interface NearDeposit extends NearPrice {
  depositAddress: string;
  /** Some chains need a memo or tag with the deposit. */
  depositMemo: string | null;
  /** When the quote lapses (ISO 8601), if the service says. */
  deadline: string | null;
  /** Where a late or short deposit is returned to: the funder's own address, as they gave it. */
  refundTo: string;
}

/** The operator's report on a swap. `status` is its word for the service's status (a closed
 * set, lower case); `step` is what to do about it. Neither says the campaign is funded. */
export interface NearStatus {
  status: string;
  step: string;
  /** Where the funder was told to send (the operator keeps it, so a reloaded page can show it again). */
  depositAddress: string;
  /** The deposit address has lapsed. */
  expired: boolean;
  /** When the quote lapses (ISO 8601). */
  validUntil: string | null;
  /** Zcash transactions the service says it sent, to be looked for on chain. */
  zecTxids: string[];
}

/** The calls the panel makes. The real implementation talks to the operator
 * (which is the only thing that talks to the service); tests pass a fake. */
export interface NearApi {
  tokens(signal?: AbortSignal): Promise<NearToken[]>;
  /** A price preview for a campaign of this size on mainnet. Creates nothing. */
  preview(input: { tokenId: string; fundingRequired: string }, signal?: AbortSignal): Promise<NearPrice>;
  /** A dry quote for this (mainnet) campaign. Creates nothing. `refundTo` is where a late or short deposit goes back to. */
  dryQuote(input: { campaignId: string; tokenId: string; refundTo: string }, signal?: AbortSignal): Promise<NearPrice>;
  /** A real quote: creates a deposit address. Only after the person confirmed. */
  liveQuote(input: { campaignId: string; tokenId: string }, signal?: AbortSignal): Promise<NearDeposit>;
  status(input: { campaignId: string }, signal?: AbortSignal): Promise<NearStatus>;
}
