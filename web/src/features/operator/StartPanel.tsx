import { useEffect, useRef } from "react";

import type { OperatorCampaign } from "@/api/operator/schemas";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { FailureNotice } from "./FailureNotice";
import { useStartCampaign } from "./hooks";
import { describeRun } from "./messages";

interface StartPanelProps {
  campaign: OperatorCampaign;
  /** Called once the operator has accepted the start request. */
  onStarted?: () => void;
}

/** Start sending, or resume after a stop. Offered only when the campaign is
 * funded, the wallet matches and starting does something. */
export function StartPanel({ campaign, onStarted }: StartPanelProps) {
  const start = useStartCampaign(campaign.id);
  const run = describeRun(campaign.run);
  const ready = campaign.funding !== null && campaign.walletMatches;
  const announced = useRef(onStarted);
  useEffect(() => {
    announced.current = onStarted;
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          <h2>Sending: {run.label}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{run.detail}</p>
        {!ready && run.canStart && (
          <p className="text-sm text-muted-foreground">
            {campaign.walletMatches ? "Sending can start once the campaign is funded." : "Sending is not possible with this wallet."}
          </p>
        )}
        {run.canStart && ready && (
          <Button
            onClick={() => {
              start.mutate(undefined, {
                onSuccess: () => {
                  announced.current?.();
                },
              });
            }}
            disabled={start.isPending}
          >
            {start.isPending ? "Starting…" : run.action}
          </Button>
        )}
        {start.isError && <FailureNotice error={start.error} />}
      </CardContent>
    </Card>
  );
}
