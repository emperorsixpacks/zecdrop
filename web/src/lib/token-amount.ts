// Amounts of other assets (the coins a funder might pay with through NEAR
// Intents), shown without floating point.
//
// The service reports an amount as an integer string in the asset's smallest
// unit, and the asset's number of decimals. Everything here is bigint, like the
// zatoshi code in zec.ts. These are PRICES for a preview or a quote, shown as
// "about"; they are not balances the campaign relies on.

const WHOLE = /^(0|[1-9][0-9]*)$/u;

export class TokenAmountError extends Error {
  override readonly name = "TokenAmountError";
}

/** Parse an amount as the service sends it: canonical digits, no sign, no point. */
export function parseSmallestUnits(raw: string): bigint {
  if (typeof raw !== "string" || !WHOLE.test(raw)) throw new TokenAmountError("not a whole number of smallest units");
  if (raw.length > 78) throw new TokenAmountError("too large"); // beyond 2^256
  return BigInt(raw);
}

/** `raw` smallest units of an asset with `decimals` decimals, as decimal text,
 * ROUNDED UP to at most `maxFraction` digits after the point: a price shown
 * must never be lower than the real one. Trailing zeros are dropped.
 *
 *   formatTokenAmount("1234567", 6)            -> "1.234567"
 *   formatTokenAmount("1234567", 6, 2)         -> "1.24"
 *   formatTokenAmount("1000000", 6)            -> "1"
 *   formatTokenAmount("1", 18, 6)              -> "0.000001"  (rounded up from 1e-18)
 */
export function formatTokenAmount(raw: string, decimals: number, maxFraction = 6): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new TokenAmountError("unsupported decimals");
  if (!Number.isInteger(maxFraction) || maxFraction < 0) throw new TokenAmountError("unsupported precision");
  let units = parseSmallestUnits(raw);
  let fraction = decimals;

  if (fraction > maxFraction) {
    const drop = 10n ** BigInt(fraction - maxFraction);
    units = (units + drop - 1n) / drop; // round up
    fraction = maxFraction;
  }

  const digits = units.toString().padStart(fraction + 1, "0");
  const whole = fraction === 0 ? digits : digits.slice(0, -fraction);
  const rest = fraction === 0 ? "" : digits.slice(-fraction).replace(/0+$/u, "");
  return rest.length === 0 ? whole : `${whole}.${rest}`;
}
