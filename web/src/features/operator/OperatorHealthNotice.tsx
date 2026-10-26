import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import { useHealth } from "./hooks";
import { explainFailure } from "./messages";

/** When the operator cannot be asked what it is: a notice at the top of the page,
 * in the flow (it never floats over content). The practice-mode state itself is
 * the pill in the header, which rests on what the operator says in /api/health and
 * nothing else; if it says nothing about `mock`, no practice control is shown. */
export function OperatorHealthNotice() {
  const health = useHealth();
  if (!health.isError) return null;
  const { title, detail } = explainFailure(health.error);
  return (
    <Alert variant="warning" role="status" className="mb-8">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{detail}</AlertDescription>
    </Alert>
  );
}
