import { findingMessage, isFailure, type ReceiptFinding } from "@/api/findings";

function Group({ title, note, findings }: { title: string; note: string; findings: readonly ReceiptFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-base font-bold">
        {title} ({findings.length})
      </h3>
      <p className="text-sm text-muted-foreground">{note}</p>
      <ul className="list-disc space-y-1.5 pl-5 text-base">
        {findings.map((finding, index) => (
          <li key={`${finding.code}-${String(index)}`}>{findingMessage(finding)}</li>
        ))}
      </ul>
    </div>
  );
}

/** What the verifier flagged, in the core's own sentences.
 *
 * Findings are split by meaning, not by colour: a failure says the numbers do
 * not add up; the rest say a fact is not established or final YET. Both are
 * shown, neither is hidden, and the wording never guesses at a cause. It sits
 * next to the verdict, under a rule, not behind a click. */
export function FindingsCard({ findings }: { findings: readonly ReceiptFinding[] }) {
  if (findings.length === 0) return null;
  const failures = findings.filter(isFailure);
  const open = findings.filter((f) => !isFailure(f));

  return (
    <section aria-labelledby="findings-heading" className="max-w-[64ch] space-y-5 border-l-4 border-foreground pl-5">
      <h2 id="findings-heading" className="text-xl font-bold tracking-tight">
        What the verifier found
      </h2>
      <p className="text-base">
        A finding means the verifier could not confirm part of this campaign from chain data. It says what could not be confirmed,
        not why, and not who is responsible.
      </p>
      <Group title="Needs attention" note="These do not add up, or are not valid, as the chain shows them." findings={failures} />
      <Group title="Not final yet" note="These may simply need more time, or another lookup." findings={open} />
    </section>
  );
}
