import { useId, useState, type FormEvent } from "react";

import type { OperatorCampaign } from "@/api/operator/schemas";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCoinUnit } from "@/lib/units";
import { parsePositiveZec, ZecParseError, zecFromZatoshi } from "@/lib/zec";

import { FailureNotice } from "./FailureNotice";
import { useHealth, useRecordFunding } from "./hooks";

const TXID = /^[0-9a-f]{64}$/u;
const U32_MAX = 4_294_967_295;

/** A made-up transaction id for the pretend deposit. */
function randomTxid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Records a PRETEND deposit so a campaign can be funded on the mock chain.
 *
 * Development only. It renders nothing unless the operator itself reports that
 * it is on the mock chain, and says so in its own heading, so it can never be
 * mistaken for funding a real campaign. */
export function MockFunding({ campaign }: { campaign: OperatorCampaign }) {
  const health = useHealth();
  const record = useRecordFunding(campaign.id);
  const unit = useCoinUnit();
  const ids = { txid: useId(), vout: useId(), amount: useId() };

  const [txid, setTxid] = useState(randomTxid);
  const [vout, setVout] = useState("0");
  const [amount, setAmount] = useState(() => zecFromZatoshi(campaign.fundingRequired));
  const [problem, setProblem] = useState<string | null>(null);

  // Only when the operator itself says it is the mock chain. Missing or false: no dev controls.
  if (health.data?.mock !== true) return null;

  if (campaign.funding !== null) {
    return (
      <Alert variant="info" role="status">
        <AlertTitle>Mock deposit recorded</AlertTitle>
        <AlertDescription>
          {zecFromZatoshi(campaign.funding.amount)} {unit}, pretend funds. This campaign is ready to start.
        </AlertDescription>
      </Alert>
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    if (!TXID.test(txid)) return setProblem("The transaction id must be 64 lowercase hex characters.");
    const index = Number(vout);
    if (!/^\d+$/u.test(vout) || !Number.isSafeInteger(index) || index > U32_MAX) {
      return setProblem("The output index must be a whole number, 0 or more.");
    }
    let zatoshi: bigint;
    try {
      zatoshi = parsePositiveZec(amount);
    } catch (error) {
      return setProblem(error instanceof ZecParseError ? `Amount: ${error.message}.` : "Amount is not valid.");
    }
    record.mutate({ outpoint: { txid, vout: index }, amount: zatoshi.toString() });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          <h2>Mock chain: record a pretend deposit</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          This is a development shortcut. No funds move: it only tells the mock chain that a deposit of this size
          arrived. The campaign needs {zecFromZatoshi(campaign.fundingRequired)} {unit} (the total plus fees).
        </p>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor={ids.txid}>Deposit transaction id</Label>
            <Input
              id={ids.txid}
              value={txid}
              onChange={(e) => {
                setTxid(e.target.value.trim());
              }}
              className="font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={ids.vout}>Output index</Label>
              <Input
                id={ids.vout}
                inputMode="numeric"
                value={vout}
                onChange={(e) => {
                  setVout(e.target.value.trim());
                }}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.amount}>Amount ({unit})</Label>
              <Input
                id={ids.amount}
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value.trim());
                }}
                autoComplete="off"
              />
            </div>
          </div>
          {problem !== null && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          {record.isError && <FailureNotice error={record.error} />}
          <Button type="submit" disabled={record.isPending}>
            {record.isPending ? "Recording…" : "Record mock deposit"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
