import type { ReactNode } from "react";

import { Disclosure } from "@/components/Disclosure";
import { PageHeader } from "@/components/PageHeader";

// This page MUST match docs/PRIVACY_BOUNDARY.md. Change that file first, then
// this one. Every sentence about what "anyone" can verify names what a
// key-less verifier can actually compute (docs/LEARNINGS.md).

/** What the boundary document says about how far this has been checked, minus
 * its reference to an internal record. PrivacyPage.test.tsx compares the two. */
export const STATUS_SENTENCE =
  "The transaction shape is confirmed on public testnet. Not yet checked on mainnet, not independently audited.";

type Seen = "visible" | "hidden" | "own";

const WHO: readonly { label: string; sees: readonly [public_: Seen, recipient: Seen, auditor: Seen] }[] = [
  { label: "Who was paid", sees: ["hidden", "own", "visible"] },
  { label: "Each amount", sees: ["hidden", "own", "visible"] },
  { label: "The total", sees: ["visible", "visible", "visible"] },
  { label: "The fee", sees: ["visible", "visible", "visible"] },
  { label: "How many payouts", sees: ["visible", "visible", "visible"] },
];

const COLUMNS = ["Public", "A recipient", "An auditor"] as const;

const SEEN_TEXT: Record<Seen, string> = { visible: "Visible", hidden: "Hidden", own: "Their own" };

/** The icon says the same thing as the word beside it; the word is what is read aloud. */
function SeenIcon({ seen }: { seen: Seen }) {
  if (seen === "visible") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="size-6 text-verified" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M7.5 12.5l3 3 6-7" />
      </svg>
    );
  }
  if (seen === "hidden") return <span aria-hidden className="redacted block h-4 w-9" />;
  return (
    <span aria-hidden className="flex h-4 w-9 overflow-hidden rounded-sm">
      <span className="w-1/2 bg-primary" />
      <span className="redacted block w-1/2 rounded-none" />
    </span>
  );
}

function Matrix() {
  return (
    <section aria-labelledby="matrix-heading" className="space-y-4">
      <h2 id="matrix-heading" className="text-[1.75rem] leading-tight font-bold tracking-[-0.02em]">
        Who can see what
      </h2>
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Who can see what: the public, a recipient and an auditor</caption>
        <thead>
          <tr className="border-b-2 border-foreground">
            <td />
            {COLUMNS.map((column) => (
              <th key={column} scope="col" className="px-2 py-3 text-sm font-bold sm:px-4 sm:text-base">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WHO.map((row) => (
            <tr key={row.label} className="border-b border-border">
              <th scope="row" className="py-4 pr-2 text-base font-bold sm:pr-4 sm:text-lg">
                {row.label}
              </th>
              {row.sees.map((seen, index) => (
                <td key={COLUMNS[index]} className="px-2 py-4 sm:px-4">
                  <div className="flex flex-col items-start gap-1 text-sm sm:flex-row sm:items-center sm:gap-3 sm:text-base">
                    <SeenIcon seen={seen} />
                    <span>{SEEN_TEXT[seen]}</span>
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// The five that matter most, in one short sentence each. The rest are behind the click.
const KEY_LIMITS: readonly string[] = [
  "Amounts can be worked out: a batch of one, or of equal amounts, shows every amount.",
  "Funding is public, so it can be linked to the campaign.",
  "The fee and the output count show how big each batch is.",
  "An auditor's viewing key shows everything in that campaign, for good.",
  "The operator sees every address, amount and memo.",
];

const ALL_LIMITS: readonly string[] = [
  "Amounts can be derived. A batch of one reveals that recipient's exact amount, and a batch of equal amounts reveals every amount. Amount privacy comes from variation.",
  "In a two-recipient batch each party can infer the other's amount from the public total and their own.",
  "With few recipients the public total bounds every amount tightly.",
  "Funding is linkable: the funder's transparent address and amount are public.",
  "Fee and action count fingerprint the batch size.",
  "The hosted verifier holds no keys, but it learns which receipts are viewed.",
  "An auditor given a viewing key sees every output of that campaign, including addresses, amounts and memos, permanently. There is no revocation.",
  "The operator sees every recipient, amount and memo, and holds the spend key.",
];

const TRUST: readonly string[] = [
  "The operator's machine is not compromised.",
  "The chain data source is honest. A lying node can fake a receipt.",
  "The Zcash protocol and the librustzcash implementation are sound. This project has had no independent audit.",
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

export default function PrivacyPage() {
  return (
    <>
      <PageHeader title="How privacy works" emphasis="privacy" description="Who can see what, and what to keep in mind." />
      <div className="space-y-14">
        <Matrix />

        <p className="max-w-[64ch] text-base" data-testid="status-sentence">
          <strong>Status:</strong> {STATUS_SENTENCE}
        </p>

        <section aria-labelledby="limits-heading" className="space-y-4">
          <h2 id="limits-heading" className="text-[1.75rem] leading-tight font-bold tracking-[-0.02em]">
            Known limits
          </h2>
          <ul className="max-w-[64ch] divide-y divide-border border-y border-border">
            {KEY_LIMITS.map((limit) => (
              <li key={limit} className="py-3 text-base">
                {limit}
              </li>
            ))}
          </ul>
        </section>

        <div className="border-b border-border">
          <Disclosure summary="Every known limit, and who must be trusted">
            <div className="max-w-[64ch] space-y-6">
              <section className="space-y-3">
                <h3 className="text-xl font-bold tracking-tight">All known limits</h3>
                <Bullets items={ALL_LIMITS} />
              </section>
              <section className="space-y-3">
                <h3 className="text-xl font-bold tracking-tight">Who must be trusted</h3>
                <Bullets items={TRUST} />
              </section>
            </div>
          </Disclosure>
          <Disclosure summary="What anyone can check, and what only an auditor can">
            <div className="max-w-[64ch] space-y-3 text-base">
              <p>
                <strong>Anyone, from chain data alone:</strong> how much transparent value left the funding address, that exactly that
                amount minus the fee entered the shielded pool in the transaction (the binding signature makes the number
                unforgeable), how many shielded outputs there are, the fee, and the change. These add up exactly: funded = change +
                shielded + fee.
              </p>
              <p>
                <strong>Not the public:</strong> that the shielded value reached distinct third parties matching a payout list. A
                payout to the operator&apos;s own address, an output built without the campaign&apos;s outgoing viewing key, or a
                hidden shielded spend all look identical to the public. The public cannot tell a dummy spend from a real one.
              </p>
              <p>
                <strong>The auditor closes that gap.</strong> With the campaign viewing key they recover every output and check that
                the count equals the public action count and that the sum equals the public net value. Any mismatch means a hidden
                spend, a hidden output or an unrecoverable output.
              </p>
            </div>
          </Disclosure>
        </div>
      </div>
    </>
  );
}
