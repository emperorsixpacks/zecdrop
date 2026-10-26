import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import { demoReceipt, SAMPLE_RECEIPT_HREF } from "@/api/demo";
import { CountUp } from "@/components/CountUp";
import { RedactionLens, type LensMode } from "@/components/lens/Lens";
import { FOUR_VIEWS } from "@/components/lens/views";
import { UnitNote, UnitProvider } from "@/components/UnitProvider";
import { Button } from "@/components/ui/button";
import type { Audience } from "@/lib/audience";
import { shortId } from "@/lib/ids";
import { isLively } from "@/lib/motion";
import { useCoinUnit } from "@/lib/units";
import { cn } from "@/lib/utils";
import { formatZec } from "@/lib/zec";

import { PracticeStart } from "./PracticeStart";
import { RealRun } from "./RealRun";
import { samplePayoutRows } from "./sample";
import { Tour } from "./Tour";

// Wording follows README.md and docs/PRIVACY_BOUNDARY.md. It claims only what a
// key-less verifier can compute, and the status line names the limit: a real run
// on public testnet, nothing on mainnet.
//
// The page is the landing page (web/DESIGN.md, "Home"), built on one idea: one payout, four views. The headline and the
// sheet (the same list as everyone, one person, an auditor and the payer see it), then a band in the bar's colours saying how
// each view is opened, how it compares with a public list and a private wallet, the real run, who it is for (personal and
// organisation, each a way into practice mode in its own view), the steps, what a recipient can do, the tour, and an
// invitation to try it.

// The steps to a payout, in order. The first one says why there is no wallet to connect: the keys
// live in the operator on the person's own computer (docs/ADR/0002), never on this site.
const STEPS: readonly { title: string; text: string }[] = [
  { title: "Start the operator", text: "It runs on your own computer and holds the keys." },
  { title: "Add your payout list", text: "Type in who you're paying, or import a list. Then check it." },
  { title: "Fund the address", text: "Pay the address it shows from your shielded balance. Open in wallet fills in the amount." },
  { title: "Send and share", text: "One transaction sends all the payouts. Share the receipt link so anyone can check the total." },
];

// The two kinds of payer (lib/audience.ts). Each door opens a practice payout in its own view.
const DOORS: readonly { audience: Audience; title: string; lead: string; uses: readonly string[]; how: string; action: string }[] = [
  {
    audience: "personal",
    title: "Personal",
    lead: "For family, friends and the people around you.",
    uses: ["Money home to family", "Holiday and wedding gifts", "A shared pot or a tip jar"],
    how: "Type people in, and split a total evenly or at random.",
    action: "Try a personal payout",
  },
  {
    audience: "organisation",
    title: "Organisation",
    lead: "For a team, a grant programme or a community.",
    uses: ["Payroll and contributors", "Grants and bounties", "Airdrops and rewards"],
    how: "Import a spreadsheet. Members get a receipt, an auditor a key.",
    action: "Try an organisation payout",
  },
];

// Who sees what, and how each view is opened (docs/PRIVACY_BOUNDARY.md): the same four as the switch on the sheet.
const VIEWS: readonly { who: string; sees: string; how: string }[] = [
  {
    who: "Everyone",
    sees: "The total, the fee, how many were paid, and whether the deposit came out of the shielded pool.",
    how: "From the receipt link, with no key.",
  },
  { who: "One person", sees: "Their own payout, and nobody else's.", how: "From their payslip, which proves it to anyone." },
  {
    who: "An auditor",
    sees: "The whole list of this payout, checked against the public total.",
    how: "With this payout's viewing key, and nothing from your other payouts.",
  },
  { who: "You", sees: "Every address, amount and note.", how: "On your own computer, where the keys stay." },
];

// Two ways to pay many people today, and ZecDrop. Each answer is what that way gives by itself, in plain words.
const OPTIONS: readonly { key: "list" | "wallet" | "drop"; name: string; what: string }[] = [
  { key: "list", name: "A public list", what: "An airdrop on a public chain" },
  { key: "wallet", name: "A private wallet", what: "Paying from a shielded wallet" },
  { key: "drop", name: "ZecDrop", what: "One payout, four views" },
];

