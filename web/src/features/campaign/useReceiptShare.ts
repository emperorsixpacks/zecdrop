import type { OperatorCampaign } from "@/api/operator/schemas";
import { useCampaignReceipt } from "@/features/operator/hooks";
import { config } from "@/lib/config";
import { usePractice } from "@/lib/practice-mode";

import { receiptLinkPath, withPublicHost } from "./receipt-link";

/** The receipt link for a campaign: available once the campaign is funded and every
 * batch is built, because the public page needs all the transactions to add up the total. */
export function useReceiptShare(campaign: OperatorCampaign) {
  const practice = usePractice((state) => state.on);
  const everyBatchBuilt = campaign.batches.length > 0 && campaign.batches.every((b) => b.txid !== null);
  const receipt = useCampaignReceipt(campaign.id, campaign.funding !== null && everyBatchBuilt);
  const link = receipt.data === undefined ? null : receiptLinkPath(campaign.id, receipt.data);
  // A practice receipt exists in this tab only: its link is a path that opens here, never one on a public host.
  const shown = link?.ok ? withPublicHost(link.path, practice ? null : config.publicReceiptBaseUrl) : null;
  return { everyBatchBuilt, receipt, link, shown };
}
