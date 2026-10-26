import type { ReactNode } from "react";
import { Link } from "react-router";

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
  "How much transparent value left the funding address. That exactly that amount, minus the fee, entered the shielded pool in each batch transaction. The transaction's binding signature fixes this number, so it cannot be faked.",
  "In how many shielded outputs it went, at what fee, and how much was left as change, and that these add up exactly: funded = change + shielded + fee.",
  "Whether the deposit came out of the shielded pool, which names no payer address, or from transparent funds, whose address is public.",
];

const CANNOT_PROVE: readonly ReactNode[] = [
  <>
    That the shielded value reached different people, or that it matches a payout list. A payment to the operator&apos;s own address,
    an output built without the campaign&apos;s outgoing viewing key, or a hidden shielded spend all look identical to the public.
    Only an auditor holding the campaign&apos;s viewing key can confirm the count and the sum of the outputs against the payout list.
    See the{" "}
    <Link to="/audit" className="font-medium text-link underline underline-offset-4">
      audit page
    </Link>
    .
  </>,
  "Who was paid, how much each person got, or who paid the deposit. Those stay hidden, but a batch of one, or of equal amounts, lets anyone work the amounts out, and a deposit's amount and time are public even when it names no address.",
  "That the figures are right if the verifier's source of chain data is dishonest. Compare the transaction ids with an independent explorer.",
];

function Bullets({ items }: { items: readonly ReactNode[] }) {
  return (
    <ul className="list-disc space-y-2 pl-5 text-base">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

/** "What this proves / what it does not": honest in both directions. It lives in
 * an accordion on the receipt, so the receipt itself stays short. */
export function ProvesAndNot() {
  return (
    <div className="max-w-[64ch] space-y-8">
      <section className="space-y-3">
        <h3 className="text-xl font-bold tracking-tight">Anyone can check, from chain data alone</h3>
        <Bullets items={CAN_CHECK} />
        <p className="text-sm text-muted-foreground">
          This page shows the shielded amount, the fee and the output count for each batch. The funding amount and the change are on
          the chain; use the explorer links.
        </p>
      </section>
      <section className="space-y-3">
        <h3 className="text-xl font-bold tracking-tight">What this does not prove</h3>
        <Bullets items={CANNOT_PROVE} />
      </section>
      <p className="text-sm text-muted-foreground">
        ZecDrop&apos;s transaction shape has been confirmed on public testnet, and the figures above come from the verifier&apos;s reading
        of chain data (the samples are bundled, not live). It has not been independently audited, and mainnet is untested. The full
        list of what is public, what is hidden and who must be trusted is{" "}
        <Link to="/privacy" className="font-medium text-link underline underline-offset-4">
          how privacy works
        </Link>
        .
      </p>
    </div>
  );
}
