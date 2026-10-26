import { useCoinUnit } from "@/lib/units";
import { zecFromZatoshi } from "@/lib/zec";

/** An amount from the wire, in the coin of the page's network (ZEC on mainnet,
 * TAZ on testnet; see lib/units.ts). The exact zatoshi value is in the tooltip,
 * so nothing is rounded away. A `null` means the verifier could not establish
 * it, which is shown as such rather than as zero. */
export function Zec({ zatoshi }: { zatoshi: string | null }) {
  const unit = useCoinUnit();
  if (zatoshi === null) return <Unknown />;
  return (
    <span className="tabular-nums" title={`${zatoshi} zatoshi`}>
      {zecFromZatoshi(zatoshi)} {unit}
    </span>
  );
}

/** A fact the verifier could not establish. Never styled like a value. */
export function Unknown() {
  return (
    <span className="text-muted-foreground" title="The verifier could not establish this">
      Unknown
    </span>
  );
}
