import type { ReactNode } from "react";

import { PageHeader } from "@/components/PageHeader";

import { stepIndex, WIZARD_STEPS } from "./steps";

/** Page title for one wizard step: "Recipients" with "New campaign, step 2 of 5"
 * above it. Each step is its own page, so each has exactly one h1. */
export function StepHeader({ slug, description }: { slug: string; description?: ReactNode }) {
  const index = stepIndex(slug);
  const step = WIZARD_STEPS[index];
  if (!step) return null;
  return (
    <PageHeader
      kicker={`New campaign, step ${String(index + 1)} of ${String(WIZARD_STEPS.length)}`}
      title={step.label}
      {...(description === undefined ? {} : { description })}
    />
  );
}