const COMPARE: readonly { question: string; list: string; wallet: string; drop: string }[] = [
  { question: "Anyone can check the total", list: "Yes", wallet: "No, the amounts are hidden", drop: "Yes, from the chain" },
  { question: "Who got what stays private", list: "No, it is all public", wallet: "Yes", drop: "Yes" },
  {
    question: "One person can prove their own payout",
    list: "Only as part of the public list",
    wallet: "Not built in",
    drop: "Yes, with a payslip",
  },
  {
    question: "An auditor can check the list",
    list: "Yes, like everyone",
    wallet: "Only with a key to the whole wallet",
    drop: "Yes, with a key to that payout only",
  },
  { question: "The payer's address stays off the chain", list: "No", wallet: "Yes", drop: "Yes, if you pay from a shielded balance" },
];

// What a person being paid can do, each on its own page.
const FOR_RECIPIENTS: readonly { title: string; text: string; to: string; action: string }[] = [
  { title: "Share an address from a phone", text: "Check its shape, then send it to the payer. Nothing is stored.", to: "/get-paid", action: "Get ready to be paid" },
  { title: "Prove one payout with a payslip", text: "A payslip proves one payout, and says nothing about the others.", to: "/payslip", action: "Check a payslip" },
];

const textLink = "inline-flex min-h-11 items-center text-base font-medium underline underline-offset-4";

// The first look plays once a visit: coming back to the page from another one does not draw the bars again.
let introPlayed = false;

/** The count, the total and the fee: the three things that stay readable in every view. Plain ink, nothing behind them (the
 * owner, 2026-10-20: no highlighter on the writing). */
function Summary({ payouts, total, fee }: { payouts: number; total: bigint; fee: bigint | null }) {
  const unit = useCoinUnit();
  return (
    <div className="space-y-2">
      <p className="display flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[1.625rem] sm:text-[2.125rem]" data-testid="lens-summary">
        <span>{payouts === 1 ? "1 payout" : `${String(payouts)} payouts`}</span>
        <span>
          <CountUp zatoshi={total} /> {unit}
        </span>
        {fee !== null && (
          <span className="text-muted-foreground">
            + {formatZec(fee)} {unit} fee
          </span>
        )}
      </p>
      <p className="text-sm text-muted-foreground">These three are public in every view.</p>
    </div>
  );
}

