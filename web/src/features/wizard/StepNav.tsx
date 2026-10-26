import type { ReactNode } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";

import { WIZARD_STEPS } from "./steps";

interface StepNavProps {
  /** Slug of the previous step, if there is one. */
  back?: string;
  /** The step's own forward action(s). */
  children?: ReactNode;
}

/** Back on the left, the step's own forward action on the right. */
export function StepNav({ back, children }: StepNavProps) {
  const previous = WIZARD_STEPS.find((s) => s.slug === back);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
      {previous ? (
        <Button asChild variant="outline">
          <Link to={`/new/${previous.slug}`}>Back: {previous.label}</Link>
        </Button>
      ) : (
        <span />
      )}
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}
