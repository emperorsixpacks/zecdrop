// What the Payslips section of a settled campaign says (REQ-PAY-005), and how long it shows the payslips.

/** How long the payslips stay on the page once shown. */
export const PAYSLIPS_VISIBLE_MS = 10 * 60_000;

export const PAYSLIPS_WORDING = {
  lead: "Each person can prove their payment with their payslip.",
  warningTitle: "Send each payslip only to its person",
  warning: "A payslip shows one payout's address, amount and note to whoever has it, and lets them present it as their own.",
  mock: "The practice chain has no real transaction to prove, so there are no payslips here. On a real payout, each person's payslip is here.",
  missing: "No payslip: this payout is not in the transaction. Run the audit.",
  hidden: "Payslips are hidden again after ten minutes, and when you leave this page.",
} as const;
