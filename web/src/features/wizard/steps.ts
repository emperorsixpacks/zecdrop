export interface WizardStep {
  slug: string;
  label: string;
  /** What the step is for, in one line. */
  summary: string;
}

export const WIZARD_STEPS: readonly WizardStep[] = [
  {
    slug: "basics",
    label: "Basics",
    summary: "Name the campaign, choose the network fee and the batch size.",
  },
  {
    slug: "recipients",
    label: "Recipients",
    summary: "Add the recipients as a CSV. They go to the operator on this computer and nowhere else.",
  },
  {
    slug: "auditor",
    label: "Auditor",
    summary: "Optionally give an auditor the viewing key. This cannot be undone.",
  },
  {
    slug: "review",
    label: "Review",
    summary: "Check the totals, the fee, the manifest commitment and the privacy warnings.",
  },
  {
    slug: "fund",
    label: "Fund & Send",
    summary: "Fund the campaign, then start sending the batches.",
  },
];

export function stepIndex(slug: string | undefined): number {
  return WIZARD_STEPS.findIndex((s) => s.slug === slug);
}
