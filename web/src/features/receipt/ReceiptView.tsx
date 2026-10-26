import type { PublicReceipt } from "@/api/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { BatchList } from "./BatchList";
import { BoundaryCards } from "./BoundaryCards";
import { CommitmentCard } from "./CommitmentCard";
import { FindingsCard } from "./FindingsCard";
import { FundingAddressCard } from "./FundingAddressCard";
import { ReceiptSummary } from "./ReceiptSummary";

/** A validated receipt, top to bottom. Nothing here can show recipient data:
 * the type it takes has no field for it. */
export function ReceiptView({ receipt }: { receipt: PublicReceipt }) {
  return (
    <div className="space-y-8">
      <ReceiptSummary receipt={receipt} />
      <FindingsCard findings={receipt.findings} />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            <h2>Batches</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <BatchList receipt={receipt} />
        </CardContent>
      </Card>

      <FundingAddressCard
        address={receipt.fundingAddress}
        network={receipt.network}
        someBatchesNotBuilt={receipt.batches.some((b) => b.txid === null)}
      />
      <CommitmentCard commitment={receipt.manifestCommitment} />
      <BoundaryCards />
    </div>
  );
}
