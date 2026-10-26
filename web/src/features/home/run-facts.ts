// The figures the home page prints on its receipt that are not in the real run's own receipt. Every one was measured: the run's
// date and the time it took to settle are docs/LEARNINGS.md's (2026-10-08, create to settled in about 2 minutes); the limits are
// docs/BENCHMARKS.md's (measured offline on 2026-10-18). There is no mainnet figure, because there has been no mainnet payout.

/** The day of the real run. */
export const RUN_DATE = "8 Oct 2026";

/** From creating the campaign to its batch settling, on that run. */
export const RUN_SETTLE = "about 2 min";

/** The most payouts one transaction can carry (ZIP-218), how long making that transaction took on a laptop (proof and
 * signature), and how long checking it takes. */
export const LIMITS = { measured: "18 Oct 2026", mostPayouts: "330", prove: "142 s", check: "0.52 s" } as const;
