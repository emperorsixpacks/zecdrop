import { Link, useNavigate } from "react-router";

import type { OperatorCampaignSummary } from "@/api/operator/schemas";
import { GhostRows } from "@/components/GhostRows";
import { PageHeader } from "@/components/PageHeader";
import { StatusDot } from "@/components/StatusDot";
import { Zec } from "@/components/Zec";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FailureNotice } from "@/features/operator/FailureNotice";
import { useCampaigns, useHealth } from "@/features/operator/hooks";
import { useWizardDraft } from "@/features/wizard/draft";
import { EXAMPLE_LIST_NOTE, exampleListFor } from "@/features/wizard/example-list";
import { peopleFromCsv } from "@/features/wizard/people";

import { sortCampaigns } from "./sort";

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function Row({ campaign }: { campaign: OperatorCampaignSummary }) {
  const people = campaign.recipientCount === 1 ? "1 person" : `${String(campaign.recipientCount)} people`;
  return (
    <li>
      <Link
        to={`/campaign/${encodeURIComponent(campaign.id)}`}
        className="row-hover press-only grid min-h-16 grid-cols-[1fr_auto] items-center gap-x-6 gap-y-1 px-2 py-4 sm:grid-cols-[1fr_7rem_10rem_9rem_8rem]"
      >
        <span className="min-w-0 text-xl leading-snug font-bold tracking-tight break-words">{campaign.name}</span>
        <StatusDot phase={campaign.phase} className="justify-self-end sm:order-4 sm:justify-self-start" />
        <span className="text-base text-muted-foreground sm:order-2">{people}</span>
        <span className="mono text-right text-base sm:order-3">
          <Zec zatoshi={campaign.declaredTotal} />
        </span>
        <time dateTime={new Date(campaign.createdAt * 1000).toISOString()} className="col-span-2 text-sm text-muted-foreground sm:order-5 sm:col-span-1 sm:text-right">
          {when(campaign.createdAt)}
        </time>
      </Link>
    </li>
  );
}

export default function CampaignsPage() {
  const query = useCampaigns();
  const navigate = useNavigate();
  const setPeople = useWizardDraft((s) => s.setPeople);
  const health = useHealth();
  const exampleList = exampleListFor(health.data?.network);

  return (
    <>
      <PageHeader title="Payouts" />

      {query.isPending ? (
        <div role="status" aria-busy="true" className="space-y-3">
          <p className="sr-only">Loading payouts</p>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : query.isError ? (
        <FailureNotice error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      ) : query.data.length === 0 ? (
        <div className="space-y-8" data-testid="payouts-empty">
          <div className="max-w-[64ch] space-y-2">
            <p className="text-[1.75rem] leading-tight font-bold tracking-tight text-balance">No payouts yet</p>
            <p className="text-base text-muted-foreground">{"Each run you send shows up here. Add the people you're paying to start the first."}</p>
          </div>
          <GhostRows />
          <div className="flex flex-wrap items-center gap-3">
            {exampleList !== null && (
              <Button
                type="button"
                size="lg"
                onClick={() => {
                  setPeople(peopleFromCsv(exampleList));
                  void navigate("/new");
                }}
              >
                Use the example list
              </Button>
            )}
            <Button asChild size="lg" variant={exampleList === null ? "default" : "outline"}>
              <Link to="/new">Start a payout</Link>
            </Button>
          </div>
          {exampleList !== null && <p className="text-sm text-muted-foreground">{EXAMPLE_LIST_NOTE}</p>}
        </div>
      ) : (
        <ul aria-label="Payouts" className="divide-y divide-border border-y border-border">
          {sortCampaigns(query.data).map((campaign) => (
            <Row key={campaign.id} campaign={campaign} />
          ))}
        </ul>
      )}
    </>
  );
}
