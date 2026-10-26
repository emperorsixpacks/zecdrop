import { Badge } from "@/components/ui/badge";
import { phaseBadgeVariant, phaseLabel, phaseSentence, type PhaseState } from "@/lib/phase";

/** The phase as a badge, with the full sentence for assistive technology. */
export function PhaseBadge({ phase }: { phase: PhaseState }) {
  return (
    <Badge variant={phaseBadgeVariant(phase.phase)} title={phaseSentence(phase)}>
      {phaseLabel(phase.phase)}
    </Badge>
  );
}
