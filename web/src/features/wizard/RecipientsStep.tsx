import { useId, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link, useNavigate } from "react-router";

import { OperatorApiError } from "@/api/operator/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FailureNotice } from "@/features/operator/FailureNotice";
import { useCreateCampaign } from "@/features/operator/hooks";
import { useCoinUnit } from "@/lib/units";

import { useWizardDraft } from "./draft";
import { ImportErrors } from "./ImportErrors";
import { StepHeader } from "./StepHeader";
import { StepNav } from "./StepNav";
import { batchSizeProblem, CSV_MAX_BYTES, csvProblem, nameProblem } from "./validation";

/** The first line of a column guide: names only, no example recipient. */
const HEADER_HINT = "address,amount,memo";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Counts only: how big the pasted text is. It never looks at the content. */
function sizeOf(csv: string): { lines: number; bytes: number } {
  if (csv.length === 0) return { lines: 0, bytes: 0 };
  let lines = 1;
  for (let i = 0; i < csv.length; i++) if (csv.charCodeAt(i) === 10 && i < csv.length - 1) lines++;
  return { lines, bytes: new TextEncoder().encode(csv).length };
}

function Created() {
  const created = useWizardDraft((s) => s.created);
  const reset = useWizardDraft((s) => s.reset);
  if (created === null) return null;
  return (
    <Card>
      <CardContent className="space-y-4 text-sm">
        <h2 className="text-lg font-semibold">Recipients accepted</h2>
        <p>
          <strong>{created.recipientCount}</strong> {created.recipientCount === 1 ? "recipient" : "recipients"} in{" "}
          <strong>{created.batchCount}</strong> {created.batchCount === 1 ? "batch" : "batches"} for{" "}
          <strong>{created.name}</strong>. The operator holds the list now and this page has forgotten it, so it
          cannot be edited here. To use a different list, start a new campaign. Campaigns cannot be deleted yet, so
          this one stays in your list.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={reset}>
            Start a new campaign
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function RecipientsStep() {
  const navigate = useNavigate();
  const unit = useCoinUnit();
  const ids = { text: useId(), file: useId(), help: useId() };
  const fileInput = useRef<HTMLInputElement>(null);

  const created = useWizardDraft((s) => s.created);
  const name = useWizardDraft((s) => s.name);
  const feePolicy = useWizardDraft((s) => s.feePolicy);
  const maxOutputsPerBatch = useWizardDraft((s) => s.maxOutputsPerBatch);
  const csvText = useWizardDraft((s) => s.csvText);
  const csvFileName = useWizardDraft((s) => s.csvFileName);
  const { setCsv, campaignCreated } = useWizardDraft.getState();

  const { state, create, clearError } = useCreateCampaign();
  const [localProblem, setLocalProblem] = useState<string | null>(null);
  const creating = state.status === "creating";

  const size = useMemo(() => sizeOf(csvText), [csvText]);
  const basicsProblem = nameProblem(name) ?? batchSizeProblem(maxOutputsPerBatch);

  /** Change the CSV. The operator's old verdict (and ours) no longer applies to it. */
  function edit(text: string, fileName: string | null = null) {
    clearError();
    setLocalProblem(null);
    setCsv(text, fileName);
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > CSV_MAX_BYTES) {
      clearError();
      setLocalProblem("That file is larger than 32 MB, the most the operator accepts.");
      return;
    }
    try {
      edit(await file.text(), file.name);
    } catch {
      setLocalProblem("The file could not be read. Try pasting its contents instead.");
    }
  }

  async function submit() {
    const problem = csvProblem(csvText);
    if (problem !== null) {
      setLocalProblem(problem);
      return;
    }
    const campaign = await create({ name: name.trim(), csv: csvText, maxOutputsPerBatch, feePolicy });
    if (campaign !== null) {
      campaignCreated(campaign);
      void navigate("/new/auditor");
    }
  }

  const importFailure =
    state.status === "failed" &&
    state.error instanceof OperatorApiError &&
    state.error.api !== null &&
    state.error.api.code === "import_failed" &&
    "errors" in state.error.api
      ? state.error.api
      : null;

  return (
    <>
      <StepHeader
        slug="recipients"
        description="Who gets paid, and how much. This list goes to the operator on this computer and nowhere else."
      />

      {created !== null ? (
        <>
          <Created />
          <StepNav back="basics">
            <Button asChild>
              <Link to="/new/auditor">Next: Auditor</Link>
            </Button>
          </StepNav>
        </>
      ) : basicsProblem !== null ? (
        <Alert variant="warning" role="alert" className="space-y-2">
          <AlertTitle className="text-base">
            <h2>Finish the basics first</h2>
          </AlertTitle>
          <AlertDescription className="space-y-3 text-card-foreground">
            <p>{basicsProblem}</p>
            <Button asChild variant="outline" size="sm">
              <Link to="/new/basics">Back to the basics</Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <form
          className="space-y-6"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Card>
            <CardContent className="space-y-4">
              <div className="space-y-2 text-sm text-muted-foreground" id={ids.help}>
                <p>
                  One recipient per line, with a header row. The columns are <code className="font-mono">{HEADER_HINT}</code>
                  ; memo is optional, and the columns can be in any order. Amounts are in {unit}.
                </p>
                <p>
                  The list stays in this browser tab&apos;s memory. It is sent once, to the operator, when you check it
                  below, and this page forgets it as soon as the campaign is created. It is never saved in the browser.
                </p>
              </div>

              {csvFileName !== null ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                  <span>
                    <strong>{csvFileName}</strong>: {size.lines} {size.lines === 1 ? "line" : "lines"},{" "}
                    {formatBytes(size.bytes)}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      edit("");
                    }}
                    disabled={creating}
                  >
                    Remove file
                  </Button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor={ids.text}>Recipients (CSV)</Label>
                  <Textarea
                    id={ids.text}
                    value={csvText}
                    onChange={(e) => {
                      edit(e.target.value);
                    }}
                    rows={10}
                    spellCheck={false}
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    wrap="off"
                    className="font-mono text-xs"
                    placeholder={HEADER_HINT}
                    aria-describedby={ids.help}
                    disabled={creating}
                  />
                  {csvText.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {size.lines} {size.lines === 1 ? "line" : "lines"}, {formatBytes(size.bytes)}
                    </p>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <input
                  ref={fileInput}
                  id={ids.file}
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  // Hidden outright, not just visually: the button below opens it, so there is
                  // one control to tab to and nothing unlabelled for a screen reader to find.
                  className="hidden"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(e) => void onFile(e)}
                  disabled={creating}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInput.current?.click()}
                  disabled={creating}
                >
                  Choose a CSV file
                </Button>
              </div>
            </CardContent>
          </Card>

          {localProblem !== null && (
            <p role="alert" className="text-sm text-destructive">
              {localProblem}
            </p>
          )}
          {importFailure !== null && "errors" in importFailure ? (
            <ImportErrors errors={importFailure.errors} errorCount={importFailure.errorCount} />
          ) : (
            state.status === "failed" && <FailureNotice error={state.error} />
          )}

          <StepNav back="basics">
            <Button type="submit" disabled={creating}>
              {creating ? "Checking…" : "Check and create campaign"}
            </Button>
          </StepNav>
        </form>
      )}
    </>
  );
}
