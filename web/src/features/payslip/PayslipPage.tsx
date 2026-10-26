import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { SAMPLE_RECEIPT_HREF } from "@/api/demo";
import { checkPayslip, PayslipFetchError, type PayslipFailureKind } from "@/api/payslip";
import { PAYSLIP_NOT_PROVEN, type PayslipAnswer } from "@/api/payslip-answer";
import { PAYSLIP_PROBLEM_TEXT, readPayslip, type PayslipProblem } from "@/api/payslip-input";
import { changedSamplePayslipText, SAMPLE_PAYSLIP_TEXT } from "@/api/payslip-sample";
import { PageHeader } from "@/components/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ZecNetwork } from "@/lib/config";
import { coinUnit } from "@/lib/units";
import { formatZec } from "@/lib/zec";

import { Checking, FailureNotice, NotProven, VerdictSheet } from "./PayslipResult";
import type { Stated } from "./wording";

// Wording follows docs/PRIVACY_BOUNDARY.md, "Payslips". The page sends the payslip to the verifier,
// and says so next to the button: the payslip names a receiver and an amount, and its secret also
// opens one output's memo. It is kept in this component's state and nowhere else: not in the
// address, not in storage, not in a message to the console.

const FIELD_ID = "payslip-text";
const HINT_ID = "payslip-hint";
const PROBLEM_ID = "payslip-problem";

/** A command that wraps between its words and never inside one: a line that ends in "--" cannot be copied by eye. */
function Command({ parts }: { parts: readonly string[] }) {
  return (
    <code className="mono text-sm">
      {parts.map((part, index) => (
        <span key={part}>
          {index > 0 && " "}
          <span className="whitespace-nowrap">{part}</span>
        </span>
      ))}
    </code>
  );
}

type Step =
  | { step: "idle" }
  /** The paste was refused before anything was sent. */
  | { step: "problem"; problem: PayslipProblem }
  | { step: "checking" }
  | { step: "answered"; answer: PayslipAnswer; stated: Stated }
  | { step: "failed"; kind: PayslipFailureKind; network: ZecNetwork };

export default function PayslipPage() {
  const [text, setText] = useState("");
  const [state, setState] = useState<Step>({ step: "idle" });
  const field = useRef<HTMLTextAreaElement>(null);
  const running = useRef<AbortController | null>(null);

  // Leaving the page drops a check that has not finished.
  useEffect(
    () => () => {
      running.current?.abort();
    },
    [],
  );

  // The result takes focus when it appears, so a keyboard or screen reader user lands on it.
  const [resultHeading, setResultHeading] = useState<HTMLElement | null>(null);
  useEffect(() => {
    resultHeading?.focus();
  }, [resultHeading]);

  /** A new text is a new question: whatever was asked or answered about the old one is dropped. */
  function replaceText(next: string) {
    running.current?.abort();
    running.current = null;
    setText(next);
    setState({ step: "idle" });
  }

  async function check() {
    if (state.step === "checking") return;
    const read = readPayslip(text);
    if (!read.ok) {
      setState({ step: "problem", problem: read.problem });
      field.current?.focus();
      return;
    }
    const { payslip } = read;
    const controller = new AbortController();
    running.current = controller;
    setState({ step: "checking" });
    try {
      const answer = await checkPayslip(payslip, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setState({ step: "answered", answer, stated: { value: payslip.value, receiver: payslip.receiver } });
    } catch (error) {
      if (controller.signal.aborted) return;
      setState({ step: "failed", kind: error instanceof PayslipFetchError ? error.kind : "unreachable", network: payslip.network });
    }
  }

  const checking = state.step === "checking";
  const problem = state.step === "problem";

  return (
    <>
      <PageHeader
        title="Check a payslip"
        description="A payslip is a small file one recipient can show to prove one payout to them, without revealing anyone else's. Checking it needs no viewing key."
      />
      <div className="max-w-[64ch]">
        <div className="mb-10 space-y-6">
          <div className="space-y-2">
            <Label htmlFor={FIELD_ID}>Payslip</Label>
            <p id={HINT_ID} className="text-sm text-muted-foreground">
              Paste the whole file.
            </p>
            <Textarea
              id={FIELD_ID}
              ref={field}
              value={text}
              onChange={(event) => {
                replaceText(event.target.value);
              }}
              rows={8}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              aria-invalid={problem}
              aria-describedby={problem ? `${HINT_ID} ${PROBLEM_ID}` : HINT_ID}
              className="mono max-h-[30rem]"
            />
            {state.step === "problem" && (
              <p id={PROBLEM_ID} role="alert" className="text-base font-semibold text-problem">
                {PAYSLIP_PROBLEM_TEXT[state.problem]}
              </p>
            )}
          </div>

          <Alert role="note" variant="warning">
            <AlertTitle>Checking here shares the payslip</AlertTitle>
            <AlertDescription className="space-y-2 text-card-foreground">
              <p>The check sends the payslip to the verifier: its receiver, its amount and the secret that also opens its memo.</p>
              <p>The verifier&apos;s code does not log or keep it, but whoever runs the verifier can see it.</p>
              <p>
                For a private check, run <Command parts={["drop-operator", "verify-payslip", "--payslip FILE", "--tx FILE"]} /> on your own
                computer. It works offline.
              </p>
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap gap-3">
            <Button
              aria-disabled={checking}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-45"
              onClick={() => void check()}
            >
              {checking ? "Checking…" : "Check payslip"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                replaceText("");
                field.current?.focus();
              }}
            >
              Clear
            </Button>
          </div>

          <div className="space-y-3 border-t border-border pt-6">
            <div className="flex flex-wrap gap-3">
              <Button
                variant="secondary"
                onClick={() => {
                  replaceText(SAMPLE_PAYSLIP_TEXT);
                }}
              >
                Load a sample
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  replaceText(changedSamplePayslipText());
                }}
              >
                Load a changed copy
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              The sample is payslip 3 of the real 8-person payout that ran on public testnet. See its{" "}
              <Link to={SAMPLE_RECEIPT_HREF} className="font-medium text-link underline underline-offset-4">
                receipt
              </Link>
              . The changed copy asks for {formatZec(1n)} {coinUnit("testnet")} more, so you can watch the check fail.
            </p>
          </div>
        </div>

        {/* Always in the page, so a screen reader hears what lands in it. */}
        <div role="status" aria-live="polite" data-testid="payslip-outcome" className="[&:not(:empty)]:mb-10">
          {state.step === "checking" && <Checking />}
          {state.step === "answered" && <VerdictSheet answer={state.answer} stated={state.stated} headingRef={setResultHeading} />}
          {state.step === "failed" && <FailureNotice kind={state.kind} network={state.network} headingRef={setResultHeading} />}
        </div>

        <NotProven sentences={state.step === "answered" ? state.answer.notProven : PAYSLIP_NOT_PROVEN} />
      </div>
    </>
  );
}
