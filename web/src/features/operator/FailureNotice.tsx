import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import { useCoinUnit } from "@/lib/units";

import { explainFailure } from "./messages";

interface FailureNoticeProps {
  error: unknown;
  /** Offered when trying again could help. */
  onRetry?: () => void;
  retrying?: boolean;
}

/** What went wrong with an operator call, in words, with a retry when it helps. */
export function FailureNotice({ error, onRetry, retrying = false }: FailureNoticeProps) {
  const { title, detail } = explainFailure(error, useCoinUnit());
  return (
    <Alert variant="warning" role="alert" className="space-y-2">
      <AlertTitle className="text-base">
        <h2>{title}</h2>
      </AlertTitle>
      <AlertDescription className="space-y-3 text-card-foreground">
        <p>{detail}</p>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
            {retrying ? "Trying again…" : "Try again"}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
