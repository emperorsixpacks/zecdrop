import type { ReactNode } from "react";

import type { ZecNetwork } from "@/lib/config";
import { CoinUnitContext, coinUnit, unitNote, useCoinUnit } from "@/lib/units";

/** Everything inside shows amounts in the coin of `network` (ZEC or TAZ). */
export function UnitProvider({ network, children }: { network: ZecNetwork; children: ReactNode }) {
  return <CoinUnitContext value={coinUnit(network)}>{children}</CoinUnitContext>;
}

/** A line saying what TAZ is, on testnet pages. Nothing on mainnet. */
export function UnitNote({ className = "text-xs text-muted-foreground" }: { className?: string }) {
  const note = unitNote(useCoinUnit());
  return note === null ? null : <p className={className}>{note}</p>;
}
