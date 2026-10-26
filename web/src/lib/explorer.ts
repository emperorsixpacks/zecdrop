// Links from a transaction id to a block explorer. The templates live in
// config.ts (one place to change them); this module only fills them in.

import { ADDRESS_PLACEHOLDER, config, TXID_PLACEHOLDER, type ZecNetwork } from "@/lib/config";

const TXID = /^[0-9a-f]{64}$/u;

/** URL of `txid` on the configured explorer for `network`.
 *
 * The txid must be 64 lowercase hex characters. Because nothing else can get
 * into the URL, a hostile or corrupt value can never change where the link
 * points. */
export function explorerTxUrl(
  network: ZecNetwork,
  txid: string,
  templates: Readonly<Record<ZecNetwork, string>> = config.explorerTxUrl,
): string {
  if (!TXID.test(txid)) throw new Error("not a transaction id");
  return templates[network].replace(TXID_PLACEHOLDER, txid);
}

/** A transparent address as Zcash writes it: base58 text. No slash, dot, query
 * or space can be in it, so it cannot change where an explorer link points. */
const TRANSPARENT_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{26,64}$/u;

/** Whether `address` is safe to put in an explorer link. */
export function isLinkableAddress(address: string): boolean {
  return TRANSPARENT_ADDRESS.test(address);
}

/** URL of the explorer's page for `address` on `network`, or null when the text
 * is not a transparent address (a placeholder, or something unexpected): the
 * caller then shows the address with no link rather than a wrong one. */
export function explorerAddressUrl(
  network: ZecNetwork,
  address: string,
  templates: Readonly<Record<ZecNetwork, string>> = config.explorerAddressUrl,
): string | null {
  if (!isLinkableAddress(address)) return null;
  return templates[network].replace(ADDRESS_PLACEHOLDER, address);
}
