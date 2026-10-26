import { Link, useParams } from "react-router";

import { PageHeader } from "@/components/PageHeader";
import { Zec } from "@/components/Zec";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { ViewingKeyCard } from "@/features/audit/ViewingKeyCard";
import { FailureNotice } from "@/features/operator/FailureNotice";
import { FundingPanel } from "@/features/operator/FundingPanel";
import { useCampaign, useCampaignStream } from "@/features/operator/hooks";
import { OperatorBatchList } from "@/features/operator/OperatorBatchList";
import { PhaseBadge } from "@/features/operator/PhaseBadge";
import { StartPanel } from "@/features/operator/StartPanel";
import { PrivacyWarnings } from "@/features/wizard/PrivacyWarnings";
import { phaseSentence } from "@/lib/phase";

import { ActivityLog } from "./ActivityLog";
import { ShareReceiptCard } from "./ShareReceiptCard";

function Loaded({ id }: { id: string }) {
  const query = useCampaign(id);
  const campaign = query.data;
  const funded = campaign?.funding != null;
  const stream = useCampaignStream(id, funded, campaign?.run.state ?? "unknown");
  // Read before the early returns narrow `query`: a failed refresh keeps the last good data on screen.
  const refreshFailed = query.isRefetchError;
  const loadFailed = query.isError && !query.isRefetchError;
  const failure: unknown = query.error;

  if (query.isPending) {
    return (
      <div className="space-y-8">
        <PageHeaderFor name="Campaign" id={id} />
        <div role="status" aria-busy="true" className="space-y-3">
          <p className="sr-only">Loading the campaign</p>
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }
  if (loadFailed) {
    return (
      <div className="space-y-8">
        <PageHeaderFor name="Campaign" id={id} />
        <FailureNotice error={failure} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      </div>
    );
  }

  const phase = campaign?.phase;
  if (campaign === undefined || phase === undefined) return null;
  const progress =
    phase.phase === "sending"
      ? { done: phase.done, total: phase.total }
      : phase.phase === "settled"
        ? { done: campaign.batchCount, total: campaign.batchCount }
        : null;

  return (
    <div className="space-y-8">
      <PageHeaderFor name={campaign.name} id={campaign.id} />

      <Card>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <PhaseBadge phase={phase} />
              <p className="text-sm text-muted-foreground">{phaseSentence(phase)}</p>
            </div>
            <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Recipients</dt>
                <dd className="font-semibold">{campaign.recipientCount}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Declared total</dt>
                <dd className="font-semibold">
                  <Zec zatoshi={campaign.declaredTotal} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Network fee</dt>
                <dd className="font-semibold">
                  <Zec zatoshi={campaign.feeTotal} />
                </dd>
              </div>
            </dl>
          </div>
          {progress !== null && progress.total > 0 && (
            <div className="space-y-1">
              <Progress
                value={Math.round((progress.done / progress.total) * 100)}
                aria-label="Batches confirmed"
              />
              <p className="text-xs text-muted-foreground">
                {progress.done} of {progress.total} {progress.total === 1 ? "batch" : "batches"} confirmed
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {refreshFailed && <FailureNotice error={failure} />}

      <FundingPanel campaign={campaign} />
      <StartPanel campaign={campaign} />

      <section aria-labelledby="batches-heading" className="space-y-3">
        <h2 id="batches-heading" className="text-lg font-semibold tracking-tight">
          Batches
        </h2>
        <OperatorBatchList campaign={campaign} />
      </section>

      {funded && <ActivityLog log={stream.log} status={stream.status} unreadable={stream.unreadable} />}

      <PrivacyWarnings warnings={campaign.warnings} />

      <ShareReceiptCard campaign={campaign} />

      <ViewingKeyCard campaignId={campaign.id} />
    </div>
  );
}

function PageHeaderFor({ name, id }: { name: string; id: string }) {
  return (
    <PageHeader
      kicker="Campaign"
      title={name}
      description={<span className="font-mono text-sm">{id}</span>}
      actions={
        <Button asChild variant="outline">
          <Link to="/campaigns">All campaigns</Link>
        </Button>
      }
    />
  );
}

export default function CampaignPage() {
  const { id = "" } = useParams<{ id: string }>();
  return <Loaded key={id} id={id} />;
}
