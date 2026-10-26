import { Link } from "react-router";

import { SAMPLE_RECEIPT_HREF } from "@/api/demo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Wording follows README.md and docs/PRIVACY_BOUNDARY.md. In particular it
// claims only what a key-less verifier can compute, and it names the limits.

const STEPS = [
  {
    title: "The operator plans the payout",
    body: "Recipients and amounts are loaded on the operator's own machine. Spend keys never leave it, and the hosted verifier holds no keys at all.",
  },
  {
    title: "Each batch is one transaction",
    body: "Public funds go in and shielded outputs come out. The network makes the net value entering the shielded pool public, while every individual output stays encrypted.",
  },
  {
    title: "Anyone can check the totals",
    body: "A receipt shows the totals, fees, batch sizes and transaction ids, from chain data alone. An auditor holding a viewing key can go further and confirm the outputs match the payout list.",
  },
] as const;

export default function HomePage() {
  return (
    <div className="space-y-14">
      <title>ZecDrop - Private amounts, public accountability</title>

      <section className="max-w-3xl space-y-6 pt-2 sm:pt-6">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Confidential batch payouts on Zcash
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          Private amounts. Public accountability.
        </h1>
        <p className="text-lg text-muted-foreground">
          Pay many people from one funded campaign. Anyone can check how much was funded, how
          much entered the shielded pool, in how many outputs, and what it cost. Only each
          recipient, and an auditor holding a viewing key, can see who got what.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button asChild className="h-11 px-5 text-base">
            <Link to={SAMPLE_RECEIPT_HREF}>View a sample receipt</Link>
          </Button>
          <Button asChild variant="outline" className="h-11 px-5 text-base">
            <Link to="/privacy">Read the privacy boundary</Link>
          </Button>
        </div>
      </section>

      <section aria-labelledby="ran-heading" className="max-w-3xl space-y-3">
        <h2 id="ran-heading" className="text-2xl font-semibold tracking-tight">
          It has run on public testnet
        </h2>
        <p className="text-base text-muted-foreground">
          A real 8-recipient batch ran on public testnet, from a funded campaign through the
          operator. Its public receipt shows the batch&apos;s total, its fee, its transaction and how
          many shielded outputs it has. It does not list the recipients or what each one received.
          Testnet coins have no value, and this has not been tried on mainnet.
        </p>
        <p>
          <Link to={SAMPLE_RECEIPT_HREF} className="font-medium text-link underline underline-offset-4">
            See the receipt of that batch
          </Link>
        </p>
      </section>

      <section aria-labelledby="how-heading" className="space-y-4">
        <h2 id="how-heading" className="text-2xl font-semibold tracking-tight">
          How it works
        </h2>
        <ol className="grid gap-4 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title}>
              <Card className="h-full">
                <CardHeader>
                  <CardTitle className="text-base">
                    <h3>
                      <span className="text-muted-foreground">{index + 1}. </span>
                      {step.title}
                    </h3>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{step.body}</p>
                </CardContent>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="limits-heading" className="max-w-3xl space-y-3">
        <h2 id="limits-heading" className="text-2xl font-semibold tracking-tight">
          The honest limits
        </h2>
        <p>
          Amounts stay hidden only when payouts vary: a batch of one reveals that person&apos;s
          amount, and equal payouts make every amount derivable from the public total. The
          operator sees every recipient and amount, and an auditor given a viewing key sees
          everything for that campaign, permanently.
        </p>
        <p className="text-sm text-muted-foreground">
          Status: a prototype under construction. It runs on testnet by default and has not been
          independently audited. The sample receipt is made-up data.{" "}
          <Link to="/privacy" className="font-medium text-link underline underline-offset-4">
            Read the full list of limits
          </Link>
          .
        </p>
      </section>

      <p className="border-t pt-6 text-sm text-muted-foreground">
        Running a campaign?{" "}
        <Link to="/campaigns" className="font-medium text-link underline underline-offset-4">
          Open the operator app
        </Link>
        .
      </p>
    </div>
  );
}
