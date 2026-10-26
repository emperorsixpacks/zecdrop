import { useMemo, useState } from "react";
import { Link } from "react-router";

import { demoReceipt, SAMPLE_RECEIPT_HREF } from "@/api/demo";
import { CountUp } from "@/components/CountUp";
import { RedactionLens, type LensMode } from "@/components/lens/Lens";
import { UnitNote, UnitProvider } from "@/components/UnitProvider";
import { Button } from "@/components/ui/button";
import { useCoinUnit } from "@/lib/units";
import { formatZec } from "@/lib/zec";

import { samplePayoutRows } from "./sample";

// Wording follows README.md and docs/PRIVACY_BOUNDARY.md. It claims only what a
// key-less verifier can compute, and the status line names the limit: a real run
// on public testnet, nothing on mainnet.

// The steps to a payout, in order. The first one says why there is no wallet to connect: the keys
// live in the operator on the person's own computer (docs/ADR/0002), never on this site.
const STEPS: readonly { title: string; text: string }[] = [
  { title: "Start the operator", text: "It runs on your own computer and holds the keys." },
  { title: "Add your payout list", text: "Drop in a CSV of addresses and amounts, then check it." },
  { title: "Fund the address", text: "Send coins to the address it shows. Open in wallet fills in the amount." },
  { title: "Send and share", text: "One transaction sends all the payouts. Share the receipt link so anyone can check the total." },
];

const LINES: readonly { lead: string; text: string }[] = [
  { lead: "Public", text: "The total, the fee and how many payouts." },
  { lead: "Hidden", text: "Who got paid, and how much each person got." },
  { lead: "Checkable", text: "Anyone can recompute the total from the chain." },
];

/** The count, the total and the fee: the three things that stay readable in every view. */
function Summary({ payouts, total, fee }: { payouts: number; total: bigint; fee: bigint | null }) {
  const unit = useCoinUnit();
  return (
    <div className="space-y-1">
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

export default function HomePage() {
  const rows = useMemo(() => samplePayoutRows(), []);
  // The real 8-output batch: the numbers above the list are the receipt's own.
  const real = useMemo(() => demoReceipt("real"), []);
  const [mode, setMode] = useState<LensMode>("public");
  const [selectedId, setSelectedId] = useState<string | null>("person-3");

  const payouts = real.batches.reduce((sum, batch) => sum + (batch.shieldedActions ?? 0), 0);
  const total = real.declaredTotal === null ? null : BigInt(real.declaredTotal);
  const fee = real.feeTotal === null ? null : BigInt(real.feeTotal);

  return (
    <UnitProvider network={real.network}>
      <div className="space-y-12 sm:space-y-16">
        <title>ZecDrop - Pay many people, keep who got what private</title>

        {/* The headline, large and heavy, on the desk. The page's one big gesture is the sheet below it. */}
        <h1 className="display text-[clamp(2.5rem,8vw,5rem)] leading-[0.98] text-balance">
          <span className="block">Pay many people.</span> <span className="block">Keep who got what private.</span>{" "}
          <span className="block">Prove the total.</span>
        </h1>

        <div className="grid gap-x-14 gap-y-12 lg:grid-rows-[auto_1fr] lg:grid-cols-[minmax(0,6fr)_minmax(0,7fr)]">
          <div className="space-y-6 lg:col-start-1 lg:row-start-1">
            <p className="max-w-[40ch] text-xl">A real 8-person payout ran on public testnet. Not tried on mainnet.</p>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link to={SAMPLE_RECEIPT_HREF}>See a real receipt</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/privacy">How privacy works</Link>
              </Button>
            </div>
          </div>

          {/* The one sheet: a payout list as a document, seen through whichever lens is chosen. */}
          <section
            aria-labelledby="lens-heading"
            className="space-y-6 rounded-md border border-border bg-card p-4 sm:p-8 lg:col-start-2 lg:row-span-2 lg:row-start-1"
          >
            <h2 id="lens-heading" className="text-xl leading-tight font-bold tracking-[-0.01em]">
              Same payout, three views
            </h2>
            {total !== null && <Summary payouts={payouts} total={total} fee={fee} />}
            <RedactionLens rows={rows} mode={mode} onModeChange={setMode} selectedId={selectedId} onSelect={setSelectedId} />
            <UnitNote />
          </section>

          <ul className="divide-y divide-border border-y border-border lg:col-start-1 lg:row-start-2 lg:self-start">
            {LINES.map((line) => (
              <li key={line.lead} className="grid gap-x-6 gap-y-1 py-4 sm:grid-cols-[7rem_1fr]">
                <span className="text-base font-bold">{line.lead}</span>
                <span className="max-w-[64ch] text-base">{line.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <section aria-labelledby="steps-heading" className="space-y-6 border-t border-border pt-10">
          <div className="space-y-2">
            <h2 id="steps-heading" className="display text-[1.75rem] sm:text-[2.25rem]">
              How to run a payout
            </h2>
            <p className="max-w-[48ch] text-lg">There is no wallet to connect: the operator on your own computer holds the keys.</p>
          </div>
          <ol className="grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, index) => (
              <li key={step.title} className="space-y-3">
                <span aria-hidden className="mono flex size-8 items-center justify-center rounded-[4px] bg-primary text-base font-medium text-primary-foreground">
                  {index + 1}
                </span>
                <h3 className="text-xl leading-snug font-bold tracking-[-0.01em]">{step.title}</h3>
                <p className="max-w-[32ch] text-base">{step.text}</p>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </UnitProvider>
  );
}
