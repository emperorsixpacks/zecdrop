import { useEffect, useId, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";

import { OperatorApiError } from "@/api/operator/client";
import { DropZone } from "@/components/DropZone";
import { PageHeader } from "@/components/PageHeader";
import { Why } from "@/components/Why";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/Disclosure";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FailureNotice } from "@/features/operator/FailureNotice";
import { useCreateCampaign, useHealth } from "@/features/operator/hooks";
import { previewPayouts } from "@/lib/csv-preview";
import { usePractice } from "@/lib/practice-mode";
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

import { useWizardDraft } from "./draft";
import { lensRowsFrom } from "./list";
import { PayoutPreview } from "./PayoutPreview";
import { batchSizeProblem, csvProblem } from "./validation";

/** "Payout, 8 Oct": the name used when the person does not type one. */
function defaultRunName(now = new Date()): string {
  return `Payout, ${String(now.getDate())} ${now.toLocaleString("en-GB", { month: "short" })}`;
}

/** What the example list is called where a file's name would be. */
const EXAMPLE_LIST_NAME = "demo-recipients.testnet.csv";

const POLICY_LABEL: Record<FeePolicyName, string> = {
  zip317_text: "Standard",
  zebra_main: "Lower",
};

/** Stage 1 of 3. Add the list, name the run, continue. Everything stays in this
 * page's memory until Continue sends it, once, to the operator on this computer. */
export default function PayoutsStage() {
  const navigate = useNavigate();
  const unit = useCoinUnit();
  const health = useHealth();
  const ids = { name: useId(), size: useId(), sizeHelp: useId(), edit: useId() };

  const created = useWizardDraft((s) => s.created);
  const name = useWizardDraft((s) => s.name);
  const feePolicy = useWizardDraft((s) => s.feePolicy);
  const size = useWizardDraft((s) => s.maxOutputsPerBatch);
  const csvText = useWizardDraft((s) => s.csvText);
  const csvFileName = useWizardDraft((s) => s.csvFileName);
  const { setName, setFeePolicy, setMaxOutputsPerBatch, setCsv, campaignCreated, reset } = useWizardDraft.getState();

  const exampleList = usePractice((s) => s.exampleList);
  const { state, create, clearError } = useCreateCampaign();
  const creating = state.status === "creating";
  const [sizeText, setSizeText] = useState(String(size));
  const [asked, setAsked] = useState(false);
  const [localProblem, setLocalProblem] = useState<string | null>(null);

  const preview = useMemo(() => previewPayouts(csvText), [csvText]);
  const runName = defaultRunName();
  const realChain = health.data?.mock === false;
  const sizeValid = batchSizeProblem(size) === null;

  // What the operator said is wrong, by line. Only its sentences are kept.
  const importFailure =
    state.status === "failed" &&
    state.error instanceof OperatorApiError &&
    state.error.api !== null &&
    state.error.api.code === "import_failed" &&
    "errors" in state.error.api
      ? state.error.api
      : null;
  const problems = useMemo(() => {
    const byLine = new Map<number, string[]>();
    for (const error of importFailure?.errors ?? []) byLine.set(error.line, [...(byLine.get(error.line) ?? []), error.message]);
    return byLine;
  }, [importFailure]);
  const shownLines = new Set(preview.kind === "rows" ? preview.rows.slice(0, 50).map((r) => r.line) : []);
  const elsewhere = (importFailure?.errors ?? []).filter((e) => !shownLines.has(e.line));

  /** Change the list: the operator's old verdict no longer applies to it. */
  function edit(text: string, fileName: string | null = null) {
    clearError();
    setLocalProblem(null);
    setCsv(text, fileName);
  }

  async function submit() {
    setAsked(true);
    const problem = csvProblem(csvText) ?? (sizeValid ? null : batchSizeProblem(size));
    if (problem !== null) {
      setLocalProblem(problem);
      return;
    }
    setLocalProblem(null);
    const campaign = await create({
      name: name.trim() === "" ? runName : name.trim(),
      csv: csvText,
      maxOutputsPerBatch: size,
      feePolicy,
    });
    if (campaign !== null) {
      campaignCreated(campaign, preview.kind === "rows" ? lensRowsFrom(preview.rows) : null);
      void navigate("/new/check");
    }
  }

  // The summary of problems takes focus when it appears, so it is announced.
  const [summary, setSummary] = useState<HTMLParagraphElement | null>(null);
  useEffect(() => {
    summary?.focus();
  }, [summary]);

  const verdict =
    importFailure !== null ? (
      <div className="space-y-2">
        <p ref={setSummary} tabIndex={-1} role="alert" className="text-xl font-bold text-problem outline-none">
          {importFailure.errorCount === 1 ? "1 problem" : `${String(importFailure.errorCount)} problems`} to fix.
        </p>
        <p className="text-base">Fix them in the list, or use a different one.</p>
        {elsewhere.length > 0 && (
          <ul className="space-y-1 text-base font-medium text-problem">
            {elsewhere.slice(0, 5).map((e, i) => (
              <li key={`${String(e.line)}-${e.code}-${String(i)}`}>
                Line {e.line}: {e.message}
              </li>
            ))}
            {elsewhere.length > 5 && <li>And {elsewhere.length - 5} more.</li>}
          </ul>
        )}
      </div>
    ) : null;

  if (created !== null) {
    return (
      <>
        <PageHeader title="Payouts added" description={`${created.name} is ready to check.`} />
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild size="lg">
            <Link to="/new/check">Continue</Link>
          </Button>
          <Button variant="outline" onClick={reset}>
            Start a new payout
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Add the payouts"
        {...(preview.kind === "empty" ? { description: "Drop the list of who to pay. Nothing is sent yet." } : {})}
      />
      <form
        className="space-y-10"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="max-w-md space-y-2">
          <Label htmlFor={ids.name}>Name this payout run</Label>
          <Input
            id={ids.name}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            placeholder={runName}
            autoComplete="off"
            maxLength={100}
          />
        </div>

        <section aria-label="Payout list" className="space-y-5">
          {preview.kind === "empty" ? (
            <DropZone
              onList={edit}
              disabled={creating}
              {...(exampleList === null
                ? {}
                : {
                    onExample: () => {
                      edit(exampleList, EXAMPLE_LIST_NAME);
                    },
                  })}
            />
          ) : (
            <>
              {preview.kind === "rows" ? (
                <PayoutPreview
                  preview={preview}
                  problems={problems}
                  notice={verdict}
                />
              ) : (
                <>
                  <p role="alert" className="text-base font-medium text-problem">
                    {preview.reason}
                  </p>
                  {verdict}
                </>
              )}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
                {csvFileName !== null && <p className="mono text-sm text-muted-foreground">{csvFileName}</p>}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={creating}
                  onClick={() => {
                    edit("");
                  }}
                >
                  Use a different list
                </Button>
              </div>
            </>
          )}

          {importFailure === null && state.status === "failed" && <FailureNotice error={state.error} />}
          {asked && localProblem !== null && (
            <p role="alert" className="text-base font-medium text-problem">
              {localProblem}
            </p>
          )}
        </section>

        {preview.kind !== "empty" && (
          <div className="border-b border-border">
            <Disclosure summary="Edit as text">
              <Label htmlFor={ids.edit} className="sr-only">
                Payout list as text
              </Label>
              <Textarea
                id={ids.edit}
                value={csvText}
                onChange={(e) => {
                  edit(e.target.value, null);
                }}
                rows={8}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                wrap="off"
                className="mono text-sm"
                disabled={creating}
              />
            </Disclosure>
          <Disclosure summary="Options">
            <div className="space-y-8 pt-1">
              <fieldset className="space-y-3">
                <legend className="flex items-center text-base font-semibold">
                  Network fee
                  <Why label="About the network fee">
                    <p className="font-semibold">Two fee levels</p>
                    <p className="mt-1">
                      Zcash charges per action. Standard pays 5,000 zatoshi per action, as the ZIP-317 text says, and any node
                      accepts it. Lower pays 1,000, which is what current Zebra nodes ask for; a node that follows the ZIP-317 text
                      would refuse it.
                    </p>
                  </Why>
                </legend>
                {Object.values(FEE_POLICIES).map((policy) => {
                  const example = sizeValid ? size : DEFAULT_BATCH_SIZE;
                  const fee = estimateBatchFee(policy.name, example);
                  return (
                    <label key={policy.name} className="flex min-h-11 cursor-pointer items-start gap-3">
                      <input
                        type="radio"
                        name="fee-policy"
                        value={policy.name}
                        checked={feePolicy === policy.name}
                        onChange={() => {
                          setFeePolicy(policy.name);
                        }}
                        className="mt-1.5 size-5 accent-foreground"
                      />
                      <span>
                        <span className="block text-base font-semibold">
                          {POLICY_LABEL[policy.name]}
                          {policy.name === "zip317_text" && " (recommended)"}
                        </span>
                        <span className="block text-sm text-muted-foreground">
                          {formatZec(fee)} {unit} for {example} payouts
                        </span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>

              <div className="max-w-xs space-y-2">
                <Label htmlFor={ids.size}>Payouts per batch</Label>
                <Input
                  id={ids.size}
                  inputMode="numeric"
                  value={sizeText}
                  onChange={(e) => {
                    setSizeText(e.target.value);
                    const trimmed = e.target.value.trim();
                    setMaxOutputsPerBatch(/^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN);
                  }}
                  aria-invalid={!sizeValid}
                  aria-describedby={ids.sizeHelp}
                  className="max-w-24"
                  autoComplete="off"
                />
                <p id={ids.sizeHelp} className={sizeValid ? "text-sm text-muted-foreground" : "text-sm font-medium text-problem"} role={sizeValid ? undefined : "alert"}>
                  {sizeValid
                    ? `${String(size)} payouts take ${describeDuration(estimateProvingSeconds(size))}. ${String(MIN_BATCH_SIZE)} to ${String(MAX_BATCH_SIZE)} allowed.`
                    : (batchSizeProblem(size) ?? "")}
                </p>
                {realChain && (
                  <p className="text-sm text-muted-foreground" data-testid="single-batch-note">
                    On a real chain this build sends one batch per campaign. Set {String(MAX_BATCH_SIZE)} so up to {String(MAX_BATCH_SIZE)} payouts fit.
                  </p>
                )}
              </div>
            </div>
          </Disclosure>
          </div>
        )}

        {preview.kind !== "empty" && (
          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" size="lg" disabled={creating}>
              {creating ? "Checking the list…" : "Continue"}
            </Button>
          </div>
        )}
      </form>
    </>
  );
}
