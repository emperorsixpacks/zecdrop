import type { ReactNode, Ref } from "react";

import type { PayslipFailureKind } from "@/api/payslip";
import type { PayslipAnswer } from "@/api/payslip-answer";
import { UnitNote, UnitProvider } from "@/components/UnitProvider";
import { Zec } from "@/components/Zec";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { ZecNetwork } from "@/lib/config";
import { explorerTxUrl } from "@/lib/explorer";
import { shortId } from "@/lib/ids";

import { FAILURE_TEXT, wording, type Stated } from "./wording";

export const RESULT_HEADING_ID = "payslip-result-heading";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-8 gap-y-0.5 sm:grid-cols-[13rem_1fr]">
      <dt className="text-sm text-muted-foreground sm:pt-0.5">{label}</dt>
      <dd className="min-w-0 text-base">{children}</dd>
    </div>
  );
}

function Tick() {
  return (
    // Drawn once, as on a settled receipt: the word beside it says the same.
    <svg aria-hidden viewBox="0 0 56 56" className="check-draw mt-0.5 size-9 shrink-0 sm:size-12">
      <circle cx="28" cy="28" r="28" fill="var(--verified)" />
      <path d="M16 29l8 8 16-17" fill="none" stroke="var(--background)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The verifier's answer as one sheet: the verdict, one or two sentences, and what the page can say about the
 * output. The amount and the receiver are labelled as what the payslip states: the verifier's answer holds
 * neither. */
export function VerdictSheet({ answer, stated, headingRef }: { answer: PayslipAnswer; stated: Stated; headingRef: Ref<HTMLHeadingElement> }) {
  const { outcome } = answer;
  const { heading, lines } = wording(answer);
  const matches = outcome.verdict === "verified" || outcome.verdict === "pending";
  const tone = outcome.verdict === "verified" ? "text-verified" : outcome.verdict === "invalid" ? "text-problem" : "";

  return (
    <UnitProvider network={answer.network}>
      <section
        aria-labelledby={RESULT_HEADING_ID}
        data-testid="payslip-result"
        data-verdict={outcome.verdict}
        className="space-y-5 border border-t-4 border-border border-t-foreground bg-card p-5 sm:p-8"
      >
        <h2
          id={RESULT_HEADING_ID}
          ref={headingRef}
          tabIndex={-1}
          className="display flex items-start gap-3 text-[1.625rem] leading-[1.1] text-balance sm:text-[2.25rem]"
        >
          {outcome.verdict === "verified" && <Tick />}
          <span className={tone}>{heading}</span>
        </h2>
        <div className="max-w-[56ch] space-y-2 text-base">
          {lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        <dl className="space-y-3 border-t border-border pt-4">
          {matches && (
            <>
              <Row label="Amount the payslip states">
                <Zec zatoshi={stated.value} />
              </Row>
              <Row label="Receiver the payslip states">
                <code className="mono text-sm" translate="no">
                  {shortId(stated.receiver)}
                </code>
              </Row>
            </>
          )}
          <Row label="Transaction">
            <span className="flex flex-wrap items-center gap-x-4">
              <code className="mono text-sm" title={answer.txid} translate="no">
                {shortId(answer.txid)}
              </code>
              <a
                href={explorerTxUrl(answer.network, answer.txid)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center font-medium text-link underline underline-offset-4"
              >
                Open in the explorer<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </span>
          </Row>
          {outcome.verdict !== "not_found" && outcome.verdict !== "invalid" ? (
            <>
              <Row label="Action">
                {answer.action} (of {outcome.ironwoodActions}, counting from 0)
              </Row>
              <Row label="Confirmations">
                {outcome.confirmations} (final at {answer.requiredDepth})
              </Row>
            </>
          ) : (
            <Row label="Action">{answer.action}</Row>
          )}
        </dl>
        {matches && <UnitNote />}
      </section>
    </UnitProvider>
  );
}

/** The check did not give an answer. Calm on purpose: none of these says anything about the payslip. */
export function FailureNotice({ kind, network, headingRef }: { kind: PayslipFailureKind; network: ZecNetwork; headingRef: Ref<HTMLHeadingElement> }) {
  const { title, text } = FAILURE_TEXT[kind](network);
  return (
    <Alert variant="warning" role="group" aria-labelledby={RESULT_HEADING_ID} data-testid="payslip-failure" data-kind={kind} className="space-y-2 p-4">
      <AlertTitle className="text-base">
        <h2 id={RESULT_HEADING_ID} ref={headingRef} tabIndex={-1}>
          {title}
        </h2>
      </AlertTitle>
      <AlertDescription className="text-base text-card-foreground">
        <p>{text}</p>
      </AlertDescription>
    </Alert>
  );
}

export function Checking() {
  return <p className="text-base text-muted-foreground">Checking the payslip against the chain&hellip;</p>;
}

/** What the answer leaves open. Always on the page: before anything is checked, the built-in copy of the
 * verifier's list; after an answer, the verifier's own. */
export function NotProven({ sentences }: { sentences: readonly string[] }) {
  return (
    <section aria-labelledby="payslip-not-proven" className="space-y-3">
      <h2 id="payslip-not-proven" className="text-[1.75rem] leading-tight font-bold tracking-[-0.02em]">
        What this does not prove
      </h2>
      <ul className="list-disc space-y-2 pl-5 text-base" data-testid="not-proven">
        {sentences.map((sentence, index) => (
          <li key={`${String(index)}-${sentence}`}>{sentence}</li>
        ))}
      </ul>
    </section>
  );
}
