import { Link } from "react-router";

import { demoReceipt, REAL_CAPTURES, SAMPLE_RECEIPT_HREF } from "@/api/demo";
import { Button } from "@/components/ui/button";
import { shortId } from "@/lib/ids";
import { useCoinUnit } from "@/lib/units";
import { formatZec } from "@/lib/zec";

import { LIMITS, RUN_DATE, RUN_SETTLE } from "./run-facts";

// The real run, and what one transaction can hold, printed as a till receipt: the way a payment says what happened. Every
// figure was measured: the run's own come from its receipt (fixtures/testnet-ironwood-batch-8) and its capture (REAL_CAPTURES),
// the rest from run-facts.ts, which names its sources.

function Line({ name, value }: { name: string; value: string }) {
  return (
    <div className="leader">
      <dt>{name}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

const rule = "my-4 border-t border-dashed border-input";

/** "It ran on public testnet": three short lines and the receipt. */
export function RealRun() {
  const unit = useCoinUnit();
  const real = demoReceipt("real");
  const payouts = real.batches.reduce((sum, batch) => sum + (batch.shieldedActions ?? 0), 0);
  const txid = real.batches[0]?.txid ?? null;

  return (
    <section aria-labelledby="run-heading" className="grid items-center gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
      <div className="space-y-6">
        <h2 id="run-heading" className="display text-[2.25rem] sm:text-[3rem]">
          It ran on public testnet
        </h2>
        <div className="max-w-[52ch] space-y-2 text-lg">
          <p>Eight payouts in one transaction, settled in about two minutes.</p>
          <p>Its receipt was checked from chain data alone, with no key.</p>
          <p>One transaction can carry up to {LIMITS.mostPayouts} payouts.</p>
        </div>
        <Button asChild size="lg" variant="outline">
          <Link to={SAMPLE_RECEIPT_HREF}>Open the receipt</Link>
        </Button>
      </div>

      <div
        data-testid="run-receipt"
        className="slip receipt-sheet mono w-full max-w-[26rem] px-6 pt-7 pb-12 text-sm sm:px-8 lg:rotate-[1deg] lg:justify-self-end"
      >
        <p className="font-sans text-xl font-bold tracking-[-0.01em]">ZecDrop</p>
        <p className="text-muted-foreground">Public testnet, {RUN_DATE}</p>
        <hr className={rule} />
        <dl className="space-y-1.5">
          <Line name="Payouts" value={String(payouts)} />
          {txid !== null && <Line name="Transaction" value={shortId(txid, 4)} />}
          <Line name="Total" value={`${formatZec(BigInt(real.declaredTotal))} ${unit}`} />
          {real.feeTotal !== null && <Line name="Network fee" value={`${formatZec(BigInt(real.feeTotal))} ${unit}`} />}
          <Line name="Mined at block" value={REAL_CAPTURES.real.minedAt} />
          <Line name="Time to settle" value={RUN_SETTLE} />
        </dl>
        <hr className={rule} />
        <p className="text-muted-foreground">Measured offline, {LIMITS.measured}</p>
        <dl className="mt-1.5 space-y-1.5">
          <Line name="Most in one transaction" value={LIMITS.mostPayouts} />
          <Line name={`Time to prove ${LIMITS.mostPayouts}`} value={LIMITS.prove} />
          <Line name="Time to check it" value={LIMITS.check} />
        </dl>
        <hr className={rule} />
        <p className="text-center">No mainnet payout yet.</p>
      </div>
    </section>
  );
}
