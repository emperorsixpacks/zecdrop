import type { PayslipFailureKind } from "@/api/payslip";
import type { PayslipAnswer, PayslipInvalidReason } from "@/api/payslip-answer";
import type { ZecNetwork } from "@/lib/config";

// What the payslip page says about an answer. It follows docs/PRIVACY_BOUNDARY.md ("Payslips") and
// says only what the check established: that one output of one transaction pays the receiver and the
// amount the payslip states. It never says who the receiver is, that the funds are unspent, or
// anything about another output. copy.test.tsx bans the phrases that would say more.

/** What the page shows of the payslip itself, next to the verdict: the amount and a short receiver, as
 * the payslip states them. Neither is in the verifier's answer, and the secret is never shown. */
export interface Stated {
  value: string;
  receiver: string;
}

/** Why an invalid payslip does not verify, in one sentence. None says which part of the payslip was wrong. */
export const INVALID_TEXT: Record<PayslipInvalidReason, string> = {
  does_not_match: "This payslip does not match what that output of the transaction holds.",
  no_such_action: "That transaction has no shielded output at the position the payslip names.",
  malformed_note: "This payslip does not describe a valid shielded note.",
  tx_unparseable: "The verifier could not read that transaction.",
  no_ironwood_outputs: "That transaction has no shielded outputs of the kind a payslip covers.",
  unsupported_version: "This verifier does not read this version of the payslip.",
  txid_mismatch: "The transaction the verifier fetched is not the one this payslip names.",
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The heading and the sentences for an answer. */
export function wording(answer: PayslipAnswer): { heading: string; lines: string[] } {
  const { outcome, network, action, requiredDepth } = answer;
  const pays = `Action ${String(action)} of this transaction pays the receiver and amount this payslip states.`;
  switch (outcome.verdict) {
    case "verified":
      return { heading: "Verified", lines: [pays, "It proves that one output, and nothing about any other."] };
    case "pending":
      return {
        heading: "Matches, not final yet",
        lines: [
          pays,
          `But the transaction has ${String(outcome.confirmations)} of the ${String(requiredDepth)} ${plural(requiredDepth, "confirmation", "confirmations")} the verifier waits for. Check again in a few minutes.`,
        ],
      };
    case "not_found":
      return {
        heading: "Transaction not found",
        lines: [
          `This verifier cannot find that transaction on ${network}.`,
          "It may not be mined yet, or the payslip may name another network. Try again in a few minutes.",
        ],
      };
    case "invalid":
      return { heading: "Not verified", lines: [INVALID_TEXT[outcome.reason]] };
  }
}

/** What each way of not getting an answer means. Calm on purpose: none of these says anything about the payslip. */
export const FAILURE_TEXT: Record<PayslipFailureKind, (network: ZecNetwork) => { title: string; text: string }> = {
  unreachable: () => ({
    title: "The verifier can't be reached right now",
    text: "No answer came back. The verifier may be busy or offline, it may not offer payslip checks, or your connection may have dropped. Try again in a moment.",
  }),
  rejected: () => ({
    title: "The verifier did not accept this payslip",
    text: "It refused the request as not a payslip it reads, so there is no result. Check that you pasted the whole file.",
  }),
  network_not_served: (network) => ({
    title: `This verifier does not serve ${network}`,
    text: `It is not set up to read the ${network} chain, so there is no result. You can check the payslip offline instead.`,
  }),
  too_large: () => ({
    title: "The verifier says the request is too large",
    text: "A payslip is a few hundred bytes, so this should not happen. There is no result.",
  }),
  chain_unavailable: () => ({
    title: "The verifier can't read the chain right now",
    text: "Its source of chain data is unavailable, or gave an answer that does not add up, so there is no result. Try again shortly.",
  }),
  invalid_response: () => ({
    title: "The verifier's answer wasn't in the expected format",
    text: "For your safety this page only shows answers in the published format. This one was not, so there is no result. Try again later.",
  }),
};
