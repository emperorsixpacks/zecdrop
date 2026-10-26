import { useEffect, useId, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";

import { OperatorApiError } from "@/api/operator/client";
import { DropZone } from "@/components/DropZone";
import { PageHeader } from "@/components/PageHeader";
import { Segmented } from "@/components/Segmented";
import { Why } from "@/components/Why";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/Disclosure";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FailureNotice } from "@/features/operator/FailureNotice";
import { useCreateCampaign, useHealth } from "@/features/operator/hooks";
import { useAudience, type Audience } from "@/lib/audience";
import { previewPayouts } from "@/lib/csv-preview";
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
import { EXAMPLE_LIST_NAME, EXAMPLE_LIST_NOTE, exampleListFor } from "./example-list";
import { lensRowsFrom } from "./list";
import { PayoutPreview } from "./PayoutPreview";
import { PeopleList } from "./PeopleList";
import { composeCsv, lineOf, peopleFromCsv, personProblems, totalProblem } from "./people";
import { batchSizeProblem, csvProblem } from "./validation";

/** "Payout, 8 Oct": the name used when the person does not type one. */
function defaultRunName(now = new Date()): string {
  return `Payout, ${String(now.getDate())} ${now.toLocaleString("en-GB", { month: "short" })}`;
}

const AUDIENCES = [
  { value: "personal", label: "Personal" },
  { value: "organisation", label: "Organisation" },
] as const satisfies readonly { value: Audience; label: string }[];

const AUDIENCE_NOTE: Record<Audience, string> = {
  personal: "Family, friends or a few people, typed in one by one.",
  organisation: "A team or a community: a spreadsheet, the options and the auditor's tools.",
};

const POLICY_LABEL: Record<FeePolicyName, string> = {
  zip317_text: "Standard",
  zebra_main: "Lower",
};

/** Stage 1 of 3. Add the people, name the run, continue. Who it is for decides how much the screen shows
 * (lib/audience.ts): a personal payout is the people list and Continue; an organisation's starts from a spreadsheet and
 * has the fee and batch options, with the people list one click away. Either way everything stays in this page's
 * memory until Continue sends it, once, to the operator on this computer. */
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
  const people = useWizardDraft((s) => s.people);
  const amountMode = useWizardDraft((s) => s.amountMode);
  const splitTotal = useWizardDraft((s) => s.splitTotal);
  const { setName, setFeePolicy, setMaxOutputsPerBatch, setCsv, setPeople, campaignCreated, reset } = useWizardDraft.getState();

  const exampleList = exampleListFor(health.data?.network);
  const audience = useAudience((s) => s.audience);
  const setAudience = useAudience((s) => s.setAudience);
  const organisation = audience === "organisation";
  // An organisation's list starts from a file; this is its people list instead, when asked for.
  const [byHand, setByHand] = useState(false);
  const { state, create, clearError } = useCreateCampaign();
  const creating = state.status === "creating";
  const [sizeText, setSizeText] = useState(String(size));
  const [asked, setAsked] = useState(false);
  const [localProblem, setLocalProblem] = useState<string | null>(null);

  const preview = useMemo(() => previewPayouts(csvText), [csvText]);
  // With no file imported, the list is the one built on this page.
  const importing = preview.kind !== "empty";
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
  // On the list built here, person N is line N + 1: the operator's sentences go to the person they are about.
  const byPerson = useMemo(() => {
    const map = new Map<string, string[]>();
    if (importing) return map;
    people.forEach((person, index) => {
      const said = problems.get(lineOf(index));
      if (said !== undefined) map.set(person.key, [...said]);
    });
    return map;
  }, [importing, people, problems]);
  const shownLines = new Set(
    importing ? (preview.kind === "rows" ? preview.rows.slice(0, 50).map((r) => r.line) : []) : people.map((_, index) => lineOf(index)),
  );
  const elsewhere = (importFailure?.errors ?? []).filter((e) => !shownLines.has(e.line));

  /** Change the list: the operator's old verdict no longer applies to it. */
  function edit(text: string, fileName: string | null = null) {
    clearError();
    setLocalProblem(null);
    setCsv(text, fileName);
  }

  /** How many things on the list built here stop it from being sent. */
  function listProblems(): number {
    const inRows = people.reduce(
      (count, _, index) => count + Object.values(personProblems(people, index, amountMode)).filter((problem) => problem !== null).length,
      0,
    );
    return inRows + (amountMode !== "each" && totalProblem(splitTotal, people.length, amountMode) !== null ? 1 : 0);
  }

  async function submit() {
    setAsked(true);
    // An organisation that has neither imported a list nor opened the people list has nothing to send.
    if (!importing && organisation && !byHand) {
      setLocalProblem("Import a list, or add people one by one.");
      return;
    }
    if (!importing) {
      const count = listProblems();
      if (count > 0) {
        setLocalProblem(count === 1 ? "1 problem to fix." : `${String(count)} problems to fix.`);
        return;
      }
    }
    const csv = importing ? csvText : composeCsv(people);
    const problem = csvProblem(csv) ?? (sizeValid ? null : batchSizeProblem(size));
    if (problem !== null) {
      setLocalProblem(problem);
      return;
    }
    setLocalProblem(null);
    const campaign = await create({
      name: name.trim() === "" ? runName : name.trim(),
      csv,
      maxOutputsPerBatch: size,
      feePolicy,
    });
    if (campaign !== null) {
      const rows = previewPayouts(csv);
      campaignCreated(campaign, rows.kind === "rows" ? lensRowsFrom(rows.rows) : null);
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
        {...(importing
          ? {}
          : {
              description:
                organisation && !byHand ? "Import your list, or add people one by one. Nothing is sent yet." : "Add the people you're paying. Nothing is sent yet.",
            })}
      />
      <form
        className="space-y-10"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-2">
          {/* The control names itself to assistive technology; this is the same words for the eye. */}
          <p aria-hidden className="text-base font-semibold">
            Who it&apos;s for
          </p>
          <Segmented label="Who it's for" value={audience} options={AUDIENCES} onValueChange={setAudience} />
          <p className="text-sm text-muted-foreground">{AUDIENCE_NOTE[audience]}</p>
        </div>

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
          {!importing && organisation && !byHand ? (
            <>
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
              {exampleList !== null && <p className="text-sm text-muted-foreground">{EXAMPLE_LIST_NOTE}</p>}
              <Button
                type="button"
                variant="ghost"
                className="px-1 underline underline-offset-4 hover:bg-transparent"
                disabled={creating}
                onClick={() => {
                  setByHand(true);
                }}
              >
                Add people one by one instead
              </Button>
            </>
          ) : !importing ? (
            <>
              {exampleList !== null && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Button
                    type="button"
                    size="lg"
                    disabled={creating}
                    onClick={() => {
                      edit("");
                      setPeople(peopleFromCsv(exampleList));
                    }}
                  >
                    Use the example list
                  </Button>
                  <p className="text-sm text-muted-foreground">{EXAMPLE_LIST_NOTE}</p>
                </div>
              )}
              {verdict}
              <PeopleList
                showAll={asked}
                operatorProblems={byPerson}
                network={health.data?.network ?? null}
                disabled={creating}
                onChange={() => {
                  clearError();
                  setLocalProblem(null);
                }}
              />
              {organisation && (
                <Button
                  type="button"
                  variant="ghost"
                  className="px-1 underline underline-offset-4 hover:bg-transparent"
                  disabled={creating}
                  onClick={() => {
                    setByHand(false);
                  }}
                >
                  Import a list instead
                </Button>
              )}
            </>
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
            <p ref={setSummary} tabIndex={-1} role="alert" className="text-base font-medium text-problem outline-none">
              {localProblem}
            </p>
          )}
        </section>

        {organisation && (
          <div className="border-b border-border">
            {importing && (
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
            )}
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

        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" size="lg" disabled={creating}>
            {creating ? "Checking the list…" : "Continue"}
          </Button>
        </div>
      </form>
    </>
  );
}
