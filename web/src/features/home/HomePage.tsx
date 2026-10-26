import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import { demoReceipt, SAMPLE_RECEIPT_HREF } from "@/api/demo";
import { CountUp } from "@/components/CountUp";
import { RedactionLens, type LensMode } from "@/components/lens/Lens";
import { FOUR_VIEWS } from "@/components/lens/views";
import { UnitNote, UnitProvider } from "@/components/UnitProvider";
import { Button } from "@/components/ui/button";
import { shortId } from "@/lib/ids";
import { makeAPayoutPath } from "@/lib/mode";
import { isLively } from "@/lib/motion";
import { useCoinUnit } from "@/lib/units";
import { formatZec } from "@/lib/zec";

import { RealRun } from "./RealRun";
import { samplePayoutRows } from "./sample";

// The landing page (web/DESIGN.md, "Home"), kept short on purpose: under 400 words in all (REQ-RUN-002, HomePage.test.tsx
// counts them). The headline and the four-views sheet, three points, how a payout is made, the real run, the people being
// paid, and the way to start. Wording claims only what README.md and docs/PRIVACY_BOUNDARY.md do.

const POINTS: readonly { title: string; text: string }[] = [
  { title: "Up to 330 people, one transaction.", text: "Each gets a shielded payment with a note. Nobody else sees who got what." },
  { title: "A receipt anyone can check.", text: "The total and the fee come from the chain, with no key." },
  { title: "Your keys stay with you.", text: "ZecDrop runs on your computer. No account, no wallet to connect." },
];

const STEPS: readonly { title: string; text: string }[] = [
  { title: "Start ZecDrop", text: "One command on your computer. It opens in your browser." },
  { title: "Add people and fund it", text: "Type them in or import a list, then pay its address." },
  { title: "Send and share", text: "One transaction pays everyone. Share the receipt; each person gets a payslip." },
];

const textLink = "inline-flex min-h-11 items-center text-base font-medium underline underline-offset-4";
const h2 = "display text-[1.75rem] sm:text-[2.25rem]";

// The first look plays once a visit: coming back to the page from another one does not draw the bars again.
let introPlayed = false;

/** The count, the total and the fee: the three things that stay readable in every view. Plain ink, nothing behind them (the
 * owner, 2026-10-20: no highlighter on the writing). */
function Summary({ payouts, total, fee }: { payouts: number; total: bigint; fee: bigint | null }) {
  const unit = useCoinUnit();
  return (
    <div className="space-y-2">
      <p className="display flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[1.625rem] sm:text-[2.125rem]" data-testid="lens-summary">
        <span>{payouts === 1 ? "1 payout" : `${String(payouts)} payouts`}</span>
        <span>
          <CountUp zatoshi={total} /> {unit}
        </span>
        {fee !== null && (
          <span className="text-muted-foreground">
            + {formatZec(fee)} {unit} fee
          </span>
        )}
      </p>
      <p className="text-sm text-muted-foreground">These three are public in every view.</p>
    </div>
  );
}

function StartButton() {
  return (
    <Button asChild size="lg">
      <Link to={makeAPayoutPath()}>Make a payout</Link>
    </Button>
  );
}

