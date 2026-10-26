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
      <p className="display flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[1.75rem] sm:text-[2.75rem]" data-testid="lens-summary">
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
      <div className="space-y-14">
        <title>ZecDrop - Pay many people, keep who got what private</title>

        <section className="space-y-6">
          <h1 className="display max-w-[22ch] text-[2.25rem] leading-[1.04] text-balance sm:text-[3.5rem]">
            <span className="block">Pay many people.</span> <span className="block">
              Keep who got what <span className="gradient-text">private</span>.
            </span>{" "}
            <span className="block">Prove the total.</span>
          </h1>
          <p className="max-w-[64ch] text-xl">A real 8-person payout ran on public testnet. Not tried on mainnet.</p>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link to={SAMPLE_RECEIPT_HREF}>See a real receipt</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/privacy">How privacy works</Link>
            </Button>
          </div>
        </section>

        <section aria-labelledby="lens-heading" className="space-y-6">
          <h2 id="lens-heading" className="text-[1.75rem] leading-tight font-bold tracking-[-0.02em]">
            Same payout, three views
          </h2>
          {total !== null && <Summary payouts={payouts} total={total} fee={fee} />}
          <RedactionLens rows={rows} mode={mode} onModeChange={setMode} selectedId={selectedId} onSelect={setSelectedId} />
          <UnitNote />
        </section>

        <ul className="divide-y divide-border border-y border-border">
          {LINES.map((line) => (
            <li key={line.lead} className="grid gap-x-6 gap-y-1 py-4 sm:grid-cols-[9rem_1fr]">
              <span className="text-base font-bold">{line.lead}</span>
              <span className="max-w-[64ch] text-base">{line.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </UnitProvider>
  );
}
