// What the service's swap statuses mean for a person, in plain words.
//
// The operator reports one of seven statuses (crates/drop-near/src/status.rs) as a
// lower-case word, or "unknown" when the service said something it has no word for,
// or something this page has never heard of. NONE of them means the campaign is
// funded. Not even "success": the campaign counts as funded only when the coin
// appears on chain at its address, at the required depth (REQ-FUND-002), and the
// operator decides that by looking at the chain, not by asking the service.

/** Shown wherever a swap is in progress. */
export const NEAR_FUNDED_ONLY_ON_CHAIN = "The campaign counts as funded only when the coin appears on chain.";

export type NearStatusTone = "waiting" | "working" | "check" | "problem" | "ended" | "unknown";

export interface NearStatusDescription {
  tone: NearStatusTone;
  title: string;
  detail: string;
  /** Whether it is worth asking again. Terminal states and the unknown one stop. */
  keepPolling: boolean;
}

/** The operator's words for the service's statuses. */
const KNOWN: Readonly<Record<string, NearStatusDescription>> = {
  pending_deposit: {
    tone: "waiting",
    title: "Waiting for the deposit",
    detail: "Nothing has arrived yet. Send the amount shown to the deposit address, before the deadline.",
    keepPolling: true,
  },
  known_deposit_tx: {
    tone: "working",
    title: "Deposit seen",
    detail: "The service has seen a deposit transaction and will start the swap. The campaign is not funded yet.",
    keepPolling: true,
  },
  processing: {
    tone: "working",
    title: "Swap in progress",
    detail: "The service is exchanging the deposit for ZEC. This can take a few minutes. The campaign is not funded yet.",
    keepPolling: true,
  },
  success: {
    tone: "check",
    title: "Paid to the deposit address, says the service",
    detail:
      "The service reports the ZEC went to the campaign's deposit address. That is its report, not proof. This page keeps checking the chain for the coin, and only then does the campaign count as funded.",
    keepPolling: true,
  },
  incomplete_deposit: {
    tone: "problem",
    title: "The deposit was smaller than quoted",
    detail:
      "Send the missing amount to the same address before the deadline, or wait for the service to return what was sent. The campaign has not been funded by this.",
    keepPolling: true,
  },
  refunded: {
    tone: "ended",
    title: "Refunded",
    detail: "The swap did not go through and the service returned the deposit. The campaign has not been funded by it.",
    keepPolling: false,
  },
  failed: {
    tone: "ended",
    title: "The swap failed",
    detail:
      "The service could not complete it, and the campaign has not been funded by it. If something was sent, ask the service about a refund.",
    keepPolling: false,
  },
};

const MAX_SHOWN = 40;

/** Describe the service's status word. An unknown one is never treated as
 * progress: it says to investigate, shows the word the service used (clipped,
 * as text), and stops asking. */
export function describeNearStatus(status: string): NearStatusDescription {
  if (Object.hasOwn(KNOWN, status)) return KNOWN[status] as NearStatusDescription;
  if (status === "unknown") {
    return {
      tone: "unknown",
      title: "The service reported something this page does not know",
      detail:
        "The operator has no word for the state the service reported. Do not send more until you know what that means: look at the operator's terminal and at the service's own status page. The campaign has not been funded by this.",
      keepPolling: false,
    };
  }
  const shown = status.length > MAX_SHOWN ? `${status.slice(0, MAX_SHOWN)}…` : status;
  return {
    tone: "unknown",
    title: "The service reported something this page does not know",
    detail: `It said "${shown}". Do not send more until you know what that means: look at the operator's terminal and at the service's own status page. The campaign has not been funded by this.`,
    keepPolling: false,
  };
}

/** The statuses this page has a sentence for, for tests. */
export const KNOWN_NEAR_STATUSES: readonly string[] = Object.keys(KNOWN);
