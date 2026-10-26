import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useCoinUnit } from "@/lib/units";

import { describeNearFailure } from "./failure";

interface NearFailureProps {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
}

/** A failed NEAR call, in words, with a retry when trying again can help. */
export function NearFailure({ error, onRetry, retrying = false }: NearFailureProps) {
  const { title, detail } = describeNearFailure(error, useCoinUnit());
  return (
    <Alert variant="warning" role="alert" className="space-y-2">
      <AlertTitle className="text-base">
        <h3>{title}</h3>
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
