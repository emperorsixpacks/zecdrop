import type { ReactNode } from "react";

import type { PublicReceipt } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  phaseBadgeVariant,
  phaseLabel,
  phaseProgress,
  phaseSentence,
} from "@/lib/phase";

import { UnitNote } from "@/components/UnitProvider";
import { Zec } from "@/components/Zec";

function Stat({ label, note, children }: { label: string; note: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tracking-tight">{children}</dd>
      <dd className="text-xs text-muted-foreground">{note}</dd>
    </div>
  );
}

/** Status in plain language, a progress bar while sending, and the totals. */
export function ReceiptSummary({ receipt }: { receipt: PublicReceipt }) {
  const { phase } = receipt;
  const progress = phaseProgress(phase);
  const percent =
    phase.phase === "sending" && phase.total > 0
      ? Math.round((phase.done / phase.total) * 100)
      : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-3 text-lg">
          <h2>Status</h2>
          <Badge variant={phaseBadgeVariant(phase.phase)}>{phaseLabel(phase.phase)}</Badge>
          <Badge variant="outline">Zcash {receipt.network}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <p className="text-base">{phaseSentence(phase)}</p>
          {progress !== null && (
            <Progress
              value={percent}
              className="h-2"
              aria-label="Batches confirmed"
              getValueLabel={() => progress}
            />
          )}
        </div>

        <dl className="grid gap-6 sm:grid-cols-3">
          <Stat label="Declared total" note="The sum of what entered the shielded pool, across all batches.">
            <Zec zatoshi={receipt.declaredTotal} />
          </Stat>
          <Stat
            label="Network fees"
            note={
              receipt.feeTotal === null
                ? "Some fees could not be established, so no total is shown."
                : "The sum of the fees the batch transactions pay."
            }
          >
            <Zec zatoshi={receipt.feeTotal} />
          </Stat>
          <Stat label="Batches" note="One Zcash transaction each.">
            <span className="tabular-nums">{receipt.batches.length}</span>
          </Stat>
        </dl>
        <UnitNote />
      </CardContent>
    </Card>
  );
}
