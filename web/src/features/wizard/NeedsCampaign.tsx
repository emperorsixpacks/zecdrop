import { Link } from "react-router";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/** Shown by a step that only makes sense after the campaign exists. */
export function NeedsCampaign() {
  return (
    <Alert variant="info" role="status" className="space-y-3">
      <AlertTitle className="text-base">
        <h2>Create the campaign first</h2>
      </AlertTitle>
      <AlertDescription className="space-y-3 text-card-foreground">
        <p>
          This step shows the plan the operator makes from your recipients, so it needs the campaign to exist. Fill in
          the basics and add the recipients, then come back.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to="/new/basics">Go to the basics</Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}
