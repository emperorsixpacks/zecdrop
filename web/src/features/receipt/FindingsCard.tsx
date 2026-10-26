import { findingMessage, isFailure, type ReceiptFinding } from "@/api/findings";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function Group({
  title,
  note,
  findings,
}: {
  title: string;
  note: string;
  findings: readonly ReceiptFinding[];
}) {
  if (findings.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="font-medium">
        {title} ({findings.length})
      </h3>
      <p className="text-sm text-muted-foreground">{note}</p>
      <ul className="list-disc space-y-1.5 pl-5 text-sm">
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
 * shown, neither is hidden, and the wording never guesses at a cause. */
export function FindingsCard({ findings }: { findings: readonly ReceiptFinding[] }) {
  if (findings.length === 0) return null;
  const failures = findings.filter(isFailure);
  const open = findings.filter((f) => !isFailure(f));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          <h2>What the verifier found</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          A finding means the verifier could not confirm part of this campaign from chain data. It
          says what could not be confirmed, not why, and not who is responsible.
        </p>
        <Group
          title="Needs attention"
          note="These do not add up, or are not valid, as the chain shows them."
          findings={failures}
        />
        <Group
          title="Not final yet"
          note="These may simply need more time, or another lookup."
          findings={open}
        />
      </CardContent>
    </Card>
  );
}
