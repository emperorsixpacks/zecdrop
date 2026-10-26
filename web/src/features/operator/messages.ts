// Plain-language wording for what the operator reports. Pure functions, no
// React, so every sentence is testable. None of them can contain recipient data:
// the inputs (error codes, run states, progress events) have no field for it.

import { OperatorApiError } from "@/api/operator/client";
import type { ProgressEvent, RunState } from "@/api/operator/schemas";
import { config } from "@/lib/config";
import { MAX_BATCH_SIZE } from "@/lib/fees";
import { coinUnit, type CoinUnit } from "@/lib/units";
import { zecFromZatoshi } from "@/lib/zec";

export interface Explained {
  title: string;
  detail: string;
}

/** Where the page is not told otherwise, the unit of the network it was built for. */
const DEFAULT_UNIT: CoinUnit = coinUnit(config.network);

const amount = (zatoshi: string, unit: CoinUnit) => `${zecFromZatoshi(zatoshi)} ${unit}`;

/** What went wrong with an operator call, and what to do about it. */
export function explainFailure(error: unknown, unit: CoinUnit = DEFAULT_UNIT): Explained {
  if (!(error instanceof OperatorApiError)) {
    return {
      title: "Something went wrong",
      detail: "Try again. If it keeps happening, look at the operator's terminal for details.",
    };
  }
  switch (error.kind) {
    case "no_token":
    case "unauthorized":
      return {
        title: "The operator link is no longer valid",
        detail: "Open the link printed in the operator's terminal again. It changes every time the operator starts.",
      };
    case "unreachable":
      return {
        title: "Can't reach the operator",
        detail: "Check that it is still running on this computer, then try again.",
      };
    case "invalid_response":
      return {
        title: "The operator answered in a way this page does not understand",
        detail: "The page and the operator may be different versions. Rebuild the page and restart the operator.",
      };
    case "api":
      return explainApi(error, unit);
  }
}

/** What to say about an error the page has no sentence for, or that carried no
 * envelope at all: chosen by HTTP status, never a crash and never a raw code. */
export function explainStatus(status: number | null, reason?: string): Explained {
  const said = reason !== undefined && reason !== "" ? reason : null;
  if (status === 400 || status === 413 || status === 415) {
    return {
      title: "The operator did not accept this request",
      detail: said ?? "The page sent something the operator could not use. The page and the operator may be different versions.",
    };
  }
  if (status === 403) {
    return { title: "The operator refused this", detail: said ?? "It is not allowed from this page or address." };
  }
  if (status === 404) return { title: "Not found", detail: said ?? "The operator has nothing at that address." };
  if (status === 421) {
    return {
      title: "The operator does not accept this address",
      detail: said ?? "Open the link the operator printed in its terminal; it uses the address the operator expects.",
    };
  }
  if (status === 409 || status === 422) {
    return { title: "The operator can't do that", detail: said ?? "It refused the request as it stands." };
  }
  if (status !== null && status >= 500) {
    return { title: "The operator hit a problem", detail: said ?? "Its terminal has details. Try again in a moment." };
  }
  return { title: "The operator refused this", detail: said ?? "No reason was given." };
}

