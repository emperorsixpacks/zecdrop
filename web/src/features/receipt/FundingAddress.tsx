import { Unknown } from "@/components/Zec";
import { CopyButton } from "@/components/CopyButton";
import type { ZecNetwork } from "@/lib/config";
import { explorerAddressUrl } from "@/lib/explorer";
import { shortId } from "@/lib/ids";

interface FundingAddressProps {
  /** The one transparent address every batch spends from, or null if the
   * verifier could not establish it. */
  address: string | null;
  network: ZecNetwork;
  /** Some batches have no transaction yet, so they say nothing about the address. */
  someBatchesNotBuilt: boolean;
}

/** The campaign's funding address, and how to use it.
 *
 * It is public on the chain. Together with the manifest commitment it is what
 * ties a receipt to a campaign: the campaign id at the top of the page is only
 * a label from whoever made the link. A reader compares this address with the one
 * the campaign's organiser published.
 *
 * When the verifier could not establish one address it says "Unknown" (never a
 * blank): an input could not be looked up, the batches did not all spend from the
 * same address, or the producer has none. */
export function FundingAddress({ address, network, someBatchesNotBuilt }: FundingAddressProps) {
  const link = address === null ? null : explorerAddressUrl(network, address);

  return (
    <div className="max-w-[64ch] space-y-3" data-testid="funding-section">
      {address === null ? (
        <>
          <p className="text-base">
            <Unknown />
          </p>
          <p className="text-sm text-muted-foreground">
            The verifier could not establish one address that every batch spends from, so there
            is nothing here to compare with the address the campaign published. Any problem it
            found is listed under what the verifier found.
          </p>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <code className="font-mono text-sm" title={address} translate="no" data-testid="funding-address">
              {shortId(address)}
            </code>
            <CopyButton value={address} label="Copy funding address" />
            {link !== null && (
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center text-sm font-medium text-link underline underline-offset-4"
              >
                Explorer <span className="sr-only">for the funding address (opens in a new tab)</span>
              </a>
            )}
          </div>
          <p className="text-sm">
            Every batch on this receipt spends from this address; compare it with the address the
            campaign published.
            {someBatchesNotBuilt && " Batches that are not built yet are not included."}
          </p>
        </>
      )}
      <p className="text-sm text-muted-foreground">
        The campaign name on this page is only a label from whoever made the link. The funding
        address and the list fingerprint are what tie a receipt to a campaign.
      </p>
    </div>
  );
}
