import type { PublicReceipt } from "@/api/types";
import { Disclosure } from "@/components/Disclosure";

import { BatchList } from "./BatchList";
import { Fingerprint } from "./Fingerprint";
import { FindingsCard } from "./FindingsCard";
import { FundingAddress } from "./FundingAddress";
import { FundsFlow } from "./FundsFlow";
import { ProvesAndNot } from "./ProvesAndNot";
import { ReceiptLens } from "./ReceiptLens";
import { ReceiptVerdict } from "./ReceiptVerdict";

/** A validated receipt, top to bottom: the verdict, what the verifier found, the
 * flow of funds, the public view, then the details behind a click. Nothing here can
 * show recipient data: the type it takes has no field for it. */
export function ReceiptView({ receipt }: { receipt: PublicReceipt }) {
  return (
    <div className="space-y-12">
      <div className="space-y-8">
        <ReceiptVerdict receipt={receipt} />
        <FindingsCard findings={receipt.findings} />
      </div>
      <FundsFlow receipt={receipt} />
      <ReceiptLens receipt={receipt} />

      <div className="border-b border-border">
        <Disclosure summary={receipt.batches.length === 1 ? "Transaction" : "Transactions"}>
          <BatchList receipt={receipt} />
        </Disclosure>
        <Disclosure summary="Funding address">
          <FundingAddress
            address={receipt.fundingAddress}
            network={receipt.network}
            someBatchesNotBuilt={receipt.batches.some((b) => b.txid === null)}
          />
        </Disclosure>
        <Disclosure summary="List fingerprint">
          <Fingerprint commitment={receipt.manifestCommitment} />
        </Disclosure>
        <Disclosure summary="What this proves and what it does not">
          <ProvesAndNot />
        </Disclosure>
      </div>
    </div>
  );
}
