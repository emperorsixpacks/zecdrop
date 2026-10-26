import type { StreamStatus } from "@/api/operator/events";
import type { ProgressEvent } from "@/api/operator/schemas";
import { describeEvent } from "@/features/operator/messages";

const STATUS_TEXT: Record<StreamStatus, string> = {
  connecting: "Connecting to the operator…",
  open: "Live: updates appear as they happen.",
  reconnecting: "The connection dropped. Trying again…",
  finished: "Finished: the operator has nothing more to report.",
  stopped: "Stopped: the operator would not give updates for this campaign.",
};

interface ActivityLogProps {
  log: readonly ProgressEvent[];
  status: StreamStatus;
  unreadable: number;
}

/** What the engine reports as it works, in plain words. The events carry batch
 * numbers, counts and transaction ids: never anything about a recipient. */
export function ActivityLog({ log, status, unreadable }: ActivityLogProps) {
  return (
    <div className="max-w-[64ch] space-y-3">
      <p className="text-base text-muted-foreground" data-testid="stream-status">
        {STATUS_TEXT[status]}
      </p>
      {unreadable > 0 && (
        <p className="text-base text-problem">
          {unreadable === 1 ? "1 update" : `${String(unreadable)} updates`} could not be read and{" "}
          {unreadable === 1 ? "was" : "were"} skipped. The batch list is still correct.
        </p>
      )}
      {log.length === 0 ? (
        <p className="text-base text-muted-foreground">No activity yet. Updates from the operator show up here while the payout runs.</p>
      ) : (
        // The scrollable region takes focus so a keyboard user can scroll it; the
        // list inside keeps its list semantics (role="log" on the <ol> itself would drop them).
        <div role="log" aria-label="Activity log" tabIndex={0} className="max-h-72 overflow-y-auto rounded-lg text-base outline-none">
          <ol className="space-y-1">
            {log.map((event, index) => (
              <li key={`${String(index)}-${event.event}`}>{describeEvent(event)}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
