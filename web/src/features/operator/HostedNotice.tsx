import { Link } from "react-router";

import { SAMPLE_RECEIPT_HREF } from "@/api/demo";
import { Shell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** What the operator pages show on a hosted, public copy of the app.
 *
 * The operator pages need the operator program, which runs on a computer its
 * owner controls and holds the spend keys. A hosted page has none to talk to, so
 * instead of an error it says what this page is and where the rest lives. Nothing
 * here calls any operator. */
export function HostedNotice() {
  return (
    <Shell showOperatorNav={false}>
      <PageHeader
        kicker="Public receipt viewer"
        title="Run the operator on your own machine"
        description="This hosted page is the public receipt viewer. Creating campaigns, sending payouts and the audit happen in the operator program, on a computer you control."
      />
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              <h2>Why this page is not here</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              The operator holds the spend keys and the recipient list. Neither belongs on a public
              website, so the operator runs only on your own computer and answers only to that
              computer. Nothing on this hosted page can create, fund or send a payout.
            </p>
            <p>
              To run a campaign, build the operator from the repository and start it on your own
              machine (the README has the quick start). It prints a link, and that link opens the
              operator pages.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              <h2>What you can do here</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-2 pl-5 text-sm">
              <li>
                Open a receipt link someone sent you, to see the totals, the fee and the
                transactions of a payout.
              </li>
              <li>
                <Link to={SAMPLE_RECEIPT_HREF} className="font-medium text-link underline underline-offset-4">
                  See a sample receipt
                </Link>
                , a real batch from public testnet.
              </li>
              <li>
                <Link to="/privacy" className="font-medium text-link underline underline-offset-4">
                  Read the privacy boundary
                </Link>
                : what is public, what is hidden, and who must be trusted.
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </Shell>
  );
}
