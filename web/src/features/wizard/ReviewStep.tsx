import type { ReactNode } from "react";
import { Link } from "react-router";

import { CopyButton } from "@/components/CopyButton";
import { UnitNote } from "@/components/UnitProvider";
import { Zec } from "@/components/Zec";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OperatorBatchList } from "@/features/operator/OperatorBatchList";
import { describeDuration, estimateProvingSeconds } from "@/lib/fees";

import { useWizardDraft } from "./draft";
import { NeedsCampaign } from "./NeedsCampaign";
import { PrivacyWarnings } from "./PrivacyWarnings";
import { StepHeader } from "./StepHeader";
import { StepNav } from "./StepNav";

function Figure({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{children}</dd>
      {hint !== undefined && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}

export default function ReviewStep() {
  const created = useWizardDraft((s) => s.created);

  return (
    <>
      <StepHeader
        slug="review"
        description="Check the plan. Everything here is a count or a total: no recipient, amount or memo is shown."
      />
      {created === null ? (
        <>
          <NeedsCampaign />
          <StepNav back="auditor" />
        </>
      ) : (
        <div className="space-y-8">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                <h2>{created.name}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                <Figure label="Recipients">{created.recipientCount}</Figure>
                <Figure label="Batches" hint={`Up to ${String(created.maxOutputsPerBatch)} payouts each`}>
                  {created.batchCount}
                </Figure>
                <Figure label="Declared total" hint="What the recipients receive, together">
                  <Zec zatoshi={created.declaredTotal} />
                </Figure>
                <Figure
                  label="Network fee"
                  hint={`${created.feePolicy.marginalFee.toLocaleString("en-US")} zatoshi per action`}
                >
                  <Zec zatoshi={created.feeTotal} />
                </Figure>
                <Figure label="Funding required" hint="The declared total plus the fee">
                  <Zec zatoshi={created.fundingRequired} />
                </Figure>
                <Figure
                  label="Time to build"
                  hint="A rough guide: about 1.25 seconds per payout, measured on one computer"
                >
                  {describeDuration(estimateProvingSeconds(created.recipientCount))}
                </Figure>
              </dl>
              <div className="pt-4">
                <UnitNote />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                <h2>Manifest commitment</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="font-mono text-sm break-all" data-testid="manifest-commitment">
                {created.manifestCommitment}
              </p>
              <CopyButton value={created.manifestCommitment} label="Copy manifest commitment" />
              <p className="text-sm text-muted-foreground">
                A salted fingerprint of the exact recipient list. It goes on the public receipt; the list does not.
                An auditor who holds the list can recompute it and compare, to check that the list they were given is
                the one this campaign used.
              </p>
            </CardContent>
          </Card>

          <section aria-labelledby="batches-heading" className="space-y-3">
            <h2 id="batches-heading" className="text-lg font-semibold tracking-tight">
              Batches
            </h2>
            <OperatorBatchList campaign={created} />
          </section>

          <PrivacyWarnings warnings={created.warnings} />

          <StepNav back="auditor">
            <Button asChild>
              <Link to="/new/fund">Next: Fund &amp; Send</Link>
            </Button>
          </StepNav>
        </div>
      )}
    </>
  );
}
