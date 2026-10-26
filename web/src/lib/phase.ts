// Campaign lifecycle phases and how the UI presents them.
//
// One metadata table is the single place a phase is described; the exported
// helpers read from it, so adding a phase is a compile error until every
// column is filled in.

export const CAMPAIGN_PHASES = [
  "draft",
  "awaiting_funding",
  "funded",
  "sending",
  "settled",
  "failed",
] as const;

export type CampaignPhase = (typeof CAMPAIGN_PHASES)[number];

/** The Badge variants a phase can map to. Declared here, not imported, so
 * lib/ never depends on components/; phase.test.ts proves each one exists. */
export type PhaseBadgeVariant =
  | "secondary"
  | "outline"
  | "shielded"
  | "default"
  | "done"
  | "destructive";

interface PhaseMeta {
  /** What a person reads. Plain words, no identifiers. */
  label: string;
  badge: PhaseBadgeVariant;
  /** No further transitions happen: polling can stop. */
  terminal: boolean;
}

const PHASE_META: Record<CampaignPhase, PhaseMeta> = {
  draft: { label: "Draft", badge: "secondary", terminal: false },
  awaiting_funding: { label: "Awaiting funding", badge: "outline", terminal: false },
  funded: { label: "Funded", badge: "shielded", terminal: false },
  sending: { label: "Sending", badge: "default", terminal: false },
  settled: { label: "Settled", badge: "done", terminal: true },
  failed: { label: "Failed", badge: "destructive", terminal: true },
};

export function phaseLabel(phase: CampaignPhase): string {
  return PHASE_META[phase].label;
}

export function phaseBadgeVariant(phase: CampaignPhase): PhaseBadgeVariant {
  return PHASE_META[phase].badge;
}

export function isTerminalPhase(phase: CampaignPhase): boolean {
  return PHASE_META[phase].terminal;
}

/** A phase together with the data some phases carry. This is the shape the
 * core reports: `sending` also says how many batches have reached the
 * required depth. Narrow on `state.phase`; the kind alone is a
 * {@link CampaignPhase}. */
export type PhaseState =
  | { phase: "draft" }
  | { phase: "awaiting_funding" }
  | { phase: "funded" }
  | { phase: "sending"; done: number; total: number }
  | { phase: "settled" }
  | { phase: "failed" };

/** Progress sentence for phases that have progress, otherwise null. */
export function phaseProgress(state: PhaseState): string | null {
  if (state.phase !== "sending") return null;
  return `${String(state.done)} of ${String(state.total)} batches confirmed`;
}

/** The full status sentence, word for word the core's `CampaignPhase::label`
 * (phase.test.ts compares them with the Rust source). */
export function phaseSentence(state: PhaseState): string {
  switch (state.phase) {
    case "draft":
      return "Draft";
    case "awaiting_funding":
      return "Waiting for funds";
    case "funded":
      return "Funded, ready to send";
    case "sending":
      return `Sending: ${String(state.done)} of ${String(state.total)} batches confirmed`;
    case "settled":
      return "Complete: all batches confirmed";
    case "failed":
      return "Needs attention: a batch failed";
  }
}
