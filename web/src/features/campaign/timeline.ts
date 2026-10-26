// What the sending timeline says, worked out from what the operator reports.
//
// The steps are Preparing, Proving, Sending, Confirming 1..N and Done. The operator
// does not say "now proving"; it says each batch's state (planned, built, broadcast
// with a number of confirmations, confirmed, failed) and sends events. The place on
// the line is the LEAST advanced batch, because the campaign is only as far along
// as its slowest batch. Pure, so every sentence is testable.

import type { OperatorBatch, OperatorCampaign, ProgressEvent } from "@/api/operator/schemas";
import type { TimelineStep } from "@/components/Timeline";
import { describeDuration, estimateProvingSeconds } from "@/lib/fees";

import { describeEvent, describeRun } from "@/features/operator/messages";

/** The depth the core waits for when no event has said otherwise. */
export const DEFAULT_REQUIRED_DEPTH = 3;
/** More than this many confirmations are one step, not one each. */
const MAX_CONFIRM_STEPS = 6;

export function requiredDepthFrom(log: readonly ProgressEvent[]): number {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const event = log[i];
    if (event && (event.event === "confirmed" || event.event === "waiting")) return Math.max(1, event.requiredDepth);
  }
  return DEFAULT_REQUIRED_DEPTH;
}

type TimelineCampaign = Pick<OperatorCampaign, "batches" | "phase" | "run" | "recipientCount">;

/** Where one batch is, as a number: 0 proving, 1 sending, 2 + c confirming (c done), depth + 2 finished.
 *
 * The operator calls a batch "confirmed" from its FIRST confirmation and keeps the number of confirmations
 * it has beside that (crates/drop-core/src/engine.rs records Confirmed { depth } at every increase). So a
 * confirmed batch is final only when it has the depth the campaign waits for; before that it is still
 * confirming, and the line says which one it is waiting for. */
function rank(batch: OperatorBatch, depth: number): number {
  switch (batch.state) {
    case "planned":
      return 0;
    case "built":
      return 1;
    case "broadcast":
      return 2 + Math.min(batch.confirmations, depth - 1);
    case "confirmed":
      return batch.confirmations >= depth ? depth + 2 : 2 + Math.max(0, batch.confirmations);
    case "failed":
      // It was at least built if it has a transaction; where it failed is not said.
      return batch.txid === null ? 0 : 2 + Math.min(batch.confirmations, depth - 1);
  }
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function timelineSteps(campaign: TimelineCampaign, log: readonly ProgressEvent[]): TimelineStep[] {
  const depth = requiredDepthFrom(log);
  const collapsed = depth > MAX_CONFIRM_STEPS;
  const settled = campaign.run.state === "settled" || campaign.phase.phase === "settled";
  const failures = campaign.batches.filter((b) => b.state === "failed");
  const halted = campaign.run.state === "halted" || failures.length > 0;

  const labels = [
    "Preparing",
    "Proving",
    "Sending",
    ...(collapsed ? ["Confirming"] : Array.from({ length: depth }, (_, i) => `Confirming ${String(i + 1)}`)),
    "Done",
  ];
  const confirmFirst = 3;
  const done = labels.length - 1;

  const lowest = campaign.batches.length === 0 ? 0 : Math.min(...campaign.batches.map((b) => rank(b, depth)));
  // The index of the step in progress: Proving is 1, so rank 0 is index 1; finished is the last.
  const confirming = Math.max(0, lowest - 2);
  let active: number;
  if (lowest >= depth + 2) active = done;
  else if (lowest <= 1) active = 1 + lowest;
  else active = collapsed ? confirmFirst : confirmFirst + confirming;
  if (settled) active = done;

  const built = campaign.batches.filter((b) => b.state !== "planned").length;
  const confirmations = Math.min(
    depth,
    ...campaign.batches.filter((b) => b.state === "broadcast" || b.state === "confirmed" || b.state === "failed").map((b) => b.confirmations),
  );

  function detail(index: number): string | undefined {
    if (index === done) return settled ? "Every batch is confirmed." : "Checking that every batch is final.";
    if (index !== active) return undefined;
    if (index === 1) {
      return campaign.batches.length > 1
        ? `${String(built)} of ${String(campaign.batches.length)} batches built.`
        : `${sentence(describeDuration(estimateProvingSeconds(campaign.recipientCount)))}.`;
    }
    if (index === 2) return "Sending to the network.";
    const seen = `${String(Number.isFinite(confirmations) ? confirmations : 0)} of ${String(depth)} confirmations`;
    return `${seen}. Waiting for the next block.`;
  }

  const failureText = (): string => {
    const first = failures[0];
    if (first !== undefined) return describeEvent({ event: "failed", batchIndex: first.index, reason: first.reason ?? "No reason was given." });
    return describeRun(campaign.run).detail;
  };

  return labels.map((label, index): TimelineStep => {
    const key = `${String(index)}-${label}`;
    if (index === 0) return { key, label, state: "done" };
    if (settled || index < active) return { key, label, state: "done", ...(index === done ? { detail: detail(index) ?? "" } : {}) };
    if (index === active) {
      if (halted) return { key, label, state: "failed", detail: failureText() };
      const run = campaign.run;
      if (run.state === "stalled" || run.state === "crashed") return { key, label, state: "active", detail: describeRun(run).detail };
      return { key, label, state: "active", detail: detail(index) ?? "" };
    }
    return { key, label, state: "next" };
  });
}

/** "0:42", "12:05": minutes and seconds, so the width barely changes. */
export function elapsedText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
}

/** The one line of expectation under the timeline: about how long building takes and
 * how long the confirmations take. An estimate, and said to be one. Null on the
 * fake chain, where there is nothing real to wait for. */
export function expectation(recipients: number, depth: number, network: "testnet" | "mainnet", mock: boolean): string | null {
  if (mock) return null;
  const blockSeconds = network === "mainnet" ? 75 : 25;
  return `Usually ${describeDuration(estimateProvingSeconds(recipients))} to build, then ${describeDuration(depth * blockSeconds)} to confirm. These are estimates.`;
}
