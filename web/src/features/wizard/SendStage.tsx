import { useEffect } from "react";
import { Link, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { CampaignView } from "@/features/campaign/CampaignView";

import { useWizardDraft } from "./draft";
import { NeedsPayouts } from "./NeedsPayouts";

/** Stage 3 of 3: is it funded, then send. It is the campaign's own view, so the send
 * that starts here carries on, unchanged, on the campaign's page. */
export default function SendStage() {
  const navigate = useNavigate();
  const created = useWizardDraft((s) => s.created);
  const reset = useWizardDraft((s) => s.reset);
  const releaseList = useWizardDraft((s) => s.releaseList);

  // The Check stage is over: the rows it showed go.
  useEffect(() => {
    releaseList();
  }, [releaseList]);

  if (created === null) return <NeedsPayouts />;
  const id = created.id;
  return (
    <div className="space-y-10">
      <CampaignView
        id={id}
        flow
        onStarted={() => {
          reset();
          void navigate(`/campaign/${encodeURIComponent(id)}`);
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="outline">
          <Link to="/new/check">Back to check</Link>
        </Button>
        <Link
          to={`/campaign/${encodeURIComponent(id)}`}
          className="inline-flex min-h-11 items-center px-1 text-base font-medium underline underline-offset-4"
        >
          Fund and start later
        </Link>
      </div>
    </div>
  );
}
