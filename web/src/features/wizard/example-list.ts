// The example list (REQ-RUN-003): the eight testnet addresses of examples/demo-recipients.testnet.csv, which belong to the
// project's own throwaway test wallet, with their amounts and notes. Offered on testnet only, so that anyone can run a whole
// real payout without addresses of their own; on mainnet there is none.

import csv from "../../../../examples/demo-recipients.testnet.csv?raw";

import type { ZecNetwork } from "@/lib/config";

/** The list's file name, as the payout screen shows a list that was read from a file. */
export const EXAMPLE_LIST_NAME = "demo-recipients.testnet.csv";

/** What is said beside the example list's button. */
export const EXAMPLE_LIST_NOTE = "Eight testnet addresses of ZecDrop's own test wallet, ready to send.";

/** The example list, as CSV text, for an operator on `network`: on testnet only. */
export function exampleListFor(network: ZecNetwork | undefined): string | null {
  return network === "testnet" ? csv : null;
}
