import { Link } from "react-router";

import { ViewingKeyCard } from "@/features/audit/ViewingKeyCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { useWizardDraft } from "./draft";
import { NeedsCampaign } from "./NeedsCampaign";
import { StepHeader } from "./StepHeader";
import { StepNav } from "./StepNav";

export default function AuditorStep() {
  const created = useWizardDraft((s) => s.created);

  return (
    <>
      <StepHeader
        slug="auditor"
        description="Optional. An auditor is someone you choose to check that the money went where the list says."
      />
      {created === null ? (
        <>
          <NeedsCampaign />
          <StepNav back="recipients" />
        </>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                <h2>What an auditor can do that the public cannot</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                From the chain alone, anyone can see how much value a batch moved into the shielded pool and how many
                shielded actions it used. They cannot tell that it reached the people on your list: a payment to the
                operator&apos;s own address looks the same.
              </p>
              <p>
                With the campaign&apos;s viewing key, an auditor can recover every output, count them, add them up and
                compare with those public figures. A difference is reported as a difference. The check runs on the
                auditor&apos;s own computer; see the <Link to="/audit" className="text-link underline">audit page</Link>.
              </p>
              <p>
                You can skip this now. Skipping changes nothing about the campaign, and the same card is on the
                campaign&apos;s page.
              </p>
            </CardContent>
          </Card>

          <ViewingKeyCard campaignId={created.id} />

          <StepNav back="recipients">
            <Button asChild>
              <Link to="/new/review">Next: Review</Link>
            </Button>
          </StepNav>
        </div>
      )}
    </>
  );
}
