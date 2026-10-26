import { Disclosure } from "@/components/Disclosure";
import type { ZecNetwork } from "@/lib/config";

import type { NearApi } from "./model";
import { NearMainnetPanel } from "./NearMainnetPanel";
import { NearPreviewPanel } from "./NearPreviewPanel";
import { NEAR_FUNDED_ONLY_ON_CHAIN } from "./status";

interface NearFundingPanelProps {
  api: NearApi;
  campaign: { id: string; network: ZecNetwork; fundingRequired: string };
  /** Open to begin with (tests, and a page that has already started a swap). */
  defaultOpen?: boolean;
}

/** "Fund from another coin": a collapsed row under the funding address. Nothing is asked of the
 * price service until it is opened. A price preview on testnet (NEAR works with mainnet ZEC
 * only), and the quote-then-confirm flow on mainnet. */
export function NearFundingPanel({ api, campaign, defaultOpen = false }: NearFundingPanelProps) {
  return (
    <Disclosure summary="Fund from another coin" defaultOpen={defaultOpen} className="border-b" data-testid="near-row">
      <div className="space-y-5">
        {campaign.network === "mainnet" ? (
          <NearMainnetPanel api={api} campaignId={campaign.id} />
        ) : (
          <NearPreviewPanel api={api} fundingRequired={campaign.fundingRequired} />
        )}
        <p className="text-base font-semibold">{NEAR_FUNDED_ONLY_ON_CHAIN}</p>
      </div>
    </Disclosure>
  );
}
