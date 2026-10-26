import { CountUp } from "@/components/CountUp";
import { useCoinUnit } from "@/lib/units";
import { formatZec } from "@/lib/zec";

interface PayoutSummaryProps {
  people: number;
  /** Zatoshi. */
  total: bigint;
  /** Zatoshi. */
  fee: bigint;
  className?: string;
}

/** The three figures that matter, in one line of big type: how many people, the
 * total, and the network fee. The total counts up once when it first appears. */
export function PayoutSummary({ people, total, fee, className }: PayoutSummaryProps) {
  const unit = useCoinUnit();
  return (
    <p
      className={`display flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[1.75rem] sm:text-[2.75rem] ${className ?? ""}`}
      data-testid="payout-summary"
    >
      <span>{people === 1 ? "1 person" : `${String(people)} people`}</span>
      <span>
        <CountUp zatoshi={total} /> {unit}
      </span>
      <span className="text-muted-foreground">
        + {formatZec(fee)} {unit} fee
      </span>
    </p>
  );
}
