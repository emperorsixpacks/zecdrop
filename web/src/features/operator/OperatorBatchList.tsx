import type { ReactNode } from "react";

import type { OperatorBatch, OperatorCampaign } from "@/api/operator/schemas";
import { TxActions } from "@/components/TxActions";
import { Zec } from "@/components/Zec";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { batchStatus } from "./BatchStatus";

type Campaign = Pick<OperatorCampaign, "batches" | "network" | "phase">;

function Status({ batch, campaign }: { batch: OperatorBatch; campaign: Campaign }) {
  const view = batchStatus(batch, campaign.phase);
  return (
    <div className="space-y-1">
      <Badge variant={view.tone}>{view.label}</Badge>
      {view.note !== null && <div className="text-xs text-muted-foreground">{view.note}</div>}
    </div>
  );
}

function Transaction({ batch, campaign }: { batch: OperatorBatch; campaign: Campaign }) {
  if (batch.txid === null) return <span className="text-muted-foreground">Not built yet</span>;
  return <TxActions txid={batch.txid} network={campaign.network} batchIndex={batch.index} />;
}

const payouts = (n: number) => `${String(n)} ${n === 1 ? "payout" : "payouts"}`;

function BatchCard({ batch, campaign }: { batch: OperatorBatch; campaign: Campaign }) {
  const rows: [string, ReactNode][] = [
    ["Payouts", payouts(batch.recipients)],
    ["Into the shielded pool", <Zec key="total" zatoshi={batch.total} />],
    ["Fee", <Zec key="fee" zatoshi={batch.fee} />],
  ];
  return (
    <li>
      <Card size="sm" className="h-full">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            <h3>Batch {batch.index}</h3>
            <Status batch={batch} campaign={campaign} />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Transaction batch={batch} campaign={campaign} />
          <dl className="space-y-1.5 text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </li>
  );
}

/** The operator's batches: a table from the large breakpoint up, cards below.
 * Only counts, totals and txids appear; the operator's API has nothing else. */
export function OperatorBatchList({ campaign }: { campaign: Campaign }) {
  if (campaign.batches.length === 0) {
    return (
      <div data-testid="batches-empty" className="space-y-1">
        <p className="text-base font-semibold">No batches yet</p>
        <p className="max-w-[64ch] text-base text-muted-foreground">
          Each batch of payouts shows up here, with its transaction and fee, once the payout is sent.
        </p>
      </div>
    );
  }
  return (
    <>
      <div className="hidden lg:block">
        <Table>
          <TableCaption className="sr-only">Batches of this campaign</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Batch</TableHead>
              <TableHead scope="col" className="text-right">
                Payouts
              </TableHead>
              <TableHead scope="col" className="text-right">
                Into the shielded pool
              </TableHead>
              <TableHead scope="col" className="text-right">
                Fee
              </TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Transaction</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaign.batches.map((batch) => (
              <TableRow key={batch.index}>
                <TableHead scope="row" className="text-foreground">
                  {batch.index}
                </TableHead>
                <TableCell className="text-right tabular-nums">{batch.recipients}</TableCell>
                <TableCell className="text-right">
                  <Zec zatoshi={batch.total} />
                </TableCell>
                <TableCell className="text-right">
                  <Zec zatoshi={batch.fee} />
                </TableCell>
                <TableCell>
                  <Status batch={batch} campaign={campaign} />
                </TableCell>
                <TableCell>
                  <Transaction batch={batch} campaign={campaign} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul aria-label="Batches of this campaign" className="grid gap-3 sm:grid-cols-2 lg:hidden">
        {campaign.batches.map((batch) => (
          <BatchCard key={batch.index} batch={batch} campaign={campaign} />
        ))}
      </ul>
    </>
  );
}
