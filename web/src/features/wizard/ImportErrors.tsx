import { useEffect, useRef } from "react";

import type { RowError } from "@/api/operator/schemas";

interface ImportErrorsProps {
  errors: readonly RowError[];
  /** How many problems there are in total (the operator reports at most 200). */
  errorCount: number;
}

/** The problems the operator found in the CSV, by line number.
 *
 * It shows a line number and the operator's sentence, and NOTHING from the file:
 * the sentences are fixed text plus numbers, and this component has no access
 * to the CSV. Focus moves here when it appears, so a screen reader announces it. */
export function ImportErrors({ errors, errorCount }: ImportErrorsProps) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, [errors]);

  return (
    <div
      ref={box}
      tabIndex={-1}
      role="alert"
      className="space-y-3 rounded-lg border border-link/40 bg-primary/10 p-4 outline-none"
    >
      <h3 className="text-base font-semibold">
        {errorCount === 1 ? "1 problem in the CSV" : `${String(errorCount)} problems in the CSV`}
      </h3>
      <p className="text-sm">Nothing was created. Fix these lines and check again.</p>
      <ul className="space-y-1.5 text-sm">
        {errors.map((error, index) => (
          <li key={`${String(error.line)}-${error.code}-${String(index)}`}>
            <strong>Line {error.line}:</strong> {error.message}
          </li>
        ))}
      </ul>
      {errorCount > errors.length && (
        <p className="text-sm text-muted-foreground">
          Showing the first {errors.length} of {errorCount}. Fix these, then check again to see the rest.
        </p>
      )}
    </div>
  );
}
