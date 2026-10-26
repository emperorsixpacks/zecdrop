import type { ReactNode } from "react";

import type { PublicReceipt, PublicReceiptBatch } from "@/api/types";
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

import {
  BATCH_STATE_LABEL,
  batchState,
  confirmationsText,
  POOL_LABEL,
  type BatchState,
} from "./format";
import { TxActions } from "@/components/TxActions";
import { shortId } from "@/lib/ids";
import { Unknown, Zec } from "@/components/Zec";

const STATE_BADGE = {
  problem: "destructive",
  not_built: "outline",
  not_found: "secondary",
  unconfirmed: "secondary",
  confirming: "shielded",
  final: "done",
} as const satisfies Record<
  BatchState,
  "destructive" | "outline" | "secondary" | "shielded" | "done"
>;

function StatusBadge({ batch, receipt }: { batch: PublicReceiptBatch; receipt: PublicReceipt }) {
  const state = batchState(batch, receipt.phase, receipt.findings);
  return <Badge variant={STATE_BADGE[state]}>{BATCH_STATE_LABEL[state]}</Badge>;
}

function FundingInput({ batch }: { batch: PublicReceiptBatch }) {
  if (batch.fundingInput === null) {
    return <span className="text-xs text-muted-foreground">Funding input unknown</span>;
  }
  const { txid, vout } = batch.fundingInput;
  return (
    <span className="text-xs text-muted-foreground">
      Funded from{" "}
      <code title={`${txid}:${String(vout)}`} translate="no">
        {shortId(txid, 6)}:{vout}
      </code>
    </span>
  );
}

function Transaction({ receipt, batch }: { receipt: PublicReceipt; batch: PublicReceiptBatch }) {
  if (batch.txid === null) {
    return <span className="text-muted-foreground">Not built yet</span>;
  }
  return <TxActions txid={batch.txid} network={receipt.network} batchIndex={batch.index} />;
}

const poolText = (pool: PublicReceiptBatch["pool"]): ReactNode =>
  pool === null ? <Unknown /> : POOL_LABEL[pool];

const countText = (count: number | null): ReactNode =>
  count === null ? <Unknown /> : count;

/** One batch as a card: for phones and tablets, where seven columns will not fit. */
function BatchCard({ receipt, batch }: { receipt: PublicReceipt; batch: PublicReceiptBatch }) {
  const rows: [label: string, value: ReactNode][] = [
    ["Into the shielded pool", <Zec key="pool-amount" zatoshi={batch.netIntoPool} />],
    ["Fee", <Zec key="fee" zatoshi={batch.fee} />],
    ["Shielded outputs", countText(batch.shieldedActions)],
    ["Pool", poolText(batch.pool)],
    ["Confirmations", confirmationsText(batch.confirmations)],
  ];
  return (
    <li>
      <Card size="sm" className="h-full">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            <h3>Batch {batch.index}</h3>
            <StatusBadge batch={batch} receipt={receipt} />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Transaction receipt={receipt} batch={batch} />
            <div>
              <FundingInput batch={batch} />
            </div>
          </div>
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

/** The batches of a receipt: a table from the large breakpoint up, cards below.
 * Only one is visible at a time (CSS hides the other from everyone, including
 * screen readers), so nothing is read twice. */
export function BatchList({ receipt }: { receipt: PublicReceipt }) {
  if (receipt.batches.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        No payout batches yet. They appear here once the operator builds them.
      </p>
    );
  }

  return (
    <>
      <div className="hidden lg:block">
        <Table>
          <TableCaption className="sr-only">Payout batches</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Batch</TableHead>
              <TableHead scope="col">Transaction</TableHead>
              <TableHead scope="col" className="text-right">
                Into the shielded pool
              </TableHead>
              <TableHead scope="col" className="text-right">
                Fee
              </TableHead>
              <TableHead scope="col" className="text-right">
                Shielded outputs
              </TableHead>
              <TableHead scope="col">Pool</TableHead>
              <TableHead scope="col">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {receipt.batches.map((batch) => (
              <TableRow key={batch.index}>
                <TableHead scope="row" className="text-foreground">
                  {batch.index}
                </TableHead>
                <TableCell>
                  <div className="space-y-1">
                    <Transaction receipt={receipt} batch={batch} />
                    <div>
                      <FundingInput batch={batch} />
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <Zec zatoshi={batch.netIntoPool} />
                </TableCell>
                <TableCell className="text-right">
                  <Zec zatoshi={batch.fee} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {countText(batch.shieldedActions)}
                </TableCell>
                <TableCell>{poolText(batch.pool)}</TableCell>
                <TableCell>
                  <div className="space-y-1">
                    <StatusBadge batch={batch} receipt={receipt} />
                    <div className="text-xs text-muted-foreground">
                      {confirmationsText(batch.confirmations)}
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul aria-label="Payout batches" className="grid gap-3 sm:grid-cols-2 lg:hidden">
        {receipt.batches.map((batch) => (
          <BatchCard key={batch.index} receipt={receipt} batch={batch} />
        ))}
      </ul>
    </>
  );
}
