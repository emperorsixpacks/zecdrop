import { useState, type ReactNode } from "react";
import { Link } from "react-router";

import { PageHeader } from "@/components/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { classifyAddress } from "@/lib/address-shape";
import { isAbort } from "@/lib/share";

import { BUTTONS_HINT, describeShape, FEEDBACK_TEXT, PROMISE, SHAPE_NOTE, shareText, ZODL_URL, type Feedback } from "./wording";

// Static and private (openspec REQ-ONB-001): this page makes no request to any server, stores nothing, writes
// nothing to the console and puts nothing in the address bar. The address lives in this component's state, is
// read by a function that returns a value, and leaves only when the person taps Share or Copy. Nothing in this
// file may call fetch, touch storage or a cookie, log, or navigate: GetPaidPage.test.tsx scans the source for
// each, and watches the browser's own calls while an address is pasted, checked and shared.

const FIELD_ID = "address";
const NOTE_ID = "address-note";

const linkClass = "inline-flex min-h-11 items-center font-medium text-link underline underline-offset-4";

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <li className="space-y-4">
      <div className="flex items-start gap-3">
        <span aria-hidden className="mono flex size-8 shrink-0 items-center justify-center rounded-[4px] bg-primary text-base font-medium text-primary-foreground">
          {number}
        </span>
        {/* A title that takes two lines on a phone stays level with its number's top. */}
        <h2 className="pt-0.5 text-xl leading-snug font-bold tracking-[-0.01em]">{title}</h2>
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
      <div className="max-w-[64ch] space-y-12">
        <p className="text-lg">{PROMISE}</p>

        <ol className="space-y-12">
          <Step number={1} title="Get a wallet">
            <p>A wallet is an app that holds your money and gives you an address to be paid at.</p>
            <p>Zodl is one example: a Zcash wallet for phones. Version 3.8.0 or newer supports the shielded pool that payouts use.</p>
            <Button asChild variant="outline">
              <a href={ZODL_URL} target="_blank" rel="noopener noreferrer">
                Zodl at zodl.com<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
            <p>
              Other wallets may work, but we have only checked Zodl&apos;s release notes. A wallet that cannot receive in the current pool will not
              show the payout.
            </p>
          </Step>

          <Step number={2} title="Copy your address">
            <p>In your wallet, open Receive and copy the address that starts with u1. That is a real-money address.</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>An address that starts with utest1 is a testnet address: play money, for practice only.</li>
              <li>
                Do not use an address that starts with t1 or t3. A transparent address shows every payment publicly, and ZecDrop payouts are for
                shielded wallets.
              </li>
              <li>An address that starts with zs1 is a Sapling address, an older kind. The payout tool asks for the u1 one.</li>
            </ul>
          </Step>

          <Step number={3} title="Give it to whoever is paying you">
            <div className="space-y-4 rounded-md border border-border bg-card p-4 sm:p-6">
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

              <div role="status" aria-live="polite" data-testid="share-feedback" className="empty:-mt-4">
                {feedback !== null && <p className="text-base font-medium">{FEEDBACK_TEXT[feedback]}</p>}
              </div>
            </div>
          </Step>

          <Step number={4} title="When you are paid">
            <p>Your wallet shows the payout after a few confirmations, about 4 minutes on mainnet today. If there is a memo, it shows with the payout.</p>
            <p>
              If the payer ran ZecDrop, they can also give you a payslip: a small file that proves one payout to you to someone else. Anyone can
              check one on the Check a payslip page.
            </p>
            <p>A payslip also shows what the memo says, so share it only with who you mean to.</p>
            <p>
              <Link to="/payslip" className={linkClass}>
                Check a payslip
              </Link>
            </p>
          </Step>
        </ol>

        <div className="space-y-1 border-t border-border pt-8">
          <p className="text-base">
            Shielded does not mean invisible: a payout of one, or of equal amounts, can let others work out the amount. The full list of what stays
            private is on How privacy works.
          </p>
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
