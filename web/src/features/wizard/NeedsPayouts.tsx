import { Link } from "react-router";

import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";

/** Shown by a stage that needs the payouts to have been added first. */
export function NeedsPayouts() {
  return (
    <>
      <PageHeader title="Add the payouts first" description="This step works on a list you have added." />
      <Button asChild size="lg">
        <Link to="/new">Add the payouts</Link>
      </Button>
    </>
  );
}
