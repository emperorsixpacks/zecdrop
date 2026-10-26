import type { OperatorCampaign } from "@/api/operator/schemas";
import { CopyButton } from "@/components/CopyButton";
import { UnitNote } from "@/components/UnitProvider";
import { Zec } from "@/components/Zec";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { shortId } from "@/lib/ids";

import { FailureNotice } from "./FailureNotice";
import { useCheckFunding, useHealth } from "./hooks";
import { MockFunding } from "./MockFunding";

function Progress({ campaign }: { campaign: OperatorCampaign }) {
  const seen = campaign.fundingProgress;
  if (seen === null) {
    return <p className="text-sm text-muted-foreground">No deposit seen yet. This page checks again every few seconds.</p>;
  }
  return (
    <div className="space-y-1 text-sm">
      <p>
        A deposit of <Zec zatoshi={seen.amount} /> has {seen.confirmations} of {seen.requiredDepth} confirmations.
      </p>
      {!seen.sufficient && (
        <p className="text-destructive">
          That is less than the <Zec zatoshi={campaign.fundingRequired} /> this campaign needs, so it does not count.
          Send the rest in a single deposit of at least that amount.
        </p>
      )}
    </div>
  );
}

function RealChainFunding({ campaign, address }: { campaign: OperatorCampaign; address: string }) {
  const check = useCheckFunding(campaign.id);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Send at least <strong className="text-foreground"><Zec zatoshi={campaign.fundingRequired} /></strong> (the
        declared total plus fees) to this campaign&apos;s funding address, in one deposit. The funding address, the
        amount and the address you send from are public; see the privacy page.
      </p>
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Funding address ({campaign.network})</p>
        <p className="font-mono text-sm break-all" data-testid="funding-address">
          {address}
        </p>
        <CopyButton value={address} label="Copy funding address" />
      </div>
      <div role="status" aria-live="polite">
        <Progress campaign={campaign} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            check.mutate();
          }}
          disabled={check.isPending}
        >
          {check.isPending ? "Checking…" : "Check for the deposit now"}
        </Button>
      </div>
      {check.isError && <FailureNotice error={check.error} />}
      <UnitNote />
    </div>
  );
}

/** Where the money comes from: the deposit if there is one, the address to send
 * to on a real chain, or the pretend-deposit form on the mock chain. */
export function FundingPanel({ campaign }: { campaign: OperatorCampaign }) {
  const health = useHealth();

  if (!campaign.walletMatches) {
    return (
      <Alert variant="warning" role="alert">
        <AlertTitle>This campaign belongs to a different wallet</AlertTitle>
        <AlertDescription className="text-card-foreground">
          It was created with a different wallet seed than the one this operator is using now, so it can&apos;t be
          funded, started or have its viewing key exported from here. Start the operator with the original wallet.
        </AlertDescription>
      </Alert>
    );
  }

  if (campaign.funding !== null) {
    return (
      <Alert variant="info" role="status">
        <AlertTitle>Funded</AlertTitle>
        <AlertDescription className="text-card-foreground">
          <Zec zatoshi={campaign.funding.amount} /> in deposit{" "}
          <span className="font-mono" title={campaign.funding.outpoint.txid}>
            {shortId(campaign.funding.outpoint.txid)}:{campaign.funding.outpoint.vout}
          </span>
          .
        </AlertDescription>
      </Alert>
    );
  }

  if (health.data?.mock === true) return <MockFunding campaign={campaign} />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          <h2>Fund the campaign</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {campaign.fundingAddress !== null ? (
          <RealChainFunding campaign={campaign} address={campaign.fundingAddress} />
        ) : health.isPending ? (
          <p className="text-sm text-muted-foreground">Asking the operator where to send the deposit…</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            The operator has not given a funding address for this campaign. Check its terminal for details.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
