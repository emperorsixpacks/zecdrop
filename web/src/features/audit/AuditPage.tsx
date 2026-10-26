import { Link } from "react-router";

import { CopyButton } from "@/components/CopyButton";
import { Disclosure } from "@/components/Disclosure";
import { GhostRows } from "@/components/GhostRows";
import { PageHeader } from "@/components/PageHeader";
import { Why } from "@/components/Why";
import { Button } from "@/components/ui/button";
import { useCampaigns } from "@/features/operator/hooks";

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

function List({ items }: { items: readonly string[] }) {
  return (
    <ul className="max-w-[64ch] divide-y divide-border border-y border-border">
      {items.map((item) => (
        <li key={item} className="py-3 text-base">
          {item}
        </li>
      ))}
    </ul>
  );
}

/** Nothing has been sent yet, so there is nothing for an auditor to check: say so, and offer the way to something. */
function NothingToAudit() {
  return (
    <section aria-labelledby="audit-empty-heading" className="space-y-6" data-testid="audit-empty">
      <div className="max-w-[64ch] space-y-2">
        <h2 id="audit-empty-heading" className="text-[1.75rem] leading-tight font-bold tracking-[-0.02em] text-balance">
          Nothing to audit yet
        </h2>
        <p className="text-base text-muted-foreground">An audit checks a payout that was sent. Send one, then come back here.</p>
      </div>
      <GhostRows rows={2} />
      <Button asChild size="lg">
        <Link to="/new">Start a payout</Link>
      </Button>
    </section>
  );
}

export default function AuditPage() {
  const campaigns = useCampaigns();
  // Only a list that came back empty counts: while it loads, or if it cannot be read, the page stays as it was.
  const none = campaigns.isSuccess && campaigns.data.length === 0;
  return (
    <>
      <PageHeader title="Audit" description="Only someone with the viewing key can check the payments against the list." />
      <div className="space-y-12">
        {none && <NothingToAudit />}
        <section aria-labelledby="run-heading" className="space-y-4">
          <h2 id="run-heading" className="text-[1.75rem] leading-tight font-bold tracking-[-0.02em]">
            Run it on the auditor&apos;s computer
          </h2>
          <p className="max-w-[64ch] text-base">
            The audit is a command-line tool. It keeps the viewing key inside that process.{" "}
            <Why inline label="How the viewing key gets in">
              <p>The auditor pastes the viewing key on standard input, so it never lands in shell history.</p>
            </Why>
          </p>
          <pre className="max-w-[64ch] overflow-x-auto rounded-(--r-control) border border-border bg-secondary p-4 font-mono text-sm text-foreground">
            {COMMAND}
          </pre>
          <CopyButton value={COMMAND} label="Copy command" text="Copy command" />
        </section>

        {/* Everything else is one click away, closed to begin with: the page is the command, and the way in to the rest. */}
        <div className="border-b border-border">
          <Disclosure summary="What the audit checks">
            <List items={CHECKS} />
          </Disclosure>
          <Disclosure summary="Getting the viewing key">
            <div className="space-y-4">
              <p className="max-w-[64ch] text-base">{DISCLOSURE_WARNING}</p>
              <p className="max-w-[64ch] text-base text-muted-foreground">
                The key is on a payout&apos;s own page, under &ldquo;Give an auditor access&rdquo;, after you confirm you understand.
              </p>
              {!none && (
                <Button asChild variant="outline">
                  <Link to="/campaigns">Open your payouts</Link>
                </Button>
              )}
            </div>
          </Disclosure>
          <Disclosure summary="Limits">
            <List items={LIMITS} />
          </Disclosure>
          <Disclosure summary="Options and what the report holds">
            <p className="max-w-[64ch] text-base text-muted-foreground">
              Add <code className="font-mono">--receipt-commitment</code> to compare with the commitment printed on a public receipt
              instead of the stored one, and <code className="font-mono">--json</code> for a machine-readable report. The report holds
              counts, public sums, transaction ids and yes/no results; it has no addresses, memos or per-recipient amounts. Check{" "}
              <code className="font-mono">drop-operator audit --help</code> for the flags in your version.
            </p>
          </Disclosure>
        </div>
      </div>
    </>
  );
}
