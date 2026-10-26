import { useRef, useState } from "react";
import { Link } from "react-router";

import { PageHeader } from "@/components/PageHeader";
import { PayoutSummary } from "@/components/PayoutSummary";
import { PhaseDot } from "@/components/StatusDot";
import { Disclosure } from "@/components/Disclosure";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { ViewingKeyCard } from "@/features/audit/ViewingKeyCard";
import { FailureNotice } from "@/features/operator/FailureNotice";
import { FundingPanel } from "@/features/operator/FundingPanel";
import { useCampaign, useCampaignStream } from "@/features/operator/hooks";
import { OperatorBatchList } from "@/features/operator/OperatorBatchList";
import { PrivacyWarnings } from "@/features/wizard/PrivacyWarnings";
import { phaseProgress, phaseSentence } from "@/lib/phase";

import { ActivityLog } from "./ActivityLog";
import { DonePanel } from "./DonePanel";
import { PayslipsCard } from "./PayslipsCard";
import { RunTimeline } from "./RunTimeline";
import { SendControl } from "./SendControl";
import { ShareDetails } from "./ShareDetails";

interface CampaignViewProps {
  id: string;
  /** Shown inside the three stages (as "Fund and send") instead of on the payout's own page. */
  flow?: boolean;
  /** Called once the operator has accepted the start request. */
  onStarted?: () => void;
}

/** One campaign, from "is it funded?" through the live timeline to the sealed
 * receipt. The third stage of the flow and the payout's own page are this same view,
 * so a send that starts on one carries on, unchanged, on the other. */
export function CampaignView({ id, flow = false, onStarted }: CampaignViewProps) {
  const query = useCampaign(id);
  const campaign = query.data;
  const funded = campaign?.funding != null;
  const stream = useCampaignStream(id, funded, campaign?.run.state ?? "unknown");
  const [auditorOpen, setAuditorOpen] = useState(false);
  const [payslipsOpen, setPayslipsOpen] = useState(false);
  // Confetti is for a settling this page watched, not for a receipt opened later.
  const [sawRunning, setSawRunning] = useState(false);
  if (campaign?.run.state === "running" && !sawRunning) setSawRunning(true);
  const auditor = useRef<HTMLDivElement>(null);
  const payslips = useRef<HTMLDivElement>(null);

  // Read before the early returns narrow `query`: a failed refresh keeps the last good data on screen.
  const refreshFailed = query.isRefetchError;
  const loadFailed = query.isError && !query.isRefetchError;
  const failure: unknown = query.error;
  const heading = (name: string, description?: string) => (
    <PageHeader title={flow ? "Fund and send" : name} description={flow ? name : <span className="mono text-sm">{description ?? id}</span>} />
  );

  if (query.isPending) {
    return (
      <div className="space-y-8">
        {heading("Campaign")}
        <div role="status" aria-busy="true" className="space-y-3">
          <p className="sr-only">Loading the campaign</p>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }
  if (loadFailed) {
    return (
      <div className="space-y-8">
        {heading("Campaign")}
        <FailureNotice error={failure} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      </div>
    );
  }
  if (campaign === undefined) return null;

  const { phase, run } = campaign;
  const progress = phaseProgress(phase);
  const percent =
    phase.phase === "sending" && phase.total > 0
      ? Math.round((phase.done / phase.total) * 100)
      : phase.phase === "settled"
        ? 100
        : null;
  // On a real chain the funding panel says "Waiting for funds" itself, with its pulse; once is enough.
  const waitingOnChain = campaign.funding === null && campaign.fundingAddress !== null && campaign.walletMatches;
  const started = run.state !== "idle";
  const settled = run.state === "settled" || phase.phase === "settled";

  const openAuditor = () => {
    setAuditorOpen(true);
    // After the section has opened, bring it into view. Plain jump, no animation.
    requestAnimationFrame(() => {
      auditor.current?.scrollIntoView?.({ block: "start" });
    });
  };

  const openPayslips = () => {
    setPayslipsOpen(true);
    requestAnimationFrame(() => {
      payslips.current?.scrollIntoView?.({ block: "start" });
    });
  };

  return (
    <div className="space-y-12">
      <div className="space-y-6">
        {!flow && (
          <Link to="/campaigns" className="inline-flex min-h-11 items-center text-base font-medium underline underline-offset-4">
            All payouts
          </Link>
        )}
        {heading(campaign.name, campaign.id)}
        <div className="space-y-3">
          <PayoutSummary people={campaign.recipientCount} total={BigInt(campaign.declaredTotal)} fee={BigInt(campaign.feeTotal)} />
          {!waitingOnChain && (
            <p className="flex items-center gap-3 text-base">
              <PhaseDot phase={phase} />
              {phaseSentence(phase)}
            </p>
          )}
          {percent !== null && progress !== null && (
            <div className="max-w-md space-y-1">
              <Progress value={percent} aria-label="Batches confirmed" />
              {/* The sentence above already says it while sending; the bar keeps its words for assistive technology. */}
              <p className="sr-only">{progress}</p>
            </div>
          )}
          {percent === 100 && progress === null && (
            <div className="max-w-md space-y-1">
              <Progress value={100} aria-label="Batches confirmed" />
              <p className="text-sm text-muted-foreground">
                {campaign.batchCount} of {campaign.batchCount} {campaign.batchCount === 1 ? "batch" : "batches"} confirmed
              </p>
            </div>
          )}
        </div>
      </div>

      {refreshFailed && <FailureNotice error={failure} />}

      <FundingPanel campaign={campaign} />

      {settled ? (
        <DonePanel campaign={campaign} onAuditor={openAuditor} onPayslips={openPayslips} celebrate={sawRunning} />
      ) : started ? (
        <div className="space-y-6">
          <RunTimeline campaign={campaign} log={stream.log} />
          <SendControl campaign={campaign} {...(onStarted ? { onStarted } : {})} />
        </div>
      ) : (
        <SendControl campaign={campaign} {...(onStarted ? { onStarted } : {})} />
      )}

      <PrivacyWarnings warnings={campaign.warnings} />

      <div className="border-b border-border">
        <Disclosure summary="Batches">
          <OperatorBatchList campaign={campaign} />
        </Disclosure>
        {funded && (
          <Disclosure summary="Activity">
            <ActivityLog log={stream.log} status={stream.status} unreadable={stream.unreadable} />
          </Disclosure>
        )}
        <Disclosure summary="Share the receipt">
          <ShareDetails campaign={campaign} />
        </Disclosure>
        {settled && (
          <div ref={payslips}>
            <Disclosure summary="Payslips" open={payslipsOpen} onOpenChange={setPayslipsOpen}>
              <PayslipsCard campaignId={campaign.id} />
            </Disclosure>
          </div>
        )}
        <div ref={auditor}>
          <Disclosure summary="Auditor access" open={auditorOpen} onOpenChange={setAuditorOpen}>
            <ViewingKeyCard campaignId={campaign.id} />
          </Disclosure>
        </div>
      </div>
    </div>
  );
}