function explainApi(error: OperatorApiError, unit: CoinUnit): Explained {
  const api = error.api;
  if (api === null) return explainStatus(error.status);

  switch (api.code) {
    case "not_found":
      return { title: "Not found", detail: "The operator has no such campaign. It may have been created in a different store." };
    case "not_funded":
      return { title: "Funding comes first", detail: "Record the funding deposit before this step." };
    case "insufficient_funding":
      if ("required" in api && "observed" in api && api.required !== undefined && api.observed !== undefined) {
        return {
          title: "The deposit is too small",
          detail: `The campaign needs ${amount(api.required, unit)} (the total plus fees). This deposit is ${amount(api.observed, unit)}.`,
        };
      }
      return { title: "The deposit does not cover this campaign", detail: api.message };
    case "funding_conflict":
      if ("recorded" in api) {
        return {
          title: "Different funding is already recorded",
          detail: `This campaign already has a deposit of ${amount(api.recorded.amount, unit)}. It cannot be changed.`,
        };
      }
      return { title: "Different funding is already recorded", detail: api.message };
    case "invalid_name":
      return { title: "That name can't be used", detail: api.message };
    case "plan_failed":
      return { title: "That batch size can't be used", detail: "Pick a batch size between 2 and 330 payouts." };
    case "batch_size_too_large":
      return {
        title: "That batch size is too large",
        detail: `One transaction can pay at most ${String(MAX_BATCH_SIZE)} recipients. Choose a smaller batch size.`,
      };
    case "amount_too_large":
      return { title: "An amount is too large", detail: "The totals would exceed the most Zcash that can exist. Check the amounts." };
    case "csv_too_large":
    case "body_too_large":
      return { title: "The file is too large", detail: "The operator accepts files up to 32 MB." };
    case "import_failed":
      return { title: "The CSV has problems", detail: "Fix the lines listed, then try again." };
    case "store_corrupt":
      // The operator checks each stored row; a row edited outside the operator is refused, not believed.
      return {
        title: "The operator's store failed its integrity check",
        detail:
          "Its data was damaged or changed outside the operator, so nothing was done with it. Restore the store from a backup.",
      };
    case "host_not_allowed":
      // A defence against DNS rebinding: the operator answers only to its own loopback names and port.
      return {
        title: "The operator does not accept this address",
        detail:
          "Open the link the operator printed in its terminal. It uses localhost or 127.0.0.1 and the operator's own port; another name for this computer is refused on purpose.",
      };
    case "account_registry_error":
      // The operator words its reason itself (fixed text, nothing secret) and says no campaign was made.
      return {
        title: "The campaign's account could not be set up",
        detail: `${api.message}. The operator's terminal has more detail.`,
      };
    case "invalid_outpoint":
      return {
        title: "That output index is too large",
        detail: "The mock deposit is read as a run of outputs, one per batch, starting at this index. Use a smaller index, such as 0.",
      };
    case "needs_funding_split":
      return {
        title: "On a real chain this build sends one batch per campaign",
        detail:
          "Several batches would need a transaction that splits the deposit first, and that is not built yet. Use a batch size of 330 (the most there is) or fewer recipients, so everyone fits in one batch.",
      };
    case "wrong_wallet_seed":
      return {
        title: "This campaign belongs to a different wallet",
        detail:
          "It was created with a different wallet seed than the one the operator is using now, so it can't be funded, started or exported from here. Start the operator with the original wallet.",
      };
    case "chain_unavailable":
      return {
        title: "The operator can't reach its Zcash node",
        detail: "Its chain data source is not answering. Try again in a moment.",
      };
    case "not_applicable":
      return {
        title: "Nothing to check on the mock chain",
        detail: "The mock chain has no funding address. Record the pretend deposit instead.",
      };
    case "not_available":
      return {
        title: "Not available on the mock chain",
        detail: "The mock chain has no real viewing keys.",
      };
    case "confirmation_required":
      return {
        title: "Confirm first",
        detail: "The viewing key is released only after you confirm that it shows every payout, for good.",
      };
    case "dev_only":
      return { title: "Only available on the mock chain", detail: "On a real chain, funding is observed from the chain itself." };
    case "invalid_body":
    case "unsupported_media_type":
    case "unreadable_body":
      return {
        title: "The page sent something the operator did not understand",
        detail: "This is a bug in the page or a version mismatch. Rebuild the page and restart the operator.",
      };
    case "internal_error":
      return { title: "The operator hit an internal error", detail: "Its terminal has details. Nothing was sent twice." };
    default:
      // A code this page does not know: the operator is probably newer. Its own words, under a heading chosen by status.
      return explainStatus(error.status, api.message);
  }
}

// ---- runs ----------------------------------------------------------------------------

export interface RunDescription {
  label: string;
  detail: string;
  /** Whether a "start" or "resume" action makes sense. */
  canStart: boolean;
  /** The button text when it does. */
  action: string;
}

export function describeRun(run: RunState): RunDescription {
  switch (run.state) {
    case "idle":
      return { label: "Not started", detail: "Nothing has been sent yet.", canStart: true, action: "Start sending" };
    case "running":
      return { label: "Sending", detail: "Progress updates here as it happens.", canStart: false, action: "" };
    case "settled":
      return { label: "Done", detail: "Every batch is confirmed.", canStart: false, action: "" };
    case "halted":
      return {
        label: "Stopped",
        detail: "Some batches failed and cannot be retried automatically. They need attention.",
        canStart: false,
        action: "",
      };
    case "stalled":
      return {
        label: "Paused after repeated errors",
        detail: `The last error was: ${run.error} Start again to retry; nothing is built twice.`,
        canStart: true,
        action: "Try again",
      };
    case "crashed":
      return {
        label: "Stopped unexpectedly",
        detail: "Starting again resumes from where it stopped. A transaction that was already built is re-sent, never built a second time.",
        canStart: true,
        action: "Resume sending",
      };
  }
}

// ---- progress events -------------------------------------------------------------------

/** One line for the activity log. Batch numbers are 0-based, as in the core. */
export function describeEvent(event: ProgressEvent): string {
  switch (event.event) {
    case "built":
      return `Batch ${String(event.batchIndex)}: transaction built (${String(event.outputs)} shielded outputs).`;
    case "broadcast":
      return `Batch ${String(event.batchIndex)}: sent to the network.`;
    case "confirmed":
      return `Batch ${String(event.batchIndex)}: ${String(event.depth)} of ${String(event.requiredDepth)} confirmations.`;
    case "waiting":
      return `Batch ${String(event.batchIndex)}: waiting for the next block (${String(event.observedDepth)} of ${String(event.requiredDepth)} confirmations).`;
    case "failed":
      return `Batch ${String(event.batchIndex)}: failed. ${event.reason}`;
    case "halted":
      return `Stopped: ${event.failedBatches.length === 1 ? "batch" : "batches"} ${event.failedBatches.join(", ")} failed and ${event.failedBatches.length === 1 ? "needs" : "need"} attention.`;
    case "settled":
      return `All ${String(event.batches)} ${event.batches === 1 ? "batch is" : "batches are"} confirmed.`;
  }
}
