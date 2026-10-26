import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";

import { SAMPLE_RECEIPT_HREF } from "@/api/demo";
import { checkPayslip, PayslipFetchError, type PayslipFailureKind } from "@/api/payslip";
import { PAYSLIP_NOT_PROVEN, type PayslipAnswer } from "@/api/payslip-answer";
import { PAYSLIP_PROBLEM_TEXT, payslipText, readPayslip, type PayslipProblem } from "@/api/payslip-input";
import { claimsToBeLink, readPayslipFragment } from "@/api/payslip-link";
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
import { SendPayslip } from "./SendPayslip";
import { LINK_NOTICE, LINK_PROBLEM, type Stated } from "./wording";

// Wording follows docs/PRIVACY_BOUNDARY.md, "Payslips". The page sends the payslip to the verifier,
// and says so next to the button: the payslip names a receiver and an amount, and its secret also
// opens one output's memo. It is kept in this component's state and nowhere else: not in storage, not
// in a message to the console, and not in the address, except where the person asks for a link or a
// QR code of it, which holds it after the "#" only (openspec REQ-PAY-004; SendPayslip.tsx). A page
// opened from such a link reads the payslip once, takes the fragment out of the address bar at once,
// and checks nothing until the person asks.

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

/** The page. What is in the address bar is its business first: a payslip link is taken out of it before anything else
 * happens, whatever the link held, and a link opened while this page is already open (a change of the fragment alone, as
 * when one is pasted into the address bar of the tab) loads its payslip as a link opened afresh does. */
export default function PayslipPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const link = claimsToBeLink(location.hash) ? location.hash : "";
  const [opened, setOpened] = useState({ link, version: 0 });
  // A new link starts the page again with its payslip: it replaces whatever was in the box, and drops a check that was running.
  // (Adjusted while rendering, so that no frame shows the old payslip beside the new address.)
  if (link !== opened.link) setOpened({ link, version: link === "" ? opened.version : opened.version + 1 });

  // The fragment leaves the address bar before anything else happens, whatever it held: a payslip in an address is a
  // bearer document, and the address bar, the history and whatever a browser syncs are no place to leave it. It is
  // replaced in the history entry, not added to it, and the state the router keeps for the entry is kept.
  useLayoutEffect(() => {
    if (link === "") return;
    window.history.replaceState(window.history.state, "", `${location.pathname}${location.search}`);
  }, [link, location.pathname, location.search]);

  // The router is told once it is listening (a child's layout effect runs before its parent's, so the router
  // cannot hear it any sooner), so that what it thinks the address is agrees with the address bar.
  useEffect(() => {
    if (link === "") return;
    void navigate({ pathname: location.pathname, search: location.search }, { replace: true });
  }, [link, location.pathname, location.search, navigate]);

  return <PayslipChecker key={opened.version} opened={opened.link} />;
}

/** The box, the check and what it shows. `opened` is the fragment the page was (re)started with, read once. */
function PayslipChecker({ opened }: { opened: string }) {
  // A link that carries a payslip. Null when the page was started with none.
  const [arrival] = useState(() => readPayslipFragment(opened));
  const [text, setText] = useState(() => (arrival?.ok === true ? payslipText(arrival.payslip) : ""));
  const [fromLink, setFromLink] = useState(arrival?.ok === true);
  const [badLink, setBadLink] = useState(arrival?.ok === false);
  const [edits, setEdits] = useState(0);
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
    setFromLink(false);
    setBadLink(false);
    setEdits((count) => count + 1);
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
  const ready = readPayslip(text);

  return (
    <>
      <PageHeader
        title="Check a payslip"
        description="A payslip is a small file one recipient can show to prove one payout to them, without revealing anyone else's. Checking it needs no viewing key."
      />
      <div className="max-w-[64ch]">
        <div className="mb-10 space-y-6">
          {fromLink && (
            <Alert role="note" variant="warning">
              <AlertDescription className="text-card-foreground">
                <p>{LINK_NOTICE}</p>
              </AlertDescription>
            </Alert>
          )}
          {badLink && (
            <p role="alert" className="text-base font-semibold text-problem">
              {LINK_PROBLEM}
            </p>
          )}
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

          {ready.ok && <SendPayslip key={edits} payslip={ready.payslip} />}
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
