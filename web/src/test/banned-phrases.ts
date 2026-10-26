// Claims this project must not make, as patterns. Every page's text, and every
// sentence the code can produce about a payout or a funding, is checked against
// these (copy.test.tsx, and the NEAR panel's own copy test).
//
// The public can see how much entered the shielded pool, in how many outputs, at
// what fee. It cannot see that the money reached different people, and it must
// not be told that it did (docs/PRIVACY_BOUNDARY.md). A swap service cannot make
// a campaign funded either: only the coin on chain does.

/** Each pattern is a claim this project must not make. */
export const BANNED: [label: string, pattern: RegExp][] = [
  ["verified payouts", /verified\s+payouts?/iu],
  ["everyone was paid", /everyone\s+(was|were|got|has\s+been|had\s+been)\s+paid/iu],
  ["paid out exactly", /paid\s+out\s+exactly/iu],
  ["paid exactly", /paid\s+exactly/iu],
  ["all recipients were paid", /all\s+(recipients|payouts)\s+(were|was|have\s+been)\s+(paid|received|sent)/iu],
  ["payouts confirmed/verified", /payouts?\s+(confirmed|verified|completed)/iu],
  ["money reached the recipients", /(money|funds|value|payments?)\s+(has\s+|have\s+)?reached\s+(the\s+)?(recipients|everyone|all|each)/iu],
  ["we verified the money", /verif(y|ies|ied)\s+(that\s+)?(the\s+)?(money|funds|payments?)\s+(reached|was|were|went)/iu],
  ["guaranteed", /guarantee[sd]?\b/iu],

  // Funding from another asset (NEAR Intents): a swap is a service's promise, not a fact on the chain.
  ["swap guaranteed", /swap\s+(is\s+|will\s+be\s+)?guaranteed/iu],
  ["instant", /\binstant(ly)?\b/iu],
  ["trustless", /trustless/iu],
  ["risk free", /risk[-\s]?free|no\s+risk\b|without\s+risk/iu],
  ["automatically funded", /(automatically|auto-?matically)\s+(funds?|funded)/iu],
  ["funded once the service says so", /funded\s+(as\s+soon\s+as|once|when)\s+(the\s+)?(service|swap|near)/iu],
  ["the swap funds the campaign", /(swap|service|near)\s+(has\s+|will\s+)?(funds?|funded)\s+(the|your)\s+campaign/iu],
  ["safe and secure", /\b(safe|secure)\s+(swap|exchange|funding|transfer)/iu],

  // Where a deposit came from (REQ-FUND-004, REQ-VER-007): a deposit from a shielded balance names no address. Its amount and
  // its time are public, and nothing here can say who paid, so nothing may claim the payer is hidden or untraceable.
  ["untraceable", /untraceable|\b(cannot|can't|can\s+not)\s+be\s+(traced|linked)|impossible\s+to\s+(trace|link)/iu],
  ["anonymous payer", /anonymous(ly)?\s+(payer|deposit|funder|funding|payment|donor)|(payer|funder|sender|donor)\s+(is|stays|remains)\s+anonymous/iu],
  ["the payer is hidden", /hides?\s+(who\s+(paid|funded|sent)|the\s+(payer|funder|sender))|(payer|funder|sender)\s+(is|stays|remains)\s+(hidden|private|invisible|secret)/iu],
  ["nobody can see who paid", /(no\s*one|nobody)\s+(can|could|will)\s+(see|tell|know|find\s+out)\s+who\s+(paid|funded|sent)/iu],
];
