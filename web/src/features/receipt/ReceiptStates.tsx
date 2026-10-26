import type { ReactNode } from "react";
import { Link } from "react-router";

import { SAMPLE_RECEIPT_HREF } from "@/api/demo";
import { LINK_PROBLEM_TEXT, type LinkProblem } from "@/api/receipt-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ZecNetwork } from "@/lib/config";
import { usePractice } from "@/lib/practice-mode";
import { useCoinUnit, type CoinUnit } from "@/lib/units";
import { zecFromZatoshi } from "@/lib/zec";
import { shortId } from "@/lib/ids";

import type { ReceiptProblem } from "./checks";

/** Every state here is calm on purpose: it says what happened, what it does
 * and does not mean, and what to do next. None of them is red, because none
 * of them, by itself, says money went missing. */
interface NoticeProps {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  variant?: "info" | "warning";
}

function Notice({ title, children, actions, variant = "info" }: NoticeProps) {
  return (
    // role="alert" so a screen reader hears the outcome of the check as soon as it lands.
    <Alert variant={variant} role="alert" className="space-y-3 p-4">
      <AlertTitle className="text-base">
        <h2>{title}</h2>
      </AlertTitle>
      <AlertDescription className="space-y-2 text-sm text-card-foreground">
        {children}
      </AlertDescription>
      {actions && <div className="flex flex-wrap gap-2 pt-1">{actions}</div>}
    </Alert>
  );
}

const sampleLink = (
  <Button asChild variant="outline">
    <Link to={SAMPLE_RECEIPT_HREF}>See a sample receipt</Link>
  </Button>
);

// ---- Loading ---------------------------------------------------------------

export function ReceiptLoading() {
  const practice = usePractice((state) => state.on);
  return (
    <div role="status" aria-busy="true" className="space-y-6">
      <p className="text-sm text-muted-foreground">
        {practice ? "Asking the practice verifier, which is part of this page\u2026" : "Asking the verifier to read the chain\u2026"}
      </p>
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-2 w-full" />
          <div className="grid gap-4 sm:grid-cols-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        </CardContent>
      </Card>
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

// ---- Problems with the link or the verifier --------------------------------

export function BadLinkNotice({ problem }: { problem: LinkProblem }) {
  return (
    <Notice title="This receipt link is incomplete" actions={sampleLink}>
      <p>{LINK_PROBLEM_TEXT[problem]}</p>
      <p>Ask whoever sent it for a fresh link, or open a sample to see what a receipt looks like.</p>
    </Notice>
  );
}

export function UnreachableNotice({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <Notice
      title="The verifier can't be reached right now"
      actions={
        <Button onClick={onRetry} disabled={retrying}>
          {retrying ? "Trying again…" : "Try again"}
        </Button>
      }
    >
      <p>
        That says nothing about the campaign itself: the verifier may be busy, offline, or your
        connection may have dropped.
      </p>
      <p>Nothing was lost. Try again in a moment.</p>
    </Notice>
  );
}

export function NotFoundNotice() {
  return (
    <Notice title="The verifier has no record of these transactions" actions={sampleLink}>
      <p>
        They may not be confirmed yet, or the link may be wrong. Transactions can take a few
        minutes to appear.
      </p>
    </Notice>
  );
}

export function RejectedNotice() {
  return (
    <Notice title="The verifier couldn't read this link" actions={sampleLink}>
      <p>The request was refused as malformed. Ask whoever sent the link for a fresh one.</p>
    </Notice>
  );
}

export function NetworkNotServedNotice({ network }: { network: ZecNetwork }) {
  return (
    <Notice title="This verifier does not serve that network" actions={sampleLink}>
      <p>
        The link is for {network}, and this verifier is not set up to read that chain. That says nothing
        about the campaign itself.
      </p>
      <p>Ask whoever sent the link which verifier to use for it.</p>
    </Notice>
  );
}

export function PracticeNotice() {
  return (
    <Notice title="Practice mode does not read the chain" actions={sampleLink}>
      <p>This is not a receipt that practice mode made, and practice mode asks no verifier, so there is nothing to show for it.</p>
      <p>Leave practice mode to open a receipt link from someone else.</p>
    </Notice>
  );
}

export function InvalidResponseNotice() {
  return (
    <Notice title="The verifier's answer wasn't in the expected format">
      <p>
        For your safety this page only shows answers that match the published receipt format
        exactly. An answer with extra or missing fields is not shown, in case it contains more than
        a public receipt should.
      </p>
      <p>Try again later. If it keeps happening, tell the person who sent you the link.</p>
    </Notice>
  );
}

// ---- Mismatch --------------------------------------------------------------

function describe(problem: ReceiptProblem, unit: CoinUnit): ReactNode {
  switch (problem.kind) {
    case "network_differs":
      return (
        <>
          Network: the link says <strong>{problem.claimed}</strong>, the verifier read{" "}
          <strong>{problem.found}</strong>.
        </>
      );
    case "declared_total_differs":
      return (
        <>
          Declared total: the link says <strong>{zecFromZatoshi(problem.claimed)} {unit}</strong>, the
          chain adds up to <strong>{zecFromZatoshi(problem.found)} {unit}</strong>.
        </>
      );
    case "commitment_differs":
      return (
        <>
          Manifest commitment: the link says{" "}
          <code title={problem.claimed}>{shortId(problem.claimed)}</code>, the receipt has{" "}
          <code title={problem.found}>{shortId(problem.found)}</code>.
        </>
      );
    case "transactions_differ":
      return (
        <>
          Transactions: {problem.missing.length} in the link{" "}
          {problem.missing.length === 1 ? "was" : "were"} not found in the receipt, and{" "}
          {problem.unexpected.length} in the receipt {problem.unexpected.length === 1 ? "is" : "are"}{" "}
          not in the link.
        </>
      );
    case "batches_do_not_add_up":
      return (
        <>
          {problem.field === "declared_total" ? "Declared total" : "Fee total"}: the receipt says{" "}
          <strong>{zecFromZatoshi(problem.reported)} {unit}</strong>, but its batches add up to{" "}
          <strong>{zecFromZatoshi(problem.sum)} {unit}</strong>.
        </>
      );
  }
}

interface MismatchNoticeProps {
  /** What differs, when this page could work it out. Empty when the verifier
   * itself reported the mismatch without details. */
  problems: readonly ReceiptProblem[];
  /** True when the verifier's answer is shown below this notice. */
  showingAnswer?: boolean;
}

export function MismatchNotice({ problems, showingAnswer = false }: MismatchNoticeProps) {
  const unit = useCoinUnit();
  return (
    <Notice
      variant="warning"
      title="The chain and this link don't agree"
      actions={sampleLink}
    >
      {problems.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5">
          {problems.map((problem, i) => (
            <li key={`${problem.kind}-${String(i)}`}>{describe(problem, unit)}</li>
          ))}
        </ul>
      ) : (
        <p>The verifier compared the chain with what this link claims and the two differ.</p>
      )}
      <p>
        That means this link&apos;s claims could not be confirmed. It can happen when a link was
        copied incompletely or edited, or when the campaign changed after the link was made. It is
        worth asking the sender for a fresh link before relying on it.
      </p>
      {showingAnswer && <p>Below is what the verifier actually found.</p>}
    </Notice>
  );
}
