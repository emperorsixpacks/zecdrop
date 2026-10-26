/** What the header capsule calls the page an address points at, in a word or three.
 *
 * It reads the address the way the router does (a trailing slash and capital letters change nothing). The operator's
 * pages have a name only where there is an operator: on a hosted, public copy those addresses show a notice instead of
 * the page, and calling the notice "Payouts" would be wrong. Anything else is the name of the site. */
export function pageName(pathname: string, operator: boolean): string {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/u, "").toLowerCase() : pathname;

  if (path === "/") return "Home";
  if (path.startsWith("/r/")) return "Receipt";
  if (path === "/get-paid") return "Get paid";
  if (path === "/payslip") return "Payslip";
  if (path === "/privacy") return "How privacy works";
  if (path === "/start") return "Make a payout";

  if (operator) {
    if (path === "/campaigns") return "Payouts";
    if (path === "/new" || path.startsWith("/new/")) return "New payout";
    if (path.startsWith("/campaign/")) return "Payout";
    if (path === "/audit") return "Audit";
  }
  return "ZecDrop";
}
