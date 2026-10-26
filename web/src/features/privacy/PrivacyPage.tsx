import { PageHeader } from "@/components/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// This page MUST match docs/PRIVACY_BOUNDARY.md. Change that file first, then
// this one. Every sentence about what "anyone" can verify names what a
// key-less verifier can actually compute (docs/LEARNINGS.md).

const SECTIONS: { title: string; items: readonly string[] }[] = [
  {
    title: "Public",
    items: [
      "The campaign funding address, the funding amount and the funder's inputs.",
      "Per batch: the net value entering the shielded pool, the fee, the transaction id and its timing.",
      "The shielded action count per batch. For a batch of two or more it equals the recipient count.",
      "Transparent change outputs.",
      "A salted commitment to the payout manifest.",
    ],
  },
  {
    title: "Hidden from the public",
    items: [
      "Recipient addresses.",
      "Per-recipient amounts.",
      "Memos.",
      "Which output belongs to whom.",
    ],
  },
];

const LIMITS: readonly string[] = [
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

function Bullets({ items }: { items: readonly string[] }) {
  return (
    <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export default function PrivacyPage() {
  return (
    <>
      <PageHeader
        kicker="Privacy boundary"
        title="What is public, what is private"
        description="ZecDrop hides recipient addresses and per-recipient amounts. Totals, fees and batch transactions are public so anyone can check them."
      />
      <div className="space-y-6">
        <Alert variant="info">
          <AlertTitle>Where this stands</AlertTitle>
          <AlertDescription>
            This page mirrors docs/PRIVACY_BOUNDARY.md. The transaction shape has been confirmed on
            public testnet. It has not been checked on mainnet and has not been independently
            audited.
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              <h2>What anyone can verify, and what only an auditor can</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              <strong>Anyone, from chain data alone:</strong> how much transparent value left the
              funding address, that exactly that amount minus the fee entered the shielded pool in
              the transaction (the binding signature makes the number unforgeable), how many
              shielded outputs there are, the fee, and the change. These add up exactly: funded =
              change + shielded + fee.
            </p>
            <p>
              <strong>Not the public:</strong> that the shielded value reached distinct third
              parties matching a payout list. A payout to the operator&apos;s own address, an
              output built without the campaign&apos;s outgoing viewing key, or a hidden shielded
              spend all look identical to the public. The public cannot tell a dummy spend from a
              real one.
            </p>
            <p>
              <strong>The auditor closes that gap.</strong> With the campaign viewing key they
              recover every output and check that the count equals the public action count and
              that the sum equals the public net value. Any mismatch means a hidden spend, a
              hidden output or an unrecoverable output.
            </p>
          </CardContent>
        </Card>

        <div className="grid gap-6 md:grid-cols-2">
          {SECTIONS.map((section) => (
            <Card key={section.title}>
              <CardHeader>
                <CardTitle className="text-lg">
                  <h2>{section.title}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Bullets items={section.items} />
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              <h2>Known limits</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Bullets items={LIMITS} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              <h2>Who must be trusted</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Bullets items={TRUST} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
