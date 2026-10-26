import { useQuery } from "@tanstack/react-query";

import { demoReceipt, type DemoCase } from "@/api/demo";
import { fetchReceipt, ReceiptFetchError } from "@/api/receipt";
import { receiptSearchParams, type ReceiptQuery } from "@/api/receipt-query";
import { isTerminalPhase } from "@/lib/phase";

/** How often to look again while payouts are still moving. */
export const REFRESH_WHILE_ACTIVE_MS = 15_000;

interface UseReceiptArgs {
  /** Serve this bundled sample instead of calling the verifier. */
  demo: DemoCase | null;
  /** The link's claim; null when the link was invalid (nothing is fetched). */
  query: ReceiptQuery | null;
}

export function useReceipt({ demo, query }: UseReceiptArgs) {
  return useQuery({
    queryKey: demo !== null ? ["receipt", "demo", demo] : ["receipt", query ? receiptSearchParams(query).toString() : "none"],
    enabled: demo !== null || query !== null,
    queryFn: ({ signal }) => {
      if (demo !== null) return Promise.resolve(demoReceipt(demo));
      if (!query) throw new Error("no receipt query");
      return fetchReceipt(query, { signal });
    },
    // Only "try again later" failures are worth retrying. A mismatch, a 404 or
    // a malformed answer will not change in two seconds.
    retry: (count, error) =>
      error instanceof ReceiptFetchError && error.kind === "unreachable" && count < 2,
    // Keep looking while the campaign can still change; stop once it cannot.
    refetchInterval: (q) => {
      if (demo !== null) return false;
      const data = q.state.data;
      return data && !isTerminalPhase(data.phase.phase) ? REFRESH_WHILE_ACTIVE_MS : false;
    },
    staleTime: demo !== null ? Number.POSITIVE_INFINITY : 5_000,
  });
}
