// Checks the wizard can do before asking the operator, mirroring the operator's
// own rules so people get an answer as they type. The operator still validates
// everything (and is the authority); these only save a round trip.

import { MAX_BATCH_SIZE, MIN_BATCH_SIZE } from "@/lib/fees";

/** The largest CSV the operator accepts: drop_core::import::MAX_IMPORT_BYTES. */
export const CSV_MAX_BYTES = 32 * 1024 * 1024;

const NAME_MAX_CHARS = 100;

/** Why a campaign name is not acceptable, or null if it is. Mirrors the
 * operator: 1 to 100 characters, no control characters, after trimming. */
export function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Give the campaign a name.";
  if ([...trimmed].length > NAME_MAX_CHARS) return `Use at most ${String(NAME_MAX_CHARS)} characters.`;
  // eslint-disable-next-line no-control-regex -- detecting control characters is the point
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)) return "Remove control characters from the name.";
  return null;
}

/** Why a batch size is not acceptable, or null. */
export function batchSizeProblem(size: number): string | null {
  if (!Number.isInteger(size)) return "Enter a whole number.";
  if (size < MIN_BATCH_SIZE) {
    return `A batch needs at least ${String(MIN_BATCH_SIZE)} payouts: a batch of one would reveal that person's amount.`;
  }
  if (size > MAX_BATCH_SIZE) return `At most ${String(MAX_BATCH_SIZE)} payouts fit in one transaction.`;
  return null;
}

/** Why the CSV text cannot be sent yet, or null. Says nothing about its content. */
export function csvProblem(csv: string): string | null {
  if (csv.trim().length === 0) return "Add the recipients: paste a CSV or choose a file.";
  if (new TextEncoder().encode(csv).length > CSV_MAX_BYTES) return "That file is larger than 32 MB, the most the operator accepts.";
  return null;
}
