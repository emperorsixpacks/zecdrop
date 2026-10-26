import { Link, useNavigate } from "react-router";

import { UnitNote } from "@/components/UnitProvider";
import { Zec } from "@/components/Zec";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FailureNotice } from "@/features/operator/FailureNotice";
import { FundingPanel } from "@/features/operator/FundingPanel";
import { useCampaign } from "@/features/operator/hooks";
import { StartPanel } from "@/features/operator/StartPanel";

import { useWizardDraft } from "./draft";
import { NeedsCampaign } from "./NeedsCampaign";
import { StepHeader } from "./StepHeader";
import { StepNav } from "./StepNav";

function Live({ id }: { id: string }) {
  const navigate = useNavigate();
  const reset = useWizardDraft((s) => s.reset);
  const created = useWizardDraft((s) => s.created);
  const live = useCampaign(id);
  const campaign = live.data ?? created;
  if (campaign === null) return null;

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-1">
          <p className="text-sm text-muted-foreground">{campaign.name} needs</p>
          <p className="text-2xl font-semibold">
            <Zec zatoshi={campaign.fundingRequired} />
          </p>
          <p className="text-sm text-muted-foreground">
            {campaign.recipientCount} {campaign.recipientCount === 1 ? "payout" : "payouts"} in {campaign.batchCount}{" "}
            {campaign.batchCount === 1 ? "batch" : "batches"}, plus the network fee.
          </p>
          <UnitNote />
        </CardContent>
      </Card>

      {live.isError && <FailureNotice error={live.error} onRetry={() => void live.refetch()} retrying={live.isFetching} />}

      <FundingPanel campaign={campaign} />

      <StartPanel
        campaign={campaign}
        onStarted={() => {
          reset();
          void navigate(`/campaign/${encodeURIComponent(id)}`);
        }}
      />

      <p className="text-sm text-muted-foreground">
        Not ready? Everything on this page is also on the campaign&apos;s page, so you can{" "}
        <Link to={`/campaign/${encodeURIComponent(id)}`} className="text-link underline">
          fund and start later
        </Link>
        .
      </p>
    </div>
  );
}

export default function FundStep() {
  const created = useWizardDraft((s) => s.created);

  return (
    <>
      <StepHeader slug="fund" description="Fund the campaign, then start sending the batches." />
      {created === null ? (
        <NeedsCampaign />
      ) : (
        <Live id={created.id} />
      )}
      <StepNav back="review">
        <Button asChild variant="outline">
          <Link to="/campaigns">All campaigns</Link>
        </Button>
      </StepNav>
    </>
  );
}
