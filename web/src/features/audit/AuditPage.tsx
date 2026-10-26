import { Link } from "react-router";

import { PageHeader } from "@/components/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { DISCLOSURE_WARNING } from "./disclosure";

// Written from crates/drop-operator/src/audit.rs and `drop-operator audit
// --help`, and from docs/PRIVACY_BOUNDARY.md. If the command's flags change,
// change the example below.

const CHECKS: readonly string[] = [
  "For every batch: whether the number of outputs recovered with the viewing key equals the shielded action count on the chain.",
  "For every batch: whether the recovered values add up to the net value that entered the shielded pool.",
  "Whether the salted manifest commitment, recomputed from what the chain proves and the stored payout list, equals the commitment on the receipt.",
];

const LIMITS: readonly string[] = [
  "A difference is reported as a difference, never rounded away. It can mean a hidden spend, a hidden output, an output built without the campaign's key, or a payout list that is not what was paid.",
  "It trusts the chain data source it is pointed at. A lying node can fake what the audit sees.",
  "It says nothing about what recipients do afterwards.",
];

const COMMAND = `drop-operator audit \\
  --campaign <campaign id> \\
  --ufvk-stdin \\
  --lightwalletd-url <server>`;

export default function AuditPage() {
  return (
    <>
      <PageHeader
        kicker="Auditor"
        title="Audit"
        description="Only the holder of a campaign's viewing key can check that the payments reached the payout list. The public cannot."
      />
      <div className="space-y-6">
        <Alert variant="info" role="note">
          <AlertTitle>Running the audit is not done from this page</AlertTitle>
          <AlertDescription className="text-card-foreground">
            The audit is a command-line tool. It runs on the auditor&apos;s own computer and keeps the viewing key
            inside that process. This page explains it and shows where the key comes from.
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              <h2>What the audit checks</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
              {CHECKS.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              <h2>Limits</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
              {LIMITS.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              <h2>Running it</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>The auditor pastes the viewing key on standard input, so it never lands in shell history:</p>
            <pre className="overflow-x-auto rounded-lg border bg-secondary p-3 font-mono text-xs text-foreground">
              {COMMAND}
            </pre>
            <p>
              Add <code className="font-mono">--receipt-commitment</code> to compare with the commitment printed on a
              public receipt instead of the stored one, and <code className="font-mono">--json</code> for a
              machine-readable report. The report holds counts, public sums, transaction ids and yes/no results; it has
              no addresses, memos or per-recipient amounts. Check{" "}
              <code className="font-mono">drop-operator audit --help</code> for the flags in your version.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              <h2>Getting the viewing key</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>{DISCLOSURE_WARNING}</p>
            <p>
              The key is shown on a campaign&apos;s own page, after you confirm you understand the above. Open a
              campaign from <Link to="/campaigns" className="text-link underline">your campaigns</Link>.
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
