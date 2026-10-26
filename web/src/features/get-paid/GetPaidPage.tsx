import { useState, type ReactNode } from "react";
import { Link } from "react-router";

import { PageHeader } from "@/components/PageHeader";
import { Disclosure } from "@/components/Disclosure";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { classifyAddress } from "@/lib/address-shape";
import { isAbort } from "@/lib/share";

import {
  ASSURANCE,
  BUTTONS_HINT,
  COPY_STEP,
  describeShape,
  FEEDBACK_TEXT,
  OTHER_ADDRESSES,
  OTHER_WALLETS_NOTE,
  PROMISE,
  SHAPE_NOTE,
  SHIELDED_NOTE,
  shareText,
  WALLET_LINE,
  ZODL_URL,
  type Feedback,
} from "./wording";

// Static and private (openspec REQ-ONB-001): this page makes no request to any server, stores nothing, writes
// nothing to the console and puts nothing in the address bar. The address lives in this component's state, is
// read by a function that returns a value, and leaves only when the person taps Share or Copy. Nothing in this
// file may call fetch, touch storage or a cookie, log, or navigate: GetPaidPage.test.tsx scans the source for
// each, and watches the browser's own calls while an address is pasted, checked and shared.

const FIELD_ID = "address";
const NOTE_ID = "address-note";

const linkClass = "inline-flex min-h-11 items-center font-medium text-link underline underline-offset-4";

/** One step, on a slip of its own: a number that is drawn and not read, the title, and what to do. */
function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <li className="slip space-y-3 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <span aria-hidden className="mono flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-base font-medium text-primary-foreground">
          {number}
        </span>
        <h2 className="text-xl leading-snug font-bold tracking-[-0.01em]">{title}</h2>
      </div>
      <div className="space-y-3 text-base">{children}</div>
    </li>
  );
}

export default function GetPaidPage() {
  const [text, setText] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const shape = classifyAddress(text);
  const described = describeShape(shape);
  // Where the phone has a share sheet, Share opens it. Copy is always there.
  const canShare = typeof navigator.share === "function";

  async function copy(done: "copied" | "fallback_copied") {
    try {
      await navigator.clipboard.writeText(shape.shareable);
      setFeedback(done);
    } catch {
      setFeedback("copy_failed");
    }
  }

  async function share() {
    if (!shape.suitsPayouts) return;
    try {
      await navigator.share({ text: shareText(shape.shareable) });
      setFeedback(null);
    } catch (error) {
      // Closing the share sheet is a choice, not a failure: nothing is said. Anything else, copy instead.
      if (isAbort(error)) return;
      await copy("fallback_copied");
    }
  }

  return (
    <>
      <PageHeader title="Get paid in ZEC" />
      <div className="space-y-8">
        <div className="max-w-[44ch] space-y-2">
          <p className="text-xl leading-snug font-medium text-balance">{PROMISE}</p>
          <p className="text-sm text-muted-foreground">{ASSURANCE}</p>
        </div>

        <ol className="grid max-w-[40rem] gap-4 lg:max-w-none lg:grid-cols-2 lg:gap-6">
          <Step number={1} title="Get a wallet">
            <p>{WALLET_LINE}</p>
            <Button asChild variant="outline">
              <a href={ZODL_URL} target="_blank" rel="noopener noreferrer">
                Zodl at zodl.com<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
            <Disclosure summary="More about wallets" className="text-sm">
              <div className="space-y-2 text-muted-foreground">
                <p>{SHIELDED_NOTE}</p>
                <p>{OTHER_WALLETS_NOTE}</p>
              </div>
            </Disclosure>
          </Step>

          <Step number={2} title="Copy your address">
            <p>{COPY_STEP}</p>
            <ul className="divide-y divide-border rounded-(--r-control) border border-border text-sm">
              {OTHER_ADDRESSES.map((kind) => (
                <li key={kind.starts} className="flex items-baseline gap-3 px-3 py-2.5">
                  <span className="mono w-[4.75rem] shrink-0 font-medium">{kind.starts}</span>
                  <span>{kind.text}</span>
                </li>
              ))}
            </ul>
          </Step>

          <Step number={3} title="Give it to your payer">
            <div className="space-y-2">
              <Label htmlFor={FIELD_ID}>Your address</Label>
              <Textarea
                id={FIELD_ID}
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setFeedback(null);
                }}
                rows={3}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                aria-describedby={NOTE_ID}
                className="mono break-all"
              />
              <p id={NOTE_ID} className="text-sm text-muted-foreground">
                {SHAPE_NOTE}
              </p>
            </div>

            {/* Always in the page, so a screen reader hears what lands in it. */}
            <div role="status" aria-live="polite" aria-atomic="true" data-testid="shape-result">
              {described !== null && (
                <Alert role="group" variant={described.tone} data-testid="shape" data-kind={shape.kind}>
                  <AlertTitle>{described.title}</AlertTitle>
                  <AlertDescription className="text-card-foreground">
                    <p>{described.text}</p>
                  </AlertDescription>
                </Alert>
              )}
            </div>

            <div className="flex flex-wrap gap-3">
              {canShare && (
                <Button
                  type="button"
                  disabled={!shape.suitsPayouts}
                  onClick={() => {
                    void share();
                  }}
                >
                  Share
                </Button>
              )}
              <Button
                type="button"
                variant={canShare ? "outline" : "default"}
                disabled={!shape.suitsPayouts}
                onClick={() => {
                  void copy("copied");
                }}
              >
                Copy
              </Button>
            </div>
            {!shape.suitsPayouts && <p className="text-sm text-muted-foreground">{BUTTONS_HINT}</p>}

            <div role="status" aria-live="polite" data-testid="share-feedback" className="empty:-mt-3">
              {feedback !== null && <p className="text-base font-medium">{FEEDBACK_TEXT[feedback]}</p>}
            </div>
          </Step>

          <Step number={4} title="When you are paid">
            <p>Your wallet shows the payout after a few confirmations, about 4 minutes on mainnet today. If there is a memo, it shows with the payout.</p>
            <p>The payer can also give you a payslip: a small file that proves one payout to you. It shows the memo too, so share it with care.</p>
            <p>
              <Link to="/payslip" className={linkClass}>
                Check a payslip
              </Link>
            </p>
          </Step>
        </ol>

        <div className="flex max-w-[64ch] flex-col gap-1 border-t border-border pt-6">
          <p className="text-base">Shielded does not mean invisible: a payout of one, or of equal amounts, can let others work out the amount.</p>
          <p>
            <Link to="/privacy" className={linkClass}>
              How privacy works
            </Link>
          </p>
        </div>
      </div>
    </>
  );
}
