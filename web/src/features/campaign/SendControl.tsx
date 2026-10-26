import { useEffect, useRef, useState } from "react";

import type { OperatorCampaign } from "@/api/operator/schemas";
import { Zec } from "@/components/Zec";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { FailureNotice } from "@/features/operator/FailureNotice";
import { useStartCampaign } from "@/features/operator/hooks";
import { describeRun } from "@/features/operator/messages";

import { markStarted } from "./run-clock";

interface SendControlProps {
  campaign: OperatorCampaign;
  /** Called once the operator has accepted the start request. */
  onStarted?: () => void;
}

/** The button that sends the payouts. A first send asks once, in a sheet that says
 * what it will do and that it cannot be undone. Resuming after a stop does not ask: it
 * rebuilds nothing and sends nothing twice. Before the campaign is funded the button
 * is there but cannot be pressed, and the page says why. */
export function SendControl({ campaign, onStarted }: SendControlProps) {
  const start = useStartCampaign(campaign.id);
  const run = describeRun(campaign.run);
  const [open, setOpen] = useState(false);
  const announced = useRef(onStarted);
  useEffect(() => {
    announced.current = onStarted;
  });

  if (!run.canStart) return null;

  const payouts = campaign.recipientCount === 1 ? "1 payout" : `${String(campaign.recipientCount)} payouts`;
  const label = `Send ${payouts}`;
  const ready = campaign.funding !== null && campaign.walletMatches;

  if (!ready) {
    return (
      <div className="space-y-2">
        <Button size="lg" disabled>
          {label}
        </Button>
        <p className="text-base text-muted-foreground">
          {campaign.walletMatches ? "Sending can start once the campaign is funded." : "Sending is not possible with this wallet."}
        </p>
      </div>
    );
  }

  const go = () => {
    start.mutate(undefined, {
      onSuccess: () => {
        markStarted(campaign.id);
        setOpen(false);
        announced.current?.();
      },
    });
  };

  if (campaign.run.state !== "idle") {
    return (
      <div className="space-y-3">
        <Button size="lg" onClick={go} disabled={start.isPending}>
          {start.isPending ? "Starting…" : run.action}
        </Button>
        {start.isError && <FailureNotice error={start.error} />}
      </div>
    );
  }

  return (
    <>
      <Button
        size="lg"
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={`${label}?`}
        description={
          <>
            This sends {payouts}, <Zec zatoshi={campaign.declaredTotal} /> plus <Zec zatoshi={campaign.feeTotal} /> fee. It cannot be undone.
          </>
        }
      >
        <div className="flex flex-wrap gap-3">
          <Button size="lg" onClick={go} disabled={start.isPending}>
            {start.isPending ? "Starting…" : label}
          </Button>
          <Button
            size="lg"
            variant="outline"
            data-autofocus
            onClick={() => {
              setOpen(false);
            }}
          >
            Cancel
          </Button>
        </div>
        {start.isError && <FailureNotice error={start.error} />}
      </Sheet>
    </>
  );
}
