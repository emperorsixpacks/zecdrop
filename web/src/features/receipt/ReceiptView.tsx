import type { PublicReceipt } from "@/api/types";
import { Disclosure } from "@/components/Disclosure";
import { isPracticeId } from "@/lib/practice-mode";

import { BatchList } from "./BatchList";
import { Fingerprint } from "./Fingerprint";
import { FindingsCard } from "./FindingsCard";
import { FundingAddress } from "./FundingAddress";
import { FundsFlow } from "./FundsFlow";
import { ProvesAndNot } from "./ProvesAndNot";
import { ReceiptLens } from "./ReceiptLens";
import { ReceiptVerdict } from "./ReceiptVerdict";

/** A validated receipt, as one sheet: the verdict, what the verifier found and the flow of
 * funds on the left, the public view on the right (one under the other on a phone), with the
 * details behind a click on the desk below it. Nothing here can show recipient data: the type
 * it takes has no field for it. */
export function ReceiptView({ receipt }: { receipt: PublicReceipt }) {
  return (
    <div className="space-y-10">
      <div className="receipt-sheet border border-b-0 border-t-4 border-border border-t-foreground bg-card px-5 pt-6 pb-14 sm:px-8 sm:pt-8 sm:pb-16">
        <div className="grid gap-x-12 gap-y-8 lg:grid-cols-2">
          <div className="min-w-0 space-y-8">
            <ReceiptVerdict receipt={receipt} />
            <FindingsCard findings={receipt.findings} />
            <div aria-hidden className="border-t border-dashed border-border" />
            <FundsFlow receipt={receipt} />
          </div>
          <div className="min-w-0 border-t border-dashed border-border pt-8 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-12">
            <ReceiptLens receipt={receipt} />
          </div>
        </div>
      </div>

      <div className="border-b border-border">
        <Disclosure summary={receipt.batches.length === 1 ? "Transaction" : "Transactions"}>
          <BatchList receipt={receipt} />
        </Disclosure>
        <Disclosure summary="Funding address">
          <FundingAddress
            address={receipt.fundingAddress}
            network={receipt.network}
            someBatchesNotBuilt={receipt.batches.some((b) => b.txid === null)}
            practice={isPracticeId(receipt.manifestCommitment)}
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
