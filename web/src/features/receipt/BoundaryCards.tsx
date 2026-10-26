import type { ReactNode } from "react";
import { Link } from "react-router";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Wording mirrors docs/PRIVACY_BOUNDARY.md, section "What the public can
// verify, and what only an auditor can", plus its known limits and trust
// assumptions. Change that file first, then this one.
//
// The rule behind it (docs/LEARNINGS.md): every "anyone can verify X" claim
// names what a key-less verifier can actually compute. Chain data can show how
// much value entered the shielded pool and in how many outputs. It cannot show
// that those outputs reached different people, or that they match a payout
// list. So this section never says the money "reached" anyone, and never says
// anything was "verified" beyond those facts. copy.test.tsx bans the phrases.

const CAN_CHECK: readonly ReactNode[] = [
  "How much transparent value left the funding address.",
  "That exactly that amount, minus the fee, entered the shielded pool in each batch transaction. The transaction's binding signature fixes this number, so it cannot be faked.",
  "In how many shielded outputs it went, at what fee, and how much was left as change.",
  "That these add up exactly: funded = change + shielded + fee.",
];

const CANNOT_PROVE: readonly ReactNode[] = [
  "That the shielded value reached different people, or that it matches a payout list. A payment to the operator's own address, an output built without the campaign's outgoing viewing key, or a hidden shielded spend all look identical to the public.",
  <>
    Only an auditor holding the campaign&apos;s viewing key can confirm the count and the sum of
    the outputs against the payout list. See the{" "}
    <Link to="/audit" className="font-medium text-link underline underline-offset-4">
      audit page
    </Link>
    .
  </>,
  "Who was paid, or how much each person got. Those stay hidden, but a batch of one, or of equal amounts, lets anyone work the amounts out.",
  "That the figures are right if the verifier's source of chain data is dishonest. Compare the transaction ids with an independent explorer.",
];

function Bullets({ items }: { items: readonly ReactNode[] }) {
  return (
    <ul className="list-disc space-y-2 pl-5 text-sm">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

/** "What this proves / what it does not": honest in both directions. */
export function BoundaryCards() {
  return (
    <section aria-labelledby="boundary-heading" className="space-y-4">
      <h2 id="boundary-heading" className="text-xl font-semibold tracking-tight">
        What this proves, and what it does not
      </h2>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h3>Anyone can check, from chain data alone</h3>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Bullets items={CAN_CHECK} />
            <p className="text-sm text-muted-foreground">
              This page shows the shielded amount, the fee and the output count for each batch. The
              funding amount and the change are on the chain; use the explorer links.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h3>What this does not prove</h3>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Bullets items={CANNOT_PROVE} />
          </CardContent>
        </Card>
      </div>
      <p className="text-sm text-muted-foreground">
        ZecDrop&apos;s transaction shape has been confirmed on public testnet, and the figures above
        come from the verifier&apos;s reading of chain data (the samples are bundled, not live). It has
        not been independently audited, and mainnet is untested. The full list of what is public,
        what is hidden and who must be trusted is the{" "}
        <Link to="/privacy" className="font-medium text-link underline underline-offset-4">
          privacy boundary
        </Link>
        .
      </p>
    </section>
  );
}
