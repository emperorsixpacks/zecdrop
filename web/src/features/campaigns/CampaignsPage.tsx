import { Link } from "react-router";

import type { OperatorCampaignSummary } from "@/api/operator/schemas";
import { PageHeader } from "@/components/PageHeader";
import { Zec } from "@/components/Zec";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FailureNotice } from "@/features/operator/FailureNotice";
import { useCampaigns } from "@/features/operator/hooks";
import { PhaseBadge } from "@/features/operator/PhaseBadge";
import { phaseSentence } from "@/lib/phase";

import { sortCampaigns } from "./sort";

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function Row({ campaign }: { campaign: OperatorCampaignSummary }) {
  const payouts = campaign.recipientCount === 1 ? "1 payout" : `${String(campaign.recipientCount)} payouts`;
  const batches = campaign.batchCount === 1 ? "1 batch" : `${String(campaign.batchCount)} batches`;
  return (
    <li>
      <Card>
        <CardContent className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 space-y-1">
            <h2 className="text-base font-semibold">
              <Link to={`/campaign/${encodeURIComponent(campaign.id)}`} className="underline-offset-4 hover:underline">
                {campaign.name}
              </Link>
            </h2>
            <p className="text-sm text-muted-foreground">
              {payouts} in {batches}
              {" · "}
              <time dateTime={new Date(campaign.createdAt * 1000).toISOString()}>{when(campaign.createdAt)}</time>
            </p>
            <p className="text-sm text-muted-foreground">{phaseSentence(campaign.phase)}</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <PhaseBadge phase={campaign.phase} />
            <div className="text-right">
              <div className="text-xs text-muted-foreground">Declared total</div>
              <div className="text-lg font-semibold">
                <Zec zatoshi={campaign.declaredTotal} />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </li>
  );
}

export default function CampaignsPage() {
  const query = useCampaigns();

  return (
    <>
      <PageHeader
        kicker="Operator"
        title="Campaigns"
        description="Your payout campaigns on this computer. Recipient details are never shown here; only counts and totals."
        actions={
          <Button asChild>
            <Link to="/new">New campaign</Link>
          </Button>
        }
      />

      {query.isPending ? (
        <div role="status" aria-busy="true" className="space-y-3">
          <p className="sr-only">Loading campaigns</p>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : query.isError ? (
        <FailureNotice
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : query.data.length === 0 ? (
        <Card>
          <CardContent className="space-y-4">
            <h2 className="text-lg font-semibold">No campaigns yet</h2>
            <p className="text-sm text-muted-foreground">
              A campaign is one payout: who gets paid is loaded from a CSV, split into batches, and sent as Zcash
              transactions. Start with the first one.
            </p>
            <Button asChild>
              <Link to="/new">Create a campaign</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ul aria-label="Campaigns" className="space-y-3">
          {sortCampaigns(query.data).map((campaign) => (
            <Row key={campaign.id} campaign={campaign} />
          ))}
        </ul>
      )}
    </>
  );
}
