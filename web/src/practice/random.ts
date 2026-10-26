import { browserRandom, practiceId, type RandomBytes } from "@/lib/practice-mode";

export { browserRandom, type RandomBytes };

/** 64 hex characters that begin with the practice marker: a transaction id or a list fingerprint that is on no chain. */
export const practiceHex32 = (random: RandomBytes): string => practiceId(random);

/** "practice-" and six hex characters: an id the real operator's route and the page's own check both accept. */
export function practiceCampaignId(random: RandomBytes): string {
  return `practice-${Array.from(random(3), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
