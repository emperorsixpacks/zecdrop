import { useState } from "react";
import { Link, useNavigate } from "react-router";

import { CopyButton } from "@/components/CopyButton";
import { Disclosure } from "@/components/Disclosure";
import { RedactionLens, type LensMode } from "@/components/lens/Lens";
import { PageHeader } from "@/components/PageHeader";
import { PayoutSummary } from "@/components/PayoutSummary";
import { UnitNote } from "@/components/UnitProvider";
import { Zec } from "@/components/Zec";
import { Button } from "@/components/ui/button";
import { OperatorBatchList } from "@/features/operator/OperatorBatchList";
import { describeDuration, estimateProvingSeconds } from "@/lib/fees";

import { useWizardDraft } from "./draft";
import { NeedsPayouts } from "./NeedsPayouts";
import { PrivacyWarnings } from "./PrivacyWarnings";

/** The lens shows this many rows; the rest are counted. */
const LENS_ROWS = 50;

/** Stage 2 of 3: look at it before it goes. The big line says how many people, how much
 * and what it costs; the lens shows the real list the way the public, one person and an
 * auditor would see it; the warnings are short chips with the reason one tap away. */
export default function CheckStage() {
  const navigate = useNavigate();
  const created = useWizardDraft((s) => s.created);
  const list = useWizardDraft((s) => s.list);
  const reset = useWizardDraft((s) => s.reset);
  const releaseList = useWizardDraft((s) => s.releaseList);
  const [mode, setMode] = useState<LensMode>("public");
  const [selectedId, setSelectedId] = useState<string | null>("person-1");
  if (created === null) return <NeedsPayouts />;

  const batches = created.batchCount === 1 ? "1 batch" : `${String(created.batchCount)} batches`;

  return (
    <>
      <PageHeader title="Check the payouts" description={created.name} />
      <div className="space-y-12">
        <div className="space-y-3">
          <PayoutSummary people={created.recipientCount} total={BigInt(created.declaredTotal)} fee={BigInt(created.feeTotal)} />
          <p className="text-base">
            To fund: <Zec zatoshi={created.fundingRequired} />. {batches} of up to {created.maxOutputsPerBatch} payouts.
          </p>
          <p className="text-base text-muted-foreground">
            Takes {describeDuration(estimateProvingSeconds(created.recipientCount))} to build.
          </p>
          <UnitNote />
          {list === null && (
            <p className="text-base text-muted-foreground">The list is not kept once you leave this step, so it cannot be shown again.</p>
          )}
        </div>

        {list !== null && (
          <section aria-labelledby="lens-heading" className="space-y-5">
            <h2 id="lens-heading" className="text-[1.75rem] leading-tight font-bold tracking-[-0.02em]">
              Who sees what
            </h2>
            <RedactionLens
              rows={list}
              mode={mode}
              onModeChange={setMode}
              selectedId={selectedId}
              onSelect={setSelectedId}
              limit={LENS_ROWS}
            />
          </section>
        )}

        <PrivacyWarnings warnings={created.warnings} />

        <div className="flex flex-wrap items-center gap-3">
          <Button asChild size="lg">
            <Link to="/new/send" onClick={releaseList}>
              Looks right, continue
            </Link>
          </Button>
          <Button
            variant="outline"
            size="lg"
            onClick={() => {
              reset();
              void navigate("/new");
            }}
          >
            Start over
          </Button>
        </div>

        <div className="border-b border-border">
          <Disclosure summary="Batches">
            <OperatorBatchList campaign={created} />
          </Disclosure>
          <Disclosure summary="List fingerprint">
            <div className="max-w-[64ch] space-y-3">
              <p className="mono text-sm break-all" data-testid="manifest-commitment">
                {created.manifestCommitment}
              </p>
              <CopyButton value={created.manifestCommitment} label="Copy list fingerprint" />
              <p className="text-sm text-muted-foreground">
                A salted fingerprint of this list. It goes on the public receipt; its technical name is the manifest commitment.
              </p>
            </div>
          </Disclosure>
        </div>
      </div>
    </>
  );
}