export default function HomePage() {
  const rows = useMemo(() => samplePayoutRows(), []);
  // The real 8-output batch: the numbers above the list are the receipt's own.
  const real = useMemo(() => demoReceipt("real"), []);
  const [mode, setMode] = useState<LensMode>("public");
  const [selectedId, setSelectedId] = useState<string | null>("person-3");
  // Lively only, and once a visit: the bars are drawn over the sheet while the total counts up.
  const [intro] = useState(() => !introPlayed && isLively());
  useEffect(() => {
    introPlayed = true;
  }, []);

  const payouts = real.batches.reduce((sum, batch) => sum + (batch.shieldedActions ?? 0), 0);
  const total = real.declaredTotal === null ? null : BigInt(real.declaredTotal);
  const fee = real.feeTotal === null ? null : BigInt(real.feeTotal);
  const txid = real.batches[0]?.txid ?? null;

  return (
    <UnitProvider network={real.network}>
      <div className="space-y-20 sm:space-y-28">
        <title>ZecDrop - Pay many people, keep who got what private</title>

        {/* The headline and the sheet, side by side on a wide screen so the first look is seen without a scroll. */}
        <div className="grid items-start gap-x-12 gap-y-12 lg:grid-cols-[minmax(0,1fr)_30rem]">
          <div className="space-y-8 lg:pt-6">
            <h1 className="display text-[clamp(2.75rem,12vw,4.75rem)] leading-[0.92] text-balance [font-stretch:72%] lg:text-[clamp(4rem,6.4vw,5.25rem)]">
              <span className="block">Pay many people.</span> <span className="block">Keep it private.</span>{" "}
              <span className="block">Prove the total.</span>
            </h1>
            <p className="max-w-[40ch] text-xl">
              One Zcash transaction pays everyone on your list. The amounts stay private, and anyone can check the total.
            </p>
            <div className="flex flex-wrap gap-3">
              <StartButton />
              <Button asChild size="lg" variant="outline">
                <Link to={SAMPLE_RECEIPT_HREF}>See a real receipt</Link>
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">On Zcash testnet. Your keys stay on your computer.</p>
          </div>

          {/* The one sheet: a payout list as a document, seen through whichever view is chosen. */}
          <section aria-labelledby="lens-heading" className="slip space-y-6 p-4 sm:p-8">
            <div className="space-y-1">
              <h2 id="lens-heading" className="text-xl leading-tight font-bold tracking-[-0.01em]">
                One payout, four views
              </h2>
              {txid !== null && (
                <p className="text-sm text-muted-foreground">
                  The real testnet batch, transaction <span className="mono whitespace-nowrap">{shortId(txid, 6)}</span>
                </p>
              )}
            </div>
            {total !== null && <Summary payouts={payouts} total={total} fee={fee} />}
            {/* The switch under the list: the buttons beside the sheet come first in the tab order, and focus never goes back up. */}
            <RedactionLens
              rows={rows}
              mode={mode}
              onModeChange={setMode}
              selectedId={selectedId}
              onSelect={setSelectedId}
              intro={intro}
              controls="below"
              views={FOUR_VIEWS}
            />
            <UnitNote />
          </section>
        </div>

        <ul className="grid gap-x-10 gap-y-8 md:grid-cols-3" data-testid="points">
          {POINTS.map((point) => (
            <li key={point.title} className="space-y-2 border-t border-foreground pt-5">
              <h2 className="text-xl leading-snug font-bold tracking-[-0.01em]">{point.title}</h2>
              <p className="max-w-[34ch] text-base text-muted-foreground">{point.text}</p>
            </li>
          ))}
        </ul>

        <section aria-labelledby="steps-heading" className="space-y-8">
          <h2 id="steps-heading" className={h2}>
            How it works
          </h2>
          <ol className="grid gap-x-8 gap-y-8 md:grid-cols-3">
            {STEPS.map((step, index) => (
              <li key={step.title} className="space-y-3">
                <span aria-hidden className="mono flex size-8 items-center justify-center rounded-full bg-primary text-base font-medium text-primary-foreground">
                  {index + 1}
                </span>
                <h3 className="text-xl leading-snug font-bold tracking-[-0.01em]">{step.title}</h3>
                <p className="max-w-[32ch] text-base">{step.text}</p>
                {index === 0 && <p className="mono text-sm">./zecdrop up</p>}
              </li>
            ))}
          </ol>
          <StartButton />
        </section>

        <RealRun />

        <section aria-labelledby="paid-heading" className="space-y-3 border-t border-border pt-10">
          <h2 id="paid-heading" className={h2}>
            Being paid?
          </h2>
          <p className="flex flex-wrap gap-x-6">
            <Link to="/get-paid" className={textLink}>
              Share your address
            </Link>
            <Link to="/payslip" className={textLink}>
              Check a payslip
            </Link>
          </p>
        </section>

        <section aria-labelledby="close-heading" className="slip flex flex-col gap-6 p-6 sm:p-10 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-2">
            <h2 id="close-heading" className={h2}>
              Make your first private payout.
            </h2>
            <p className="text-lg">Your keys and your list stay on your computer.</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-3">
            <StartButton />
            <Button asChild size="lg" variant="outline">
              <Link to="/privacy">How privacy works</Link>
            </Button>
          </div>
        </section>
      </div>
    </UnitProvider>
  );
}
