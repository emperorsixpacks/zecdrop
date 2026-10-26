import { useHealth } from "./hooks";
import { explainFailure } from "./messages";

/** A strip under the header on every operator page.
 *
 * On the mock chain it says so, persistently: nothing here reaches Zcash, and a
 * person must never mistake a simulation for a real payout. It is `sticky`, so
 * it stays in view while scrolling, and it is a status region, so it is read out
 * when it appears.
 *
 * The strip rests on what the operator says in /api/health and nothing else.
 * If it does not say (no `mock` field), no development control is shown and the
 * strip says that it did not say, rather than guessing either way. */
export function OperatorStatusBar() {
  const health = useHealth();

  if (health.data?.mock === true) {
    return (
      <div role="status" className="sticky top-0 z-40 border-b border-link/40 bg-background">
        <div className="bg-primary/15">
          <p className="mx-auto w-full max-w-5xl px-5 py-2 text-sm">
            <strong>Mock chain:</strong> nothing is sent to Zcash. Funding, transactions and confirmations here are
            simulated.
          </p>
        </div>
      </div>
    );
  }

  if (health.data?.mock === null) {
    return (
      <div role="status" className="border-b bg-muted">
        <p className="mx-auto w-full max-w-5xl px-5 py-2 text-sm">
          This operator did not say whether it is on the mock chain, so development controls are hidden.
        </p>
      </div>
    );
  }

  if (health.isError) {
    const { title, detail } = explainFailure(health.error);
    return (
      <div role="status" className="border-b bg-muted">
        <p className="mx-auto w-full max-w-5xl px-5 py-2 text-sm">
          <strong>{title}.</strong> {detail}
        </p>
      </div>
    );
  }

  return null;
}
