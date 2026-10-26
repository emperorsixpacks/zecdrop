import { useId, useState } from "react";
import { Link, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DEFAULT_BATCH_SIZE,
  describeDuration,
  estimateBatchFee,
  estimateProvingSeconds,
  FEE_POLICIES,
  MAX_BATCH_SIZE,
  MIN_BATCH_SIZE,
  type FeePolicyName,
} from "@/lib/fees";
import { useCoinUnit } from "@/lib/units";
import { formatZec } from "@/lib/zec";
import { cn } from "@/lib/utils";

import { useHealth } from "@/features/operator/hooks";

import { useWizardDraft } from "./draft";
import { StepHeader } from "./StepHeader";
import { StepNav } from "./StepNav";
import { batchSizeProblem, nameProblem } from "./validation";

const POLICY_COPY: Record<FeePolicyName, { title: string; body: string }> = {
  zip317_text: {
    title: "Standard: 5,000 zatoshi per action (recommended)",
    body: "The value written in ZIP-317, the Zcash fee rule. It pays a little more than some nodes ask for, so any node accepts it.",
  },
  zebra_main: {
    title: "Lower: 1,000 zatoshi per action",
    body: "What the current Zebra node software asks for. Cheaper, but a node that follows the ZIP-317 text would refuse it. Choose this only if you know your node accepts it.",
  },
};

function LockedSummary() {
  const created = useWizardDraft((s) => s.created);
  const reset = useWizardDraft((s) => s.reset);
  if (created === null) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          <h2>Basics (locked)</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p>
          <strong>{created.name}</strong> has been created, so its name, fee and batch size are fixed. To change them,
          start a new campaign. Campaigns cannot be deleted yet, so this one stays in your list.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={reset}>
            Start a new campaign
          </Button>
          <Button asChild variant="link">
            <Link to="/new/auditor">Continue with this one</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function BasicsStep() {
  const navigate = useNavigate();
  const ids = { name: useId(), size: useId(), nameError: useId(), sizeError: useId() };
  const created = useWizardDraft((s) => s.created);
  const name = useWizardDraft((s) => s.name);
  const feePolicy = useWizardDraft((s) => s.feePolicy);
  const size = useWizardDraft((s) => s.maxOutputsPerBatch);
  const { setName, setFeePolicy, setMaxOutputsPerBatch } = useWizardDraft.getState();
  const health = useHealth();
  const unit = useCoinUnit();
  const realChain = health.data?.mock === false;
  const [sizeText, setSizeText] = useState(String(size));
  const [touched, setTouched] = useState(false);

  const nameError = touched ? nameProblem(name) : null;
  const sizeError = touched ? batchSizeProblem(size) : null;
  const sizeValid = batchSizeProblem(size) === null;
  const exampleSize = sizeValid ? size : DEFAULT_BATCH_SIZE;

  function next() {
    setTouched(true);
    if (nameProblem(name) === null && batchSizeProblem(size) === null) void navigate("/new/recipients");
  }

  return (
    <>
      <StepHeader slug="basics" description="Name the campaign and choose how it is sent." />
      {created !== null ? (
        <LockedSummary />
      ) : (
        <div className="space-y-6">
          <Card>
            <CardContent className="space-y-1.5">
              <Label htmlFor={ids.name}>Campaign name</Label>
              <Input
                id={ids.name}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
                aria-invalid={nameError !== null}
                aria-describedby={nameError !== null ? ids.nameError : undefined}
                autoComplete="off"
                maxLength={200}
              />
              {nameError !== null && (
                <p id={ids.nameError} role="alert" className="text-sm text-destructive">
                  {nameError}
                </p>
              )}
              <p className="text-sm text-muted-foreground">Only you see the name. It is not part of the public receipt.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                <h2>Network fee</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Zcash charges a fee for each &ldquo;action&rdquo; in a transaction. A batch costs about one action per
                payout, plus one for the funding side, and never less than three. The exact fee for every batch is shown
                at review.
              </p>
              <fieldset className="space-y-3">
                <legend className="sr-only">Fee policy</legend>
                {Object.values(FEE_POLICIES).map((policy) => (
                  <label
                    key={policy.name}
                    className={cn(
                      "flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors",
                      feePolicy === policy.name ? "border-link bg-primary/10" : "hover:bg-secondary",
                    )}
                  >
                    <input
                      type="radio"
                      name="fee-policy"
                      value={policy.name}
                      checked={feePolicy === policy.name}
                      onChange={() => {
                        setFeePolicy(policy.name);
                      }}
                      className="mt-1 size-4 accent-link"
                    />
                    <span className="space-y-1">
                      <span className="block text-sm font-medium">{POLICY_COPY[policy.name].title}</span>
                      <span className="block text-sm text-muted-foreground">{POLICY_COPY[policy.name].body}</span>
                      <span className="block text-sm">
                        A batch of {exampleSize} costs {formatZec(estimateBatchFee(policy.name, exampleSize))} {unit}.
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                <h2>Batch size</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              <Label htmlFor={ids.size}>Payouts per batch</Label>
              <Input
                id={ids.size}
                inputMode="numeric"
                value={sizeText}
                onChange={(e) => {
                  setSizeText(e.target.value);
                  setMaxOutputsPerBatch(/^\d+$/u.test(e.target.value.trim()) ? Number(e.target.value.trim()) : Number.NaN);
                }}
                aria-invalid={sizeError !== null}
                aria-describedby={sizeError !== null ? `${ids.sizeError} ${ids.size}-help` : `${ids.size}-help`}
                className="max-w-32"
                autoComplete="off"
              />
              {sizeError !== null && (
                <p id={ids.sizeError} role="alert" className="text-sm text-destructive">
                  {sizeError}
                </p>
              )}
              <p id={`${ids.size}-help`} className="text-sm text-muted-foreground">
                Each batch is one transaction ({String(MIN_BATCH_SIZE)} to {String(MAX_BATCH_SIZE)} payouts; the default
                is {String(DEFAULT_BATCH_SIZE)}). Building a batch takes about 1.25 seconds per payout
                {sizeValid ? `, so ${String(size)} payouts takes ${describeDuration(estimateProvingSeconds(size))}` : ""}
                . That is a measurement from one computer, so treat it as a guide.
              </p>
              {realChain && (
                <p className="text-sm text-muted-foreground" data-testid="single-batch-note">
                  On a real chain this build sends one batch per campaign, because splitting the deposit across
                  several batches is not built yet. Set the batch size to {String(MAX_BATCH_SIZE)} so up to{" "}
                  {String(MAX_BATCH_SIZE)} recipients fit in one.
                </p>
              )}
            </CardContent>
          </Card>

          <StepNav>
            <Button onClick={next}>Next: Recipients</Button>
          </StepNav>
        </div>
      )}
    </>
  );
}
