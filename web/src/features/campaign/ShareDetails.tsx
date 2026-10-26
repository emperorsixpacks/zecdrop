import { Link } from "react-router";

import { FailureNotice } from "@/features/operator/FailureNotice";
import type { OperatorCampaign } from "@/api/operator/schemas";
import { usePractice } from "@/lib/practice-mode";

import { useReceiptShare } from "./useReceiptShare";

/** What a receipt link tells whoever opens it. Mirrors docs/PRIVACY_BOUNDARY.md. */
const REVEALS: readonly string[] = [
  "The network, the transaction id of every batch, the declared total and the manifest commitment.",
  "Through those, what anyone can read from the chain: each batch's fee, the number of shielded actions (about the recipient count) and the funding input.",
  "That someone looked: the verifier that answers the link learns which receipt was viewed.",
];

const HIDDEN: readonly string[] = [
  "Recipient addresses, per-recipient amounts and memos are not in the link and cannot be derived from it.",
  "A batch of one, or a batch of equal amounts, lets the amounts be worked out from the public total; the review step warns about these.",
  "The funding address and amount are public and can be linked to you.",
];

/** The receipt link itself, and what it shows and does not: the content of the
 * "Share the receipt" section. The buttons that open and copy it are in the done panel. */
export function ShareDetails({ campaign }: { campaign: OperatorCampaign }) {
  const { everyBatchBuilt, receipt, link, shown } = useReceiptShare(campaign);
  const practice = usePractice((state) => state.on);

  return (
    <div className="max-w-[64ch] space-y-5">
      {!everyBatchBuilt ? (
        <p className="text-base text-muted-foreground">
          The receipt link is available once every batch has been built, because the public page needs all the transactions to add
          up the total. Until then there is nothing to share.
        </p>
      ) : receipt.isPending ? (
        <p role="status" className="text-base text-muted-foreground">
          Getting the receipt…
        </p>
      ) : receipt.isError ? (
        <FailureNotice error={receipt.error} onRetry={() => void receipt.refetch()} retrying={receipt.isFetching} />
      ) : shown !== null && link?.ok ? (
        <div className="space-y-3">
          <p className="text-base text-muted-foreground">
            Anyone with this link can check {link.txCount === 1 ? "the transaction" : `all ${String(link.txCount)} transactions`} on
            the public page. Batches that are still confirming show as pending there.
          </p>
          <p className="mono text-xs break-all" data-testid="receipt-link">
            {shown.text}
          </p>
          {!shown.complete && practice && (
            <p className="text-sm text-muted-foreground">
              This is a practice receipt: it exists only in this tab, so its link opens here while practice mode is on and nowhere else.
            </p>
          )}
          {!shown.complete && !practice && (
            <p className="text-sm text-muted-foreground">
              This is the path only: put the address of the public verifier in front of it. To have the full link shown here, build
              the page with the verifier&apos;s address set (see the README).
            </p>
          )}
        </div>
      ) : (
        <p className="text-base text-muted-foreground">No link can be made yet.</p>
      )}

      <div className="space-y-2 border-t border-border pt-4 text-sm">
        <h3 className="text-base font-bold">What the link shows</h3>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          {REVEALS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <h3 className="pt-2 text-base font-bold">What it does not show, and the limits</h3>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          {HIDDEN.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <Link to="/privacy" className="inline-flex min-h-11 items-center font-medium text-foreground underline underline-offset-4">
          How privacy works
        </Link>
      </div>
    </div>
  );
}
