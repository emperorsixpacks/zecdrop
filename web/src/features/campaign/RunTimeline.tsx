import { useEffect, useId, useState } from "react";

import type { OperatorCampaign, ProgressEvent } from "@/api/operator/schemas";
import { Timeline } from "@/components/Timeline";
import { Progress } from "@/components/ui/progress";
import { useHealth } from "@/features/operator/hooks";
import { describeRun } from "@/features/operator/messages";

import { startedHere } from "./run-clock";
import { elapsedText, expectation, requiredDepthFrom, timelineSteps } from "./timeline";

/** How long this run has taken, ticking while it runs. From the moment this page sent
 * it, when it did; otherwise from the moment it first saw the run, and it says so. */
function useElapsed(id: string, active: boolean): { label: string; text: string } | null {
  const [seen] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [active]);
  if (!active) return null;
  const here = startedHere(id);
  return { label: here === undefined ? "Watching for" : "Elapsed", text: elapsedText(now - (here ?? seen)) };
}

/** The sending timeline: Preparing, Proving, Sending, Confirming, Done, live, with
 * the time it has taken and an honest estimate of the time it will. */
export function RunTimeline({ campaign, log }: { campaign: OperatorCampaign; log: readonly ProgressEvent[] }) {
  const headingId = useId();
  const health = useHealth();
  const elapsed = useElapsed(campaign.id, campaign.run.state === "running");
  const steps = timelineSteps(campaign, log);
  // How far along the line it is, for the bar and for assistive technology.
  const active = steps.findIndex((step) => step.state === "active" || step.state === "failed");
  const percent = steps.every((step) => step.state === "done") ? 100 : Math.round(((active < 0 ? 0 : active) / (steps.length - 1)) * 100);
  const now = steps[active < 0 ? steps.length - 1 : active];
  const estimate = expectation(campaign.recipientCount, requiredDepthFrom(log), campaign.network, health.data?.mock === true);

  return (
    <section aria-labelledby={headingId} className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 id={headingId} className="text-[1.75rem] leading-tight font-bold tracking-[-0.02em]">
          Sending the payouts
        </h2>
        {elapsed !== null && (
          <p className="mono text-lg" data-testid="elapsed">
            {elapsed.label} {elapsed.text}
          </p>
        )}
      </div>
      <Progress value={percent} aria-label="Sending steps" className="h-2" />
      <Timeline steps={steps} label="Sending progress" />
      {/* Said aloud when the step changes (the text only changes then), not on every tick of the clock. */}
      <p role="status" aria-live="polite" className="sr-only">
        {now === undefined ? "" : `${now.label}${typeof now.detail === "string" && now.detail !== "" ? `. ${now.detail}` : ""}`}
      </p>
      {estimate !== null && campaign.run.state === "running" && <p className="max-w-[64ch] text-sm text-muted-foreground">{estimate}</p>}
      {campaign.run.state === "halted" && (
        <p className="max-w-[64ch] text-base">{describeRun(campaign.run).detail} The operator&apos;s terminal says why.</p>
      )}
    </section>
  );
}
