import { Link } from "react-router";

import { CopyButton } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FailureNotice } from "@/features/operator/FailureNotice";
import { useCampaignReceipt } from "@/features/operator/hooks";
import { config } from "@/lib/config";
import type { OperatorCampaign } from "@/api/operator/schemas";

import { receiptLinkPath, withPublicHost } from "./receipt-link";

/** What a receipt link tells whoever opens it. Mirrors docs/PRIVACY_BOUNDARY.md. */
const REVEALS: readonly string[] = [
  "The network, the transaction id of every batch, the declared total and the manifest commitment.",
  "Through those, what anyone can read from the chain: each batch's fee, the number of shielded actions (about the recipient count) and the funding input.",
  "That someone looked: the verifier that answers the link learns which receipt was viewed.",
];

const HIDDEN: readonly string[] = [
  "Recipient addresses, per-recipient amounts and memos are not in the link and cannot be derived from it.",
  "A batch of one, or a batch of equal amounts, lets the amounts be worked out from the public total; the review step warns about these.",
  "The funding address and amount are public and can be linked to you.",
];

export function ShareReceiptCard({ campaign }: { campaign: OperatorCampaign }) {
  const everyBatchBuilt = campaign.batches.length > 0 && campaign.batches.every((b) => b.txid !== null);
  const receipt = useCampaignReceipt(campaign.id, campaign.funding !== null && everyBatchBuilt);

  const link =
    receipt.data === undefined ? null : receiptLinkPath(campaign.id, receipt.data);
  const shown = link?.ok ? withPublicHost(link.path, config.publicReceiptBaseUrl) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          <h2>Share the receipt</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!everyBatchBuilt ? (
          <p className="text-sm text-muted-foreground">
            The receipt link is available once every batch has been built, because the public page needs all the
            transactions to add up the total. Until then there is nothing to share.
          </p>
        ) : receipt.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Getting the receipt…
          </p>
        ) : receipt.isError ? (
          <FailureNotice error={receipt.error} onRetry={() => void receipt.refetch()} retrying={receipt.isFetching} />
        ) : shown !== null && link?.ok ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Anyone with this link can check {link.txCount === 1 ? "the transaction" : `all ${String(link.txCount)} transactions`}{" "}
              on the public page. Batches that are still confirming show as pending there.
            </p>
            <p className="font-mono text-xs break-all" data-testid="receipt-link">
              {shown.text}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <CopyButton value={shown.text} label="Copy receipt link" />
            </div>
            {!shown.complete && (
              <p className="text-sm text-muted-foreground">
                This is the path only: put the address of the public verifier in front of it. To have the full link
                shown here, build the page with the verifier&apos;s address set (see the README).
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No link can be made yet.</p>
        )}

        <div className="space-y-2 rounded-lg border p-4 text-sm">
          <h3 className="font-medium">What the link shows</h3>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {REVEALS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <h3 className="pt-2 font-medium">What it does not show, and the limits</h3>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {HIDDEN.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <Button asChild variant="link" size="sm" className="px-0">
            <Link to="/privacy">Read the full privacy boundary</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
