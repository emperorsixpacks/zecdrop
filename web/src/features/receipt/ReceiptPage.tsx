import { Collapsible } from "radix-ui";
import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";

import { DEMOS, REAL_CAPTURES, demoCase, isRealDemo } from "@/api/demo";
import { ReceiptFetchError } from "@/api/receipt";
import { parseReceiptLink, type ReceiptQuery } from "@/api/receipt-query";
import type { PublicReceipt } from "@/api/types";
import { PageHeader } from "@/components/PageHeader";
import { UnitProvider } from "@/components/UnitProvider";
import { Button } from "@/components/ui/button";
import { config } from "@/lib/config";
import { isTerminalPhase } from "@/lib/phase";

import { checkReceipt } from "./checks";
import {
  BadLinkNotice,
  InvalidResponseNotice,
  MismatchNotice,
  NotFoundNotice,
  ReceiptLoading,
  RejectedNotice,
  UnreachableNotice,
} from "./ReceiptStates";
import { ReceiptView } from "./ReceiptView";
import { useReceipt } from "./useReceipt";

/** PUBLIC receipt page: what the hackathon judges, and anyone with a link,
 * open. Only data that came through parsePublicReceipt is ever rendered. */
export default function ReceiptPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const demo = demoCase(id, search);

  const link = useMemo(() => (demo !== null ? null : parseReceiptLink(search)), [demo, search]);
  const query = link?.ok ? link.query : null;
  const result = useReceipt({ demo, query });
  const receipt = result.data;
  // Amounts are in the coin of the receipt's network (TAZ on testnet), or of the
  // link's claim while the answer is still on its way.
  const network = receipt?.network ?? query?.network ?? config.network;

  return (
    <UnitProvider network={network}>
      <PageHeader
        title="Payout receipt"
        description={
          demo !== null ? (
            sampleLine(demo)
          ) : (
            <span className="font-mono break-all" translate="no">
              {receipt?.campaignId ?? id}
            </span>
          )
        }
      />

      <div className="space-y-10">
        {demo !== null && <SampleBar current={demo} />}

        {link && !link.ok ? (
          <BadLinkNotice problem={link.problem} />
        ) : result.isPending ? (
          <ReceiptLoading />
        ) : result.isError ? (
          <FailureNotice
            error={result.error}
            onRetry={() => void result.refetch()}
            retrying={result.isFetching}
          />
        ) : (
          <Answer
            receipt={receipt}
            claim={query}
            live={demo === null}
            updatedAt={result.dataUpdatedAt}
            refreshing={result.isFetching}
            onRefresh={() => void result.refetch()}
          />
        )}
      </div>
    </UnitProvider>
  );
}

function FailureNotice({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  if (!(error instanceof ReceiptFetchError)) return <InvalidResponseNotice />;
  switch (error.kind) {
    case "unreachable":
      return <UnreachableNotice onRetry={onRetry} retrying={retrying} />;
    case "not_found":
      return <NotFoundNotice />;
    case "rejected":
      return <RejectedNotice />;
    case "invalid_response":
      return <InvalidResponseNotice />;
  }
}

function Answer({
  receipt,
  claim,
  live,
  updatedAt,
  refreshing,
  onRefresh,
}: {
  receipt: PublicReceipt | undefined;
  /** What the link claimed; null for the demo, which makes no claim. */
  claim: ReceiptQuery | null;
  live: boolean;
  updatedAt: number;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  if (!receipt) return null;
  const problems = checkReceipt(receipt, claim ?? undefined);

  return (
    <>
      {problems.length > 0 && <MismatchNotice problems={problems} showingAnswer />}

      {live && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <p>
            Updated{" "}
            <time dateTime={new Date(updatedAt).toISOString()}>
              {new Date(updatedAt).toLocaleTimeString()}
            </time>
            {!isTerminalPhase(receipt.phase.phase) &&
              ". This page checks again every few seconds while payouts are in progress."}
          </p>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Checking…" : "Check again"}
          </Button>
        </div>
      )}

      <ReceiptView receipt={receipt} />
    </>
  );
}

type Sample = NonNullable<ReturnType<typeof demoCase>>;

/** One line saying what the sample is, before the receipt starts. */
function sampleLine(current: Sample): string {
  if (isRealDemo(current)) {
    const capture = REAL_CAPTURES[current];
    return `${current === "real" ? "Real batch" : "The first real batch"} on ${capture.network}, captured at height ${capture.capturedAt}`;
  }
  const here = DEMOS.find((d) => d.case === current);
  return `Sample data: ${(here?.label ?? "").toLowerCase()}`;
}

/** The sample switcher, and the provenance behind a "Details" click. */
function SampleBar({ current }: { current: Sample }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const here = DEMOS.find((d) => d.case === current);
  const capture = isRealDemo(current) ? REAL_CAPTURES[current] : null;
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="border-y border-border">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
        <label htmlFor="sample-switch" className="text-base font-semibold">
          Sample
        </label>
        <select
          id="sample-switch"
          value={current}
          onChange={(event) => {
            const next = DEMOS.find((d) => d.case === event.target.value);
            if (next !== undefined) void navigate(next.href);
          }}
          className="h-11 rounded-lg border border-foreground bg-card px-3 text-base font-medium"
        >
          {DEMOS.map((d) => (
            <option key={d.case} value={d.case}>
              {d.short}
            </option>
          ))}
        </select>
        <Collapsible.Trigger className="ml-auto inline-flex min-h-11 items-center gap-2 px-1 text-base font-semibold">
          Details
          <span aria-hidden className="mono text-xl leading-none text-muted-foreground">
            {open ? "\u2212" : "+"}
          </span>
        </Collapsible.Trigger>
      </div>
      <Collapsible.Content className="pb-5">
        <div className="max-w-[64ch] space-y-3 text-base">
          {capture !== null ? (
            <>
              <p>
                Mined on {capture.network} at height {capture.minedAt} and captured at height {capture.capturedAt}; confirmations are
                shown as of the capture, not live. The transaction is real. Testnet coins have no value.
              </p>
              <p>
                It was read by the same verifier that answers real links, and bundled with this page. The explorer links go to a
                third-party explorer&apos;s own pages. Explorers are third parties and can lag behind the chain; if one does not know
                this transaction, that does not change what the verifier read.
              </p>
            </>
          ) : (
            <p>
              This is example data bundled with the app, not a real campaign. Its transaction ids are placeholders, so the explorer
              links will not find them.
            </p>
          )}
          {here && <p>{here.summary}</p>}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
