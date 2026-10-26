import type { PublicReceipt } from "@/api/types";
import { UnitNote } from "@/components/UnitProvider";
import { Zec } from "@/components/Zec";
import { Progress } from "@/components/ui/progress";
import { phaseLabel, phaseProgress, phaseSentence } from "@/lib/phase";

import { outputCount } from "./format";

/** The first thing on a receipt: where it stands, in one line made only of what a
 * key-less verifier can compute (outputs, total, fee), then the status sentence. */
export function ReceiptVerdict({ receipt }: { receipt: PublicReceipt }) {
  const { phase } = receipt;
  const progress = phaseProgress(phase);
  const percent = phase.phase === "sending" && phase.total > 0 ? Math.round((phase.done / phase.total) * 100) : 0;
  const outputs = outputCount(receipt);
  const batches = receipt.batches.length;

  return (
    <section aria-labelledby="status-heading" className="space-y-4">
      <h2 id="status-heading" className="sr-only">
        Status
      </h2>
      <p className="display flex max-w-[34ch] items-start gap-4 text-[1.625rem] leading-[1.1] text-balance sm:text-[2.25rem]" data-testid="verdict">
        {phase.phase === "settled" && (
          // The tick is drawn once, when the receipt appears: a settled batch, said with a picture too.
          <svg aria-hidden viewBox="0 0 56 56" className="check-draw mt-0.5 size-9 shrink-0 sm:size-12">
            <circle cx="28" cy="28" r="28" fill="var(--verified)" />
            <path d="M16 29l8 8 16-17" fill="none" stroke="var(--background)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        <span>
        {phase.phase === "settled" ? <span className="text-verified">{phaseLabel(phase.phase)}</span> : phaseLabel(phase.phase)}:{" "}
        {batches === 0 ? (
          "no batches yet"
        ) : (
          <>
            {outputs !== null && (
              <>
                {outputs === 1 ? "1 payout" : `${String(outputs)} payouts`}
                {batches > 1 && ` in ${String(batches)} batches`},{" "}
              </>
            )}
            <Zec zatoshi={receipt.declaredTotal} />, fee <Zec zatoshi={receipt.feeTotal} />
          </>
        )}
        </span>
      </p>
      <div className="max-w-[64ch] space-y-3">
        <p className="text-base">{phaseSentence(phase)}</p>
        {progress !== null && (
          <Progress value={percent} className="h-2" aria-label="Batches confirmed" getValueLabel={() => progress} />
        )}
        <UnitNote />
      </div>
    </section>
  );
}
