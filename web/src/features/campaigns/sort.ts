import type { OperatorCampaignSummary } from "@/api/operator/schemas";

/** Newest first; ties by name so the order is stable. (The operator returns
 * campaigns created in the same second in no particular order.) */
export function sortCampaigns(list: readonly OperatorCampaignSummary[]): OperatorCampaignSummary[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
}
