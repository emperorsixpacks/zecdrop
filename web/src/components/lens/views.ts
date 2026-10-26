// The views of the redaction lens (Lens.tsx): who is looking, and so what they see (docs/PRIVACY_BOUNDARY.md). Apart from the
// component so that the page can be refreshed while it is being worked on.

export type LensMode = "public" | "recipient" | "auditor" | "payer";

/** One way of seeing the list: its name on the switch and the sentence read out when it is chosen. */
export interface LensView {
  mode: LensMode;
  label: string;
  caption: string;
}

/** The switch everywhere but the home page: the public, one person and the auditor. */
export const THREE_VIEWS: readonly LensView[] = [
  { mode: "public", label: "Public", caption: "What anyone can see." },
  { mode: "recipient", label: "One person", caption: "What that person can see." },
  { mode: "auditor", label: "Auditor", caption: "What someone with the viewing key sees." },
];

/** One payout, four views (the home page): who holds what decides what they see. */
export const FOUR_VIEWS: readonly LensView[] = [
  { mode: "public", label: "Everyone", caption: "What anyone can check from the chain, with no key." },
  { mode: "recipient", label: "One person", caption: "What one person paid sees: their own line, which their payslip proves." },
  { mode: "auditor", label: "Auditor", caption: "What the auditor you choose sees, with this payout's viewing key." },
  { mode: "payer", label: "You", caption: "What you see as the payer, on your own computer." },
];
