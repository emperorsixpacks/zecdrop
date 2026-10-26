import { formatZec, parseZatoshi } from "@/lib/zec";

/** A ZIP-321 payment request, `zcash:<address>?amount=<ZEC>`, for a campaign's funding address.
 * A wallet app that handles `zcash:` links opens it with the address and amount filled in.
 *
 * It returns null rather than a link that could mislead: the address must be plain letters and
 * digits (all a Zcash address is made of, so nothing in it can add a query parameter) and the
 * amount a positive whole number of zatoshi. The amount is written as formatZec does, "0.00545",
 * which is the plain decimal ZIP-321 asks for. There is no memo: a transparent address takes none. */
export function fundingPaymentUri(address: string, zatoshi: string): string | null {
  if (!/^[A-Za-z0-9]{20,160}$/u.test(address)) return null;
  let amount: bigint;
  try {
    amount = parseZatoshi(zatoshi);
  } catch {
    return null;
  }
  if (amount === 0n) return null;
  return `zcash:${address}?amount=${formatZec(amount)}`;
}
