// Which coin the amounts on a page are in.
//
// Mainnet amounts are ZEC. Testnet coins are TAZ: they cost nothing and are
// worth nothing, so calling them ZEC would suggest real money. Only the LABEL
// differs; the arithmetic is the same zatoshi (1e-8) everywhere.
//
// The unit follows the network of whatever the page is about: the receipt's
// network on the receipt page, the operator's on the operator pages. A
// <UnitProvider> says which; with none, the build's own network applies.

import { createContext, useContext } from "react";

import { config, type ZecNetwork } from "./config";

export type CoinUnit = "ZEC" | "TAZ";

export function coinUnit(network: ZecNetwork): CoinUnit {
  return network === "mainnet" ? "ZEC" : "TAZ";
}

export const CoinUnitContext = createContext<CoinUnit>(coinUnit(config.network));

/** The unit for the page being drawn. */
export function useCoinUnit(): CoinUnit {
  return useContext(CoinUnitContext);
}

/** One sentence saying what TAZ is, or null where there is nothing to explain. */
export function unitNote(unit: CoinUnit): string | null {
  return unit === "TAZ" ? "Amounts are in TAZ, the testnet coin. It has no value." : null;
}
