import { Link } from "react-router";

import { SAMPLE_RECEIPT_HREF } from "@/api/demo";
import { Shell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";

const link = "font-medium text-link underline underline-offset-4";

/** What the operator pages show on a hosted, public copy of the app.
 *
 * The operator pages need ZecDrop running on the payer's own computer, which holds the keys and the list. A hosted page has
 * none to talk to, so instead of an error it says where those pages are and how to start them (REQ-RUN-002). Nothing here
 * calls any operator. */
export function HostedNotice() {
  return (
    <Shell showOperatorNav={false}>
      <PageHeader
        title="Payouts are made on your own computer"
        description="ZecDrop holds your keys and your list, so it runs on your computer, never on this site."
      />
      <div className="space-y-6">
        <Button asChild size="lg">
          <Link to="/start">Make a payout</Link>
        </Button>
        <p className="text-base">
          Here you can open a receipt link, check a payslip, or{" "}
          <Link to={SAMPLE_RECEIPT_HREF} className={link}>
            see a real receipt
          </Link>
          .
        </p>
      </div>
    </Shell>
  );
}