export default function HomePage() {
  const rows = useMemo(() => samplePayoutRows(), []);
  // The real 8-output batch: the numbers above the list are the receipt's own.
  const real = useMemo(() => demoReceipt("real"), []);
  const [mode, setMode] = useState<LensMode>("public");
  const [selectedId, setSelectedId] = useState<string | null>("person-3");
  // Lively only, and once a visit: the bars are drawn over the sheet while the total counts up.
  const [intro] = useState(() => !introPlayed && isLively());
  useEffect(() => {
    introPlayed = true;
  }, []);

  const payouts = real.batches.reduce((sum, batch) => sum + (batch.shieldedActions ?? 0), 0);
  const total = real.declaredTotal === null ? null : BigInt(real.declaredTotal);
  const fee = real.feeTotal === null ? null : BigInt(real.feeTotal);
  const txid = real.batches[0]?.txid ?? null;

  return (
    <UnitProvider network={real.network}>
      <div className="space-y-20 sm:space-y-28">
        <title>ZecDrop - Pay many people, keep who got what private</title>

        {/* The headline and the sheet, side by side on a wide screen so the first look is seen without a scroll. */}
        {/* The sheet's column is fixed at the width where a revealed address still fits on its line. */}
        <div className="grid items-start gap-x-12 gap-y-12 lg:grid-cols-[minmax(0,1fr)_30rem]">
          <div className="space-y-8 lg:pt-6">
            <h1 className="display text-[clamp(2.75rem,12vw,4.75rem)] leading-[0.92] text-balance [font-stretch:72%] lg:text-[clamp(4rem,6.4vw,5.25rem)]">
              <span className="block">Pay many people.</span> <span className="block">Keep who got what private.</span>{" "}
              <span className="block">Prove the total.</span>
            </h1>
            {/* The three promises, one line each, under the three lines of the headline. */}
            <div className="max-w-[36ch] space-y-1 text-xl">
              <p>Anyone can check the total.</p>
              <p>Each person can prove their own payout.</p>
              <p>Only the auditor you choose sees the list.</p>
            </div>
            <div className="space-y-3">
              <div className="flex flex-wrap gap-3">
                <Button asChild size="lg">
                  <Link to={SAMPLE_RECEIPT_HREF}>See a real receipt</Link>
                </Button>
                <PracticeStart label="Try a practice payout" />
              </div>
              <p className="flex flex-wrap gap-x-6">
                <Link to="/privacy" className={textLink}>
                  How privacy works
                </Link>
                <Link to="/get-paid" className={textLink}>
                  Being paid? Start here
                </Link>
              </p>
            </div>
            {/* What has and has not been done, said once on the first screen: honest, and not the lead. */}
            <p className="text-sm text-muted-foreground">A real 8-person payout ran on public testnet. Not tried on mainnet.</p>
          </div>

          {/* The one sheet: a payout list as a document, seen through whichever lens is chosen. */}
          <section aria-labelledby="lens-heading" className="slip space-y-6 p-4 sm:p-8">
            <div className="space-y-1">
              <h2 id="lens-heading" className="text-xl leading-tight font-bold tracking-[-0.01em]">
                One payout, four views
              </h2>
              {txid !== null && (
                <p className="text-sm text-muted-foreground">
                  The real testnet batch, transaction <span className="mono whitespace-nowrap">{shortId(txid, 6)}</span>
                </p>
              )}
            </div>
            {total !== null && <Summary payouts={payouts} total={total} fee={fee} />}
            {/* The switch under the list: the buttons beside the sheet come first in the tab order, and focus never goes back up. */}
            <RedactionLens
              rows={rows}
              mode={mode}
              onModeChange={setMode}
              selectedId={selectedId}
              onSelect={setSelectedId}
              intro={intro}
              controls="below"
              views={FOUR_VIEWS}
            />
            <UnitNote />
          </section>
        </div>

        {/* Who sees what, across the screen in the redaction bar's colours: how each of the four views is opened. */}
        <section aria-labelledby="views-heading" className="band py-14 sm:py-20">
          <div className="space-y-2">
            <h2 id="views-heading" className="text-xl leading-tight font-bold tracking-[-0.01em]">
              Who sees what
            </h2>
            <p className="max-w-[52ch] text-lg">One transaction pays everyone. What each person sees depends on what they hold.</p>
          </div>
          <ul className="mt-10 grid gap-x-10 gap-y-10 md:grid-cols-2 lg:grid-cols-4" data-testid="four-views">
            {VIEWS.map((view) => (
              <li key={view.who} className="space-y-3 border-t border-island-muted/50 pt-5">
                <span className="display block text-[2.5rem] leading-none [font-stretch:72%] lg:text-[2.75rem]">{view.who}</span>
                <span className="block max-w-[30ch] text-lg">{view.sees}</span>
                <span className="block max-w-[30ch] text-base text-island-muted">{view.how}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* How it compares: a table from md up, one question at a time on a phone (nothing wider than the screen). */}
        <section aria-labelledby="compare-heading" className="space-y-8">
          <div className="space-y-2">
            <h2 id="compare-heading" className="display text-[1.75rem] sm:text-[2.25rem]">
              How it compares
            </h2>
            <p className="max-w-[48ch] text-lg">Two ways to pay many people today, and ZecDrop.</p>
          </div>
          <div className="slip hidden overflow-hidden md:block">
            <table className="w-full text-left text-base" data-testid="compare-table">
              <caption className="sr-only">ZecDrop compared with a public payout list and a private wallet</caption>
              <thead>
                <tr className="border-b border-border">
                  <td className="w-[28%] p-5" />
                  {OPTIONS.map((option) => (
                    <th key={option.key} scope="col" className={cn("p-5 align-bottom", option.key === "drop" && "border-l border-foreground")}>
                      <span className="block text-xl leading-tight font-bold tracking-[-0.01em]">{option.name}</span>
                      <span className="block text-sm font-normal text-muted-foreground">{option.what}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {COMPARE.map((row) => (
                  <tr key={row.question}>
                    <th scope="row" className="p-5 font-semibold">
                      {row.question}
                    </th>
                    <td className="p-5">{row.list}</td>
                    <td className="p-5">{row.wallet}</td>
                    <td className="border-l border-foreground p-5 font-semibold">{row.drop}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-4 md:hidden" data-testid="compare-list">
            {COMPARE.map((row) => (
              <li key={row.question} className="slip space-y-3 p-5">
                <h3 className="text-lg leading-snug font-bold">{row.question}</h3>
                <dl className="space-y-2 text-base">
                  {OPTIONS.map((option) => (
                    <div key={option.key} className={cn("grid grid-cols-[8.5rem_1fr] gap-x-3", option.key === "drop" && "font-semibold")}>
                      <dt className="text-muted-foreground">{option.name}</dt>
                      <dd>{row[option.key]}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </section>

        <RealRun />

        {/* Who it is for: two doors into the same app, each opening a practice payout in its own view. */}
        <section aria-labelledby="who-heading" className="space-y-8">
          <div className="space-y-2">
            <h2 id="who-heading" className="display text-[1.75rem] sm:text-[2.25rem]">
              Who it&apos;s for
            </h2>
            <p className="max-w-[48ch] text-lg">One app, two ways in. The same privacy and the same proof.</p>
          </div>
          <ul className="grid gap-6 md:grid-cols-2">
            {DOORS.map((door) => (
              <li key={door.audience} className="slip flex flex-col gap-6 p-6 sm:p-8" data-testid={`door-${door.audience}`}>
                <div className="space-y-2">
                  <h3 className="display text-[2rem] sm:text-[2.5rem]">{door.title}</h3>
                  <p className="text-lg">{door.lead}</p>
                </div>
                <ul className="divide-y divide-border border-y border-border">
                  {door.uses.map((use) => (
                    <li key={use} className="py-2.5 text-base font-medium">
                      {use}
                    </li>
                  ))}
                </ul>
                <p className="text-base text-muted-foreground">{door.how}</p>
                <div className="mt-auto flex flex-wrap gap-3">
                  <PracticeStart label={door.action} audience={door.audience} />
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="steps-heading" className="space-y-6 border-t border-border pt-10">
          <div className="space-y-2">
            <h2 id="steps-heading" className="display text-[1.75rem] sm:text-[2.25rem]">
              How to run a payout
            </h2>
            <p className="max-w-[48ch] text-lg">There is no wallet to connect: the operator on your own computer holds the keys.</p>
          </div>
          <ol className="grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, index) => (
              <li key={step.title} className="space-y-3">
                <span aria-hidden className="mono flex size-8 items-center justify-center rounded-full bg-primary text-base font-medium text-primary-foreground">
                  {index + 1}
                </span>
                <h3 className="text-xl leading-snug font-bold tracking-[-0.01em]">{step.title}</h3>
                <p className="max-w-[32ch] text-base">{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="paid-heading" className="space-y-8 border-t border-border pt-10">
          <h2 id="paid-heading" className="display text-[1.75rem] sm:text-[2.25rem]">
            For the people you pay
          </h2>
          <ul className="grid gap-x-12 gap-y-8 md:grid-cols-2">
            {FOR_RECIPIENTS.map((item) => (
              <li key={item.to} className="space-y-2">
                <h3 className="text-xl leading-snug font-bold tracking-[-0.01em]">{item.title}</h3>
                <p className="max-w-[40ch] text-base">{item.text}</p>
                <Link to={item.to} className={textLink}>
                  {item.action}
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <Tour />

        <section
          aria-labelledby="practice-heading"
          className="slip flex flex-col gap-6 p-6 sm:p-10 lg:flex-row lg:items-center lg:justify-between lg:gap-12"
        >
          <div className="space-y-4">
            <h2 id="practice-heading" className="display text-[1.75rem] sm:text-[2.25rem]">
              Try it yourself
            </h2>
            <div className="max-w-[48ch] space-y-1 text-lg">
              <p>Run a whole payout in this page, with no install, no wallet and no money.</p>
              <p>It is a simulation in your browser, and every screen says so.</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-3">
            <PracticeStart label="Try it yourself in practice mode" />
          </div>
        </section>
      </div>
    </UnitProvider>
  );
}
