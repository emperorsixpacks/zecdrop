// A simulated run: what the operator's engine does after "send", on the practice chain, in the order it does it. For every
// batch, one after the other, a transaction is built and then sent; then the run waits for the first block, and each batch
// gains a confirmation at a time until all of them have the depth the campaign needs; then it is settled. Each step changes
// what the campaign says about itself and says so on the event stream, in the same moment, as the operator does
// (fixtures/contract/operator/events-settled.sse.txt is the transcript this reproduces).
//
// Nothing here is a request or a block. It is a timeline made of timers that the page's own screens can watch.

import { pace } from "./pace";
import { practiceHex32, type RandomBytes } from "./random";
import type { Scheduler } from "./scheduler";
import { REQUIRED_DEPTH, type Campaign, type WireEvent } from "./state";

/** Say it on the stream: kept, so a listener that arrives later is told all of it first, and sent to the ones listening now. */
function publish(campaign: Campaign, event: WireEvent): void {
  campaign.events.push(event);
  for (const listener of [...campaign.listeners]) listener(event);
}

interface Step {
  /** In steps of the pace: how long after the one before. */
  after: number;
  apply: () => void;
}

function stepsOf(campaign: Campaign, random: RandomBytes): Step[] {
  const batches = campaign.plan.batches;
  const steps: Step[] = [];

  for (const batch of batches) {
    const index = batch.index;
    // The transaction is built ("proving" is the slow part of this on a real chain), then sent.
    steps.push({
      after: 1,
      apply: () => {
        const txid = practiceHex32(random);
        campaign.states[index] = { name: "built", txid };
        publish(campaign, { event: "built", batch_index: index, txid, outputs: batch.recipients });
      },
    });
    steps.push({
      after: 0.6,
      apply: () => {
        const state = campaign.states[index];
        if (state?.name !== "built") return;
        campaign.states[index] = { name: "broadcast", txid: state.txid };
        publish(campaign, { event: "broadcast", batch_index: index, txid: state.txid });
      },
    });
  }

  // Sent, and in no block yet.
  steps.push({
    after: 1,
    apply: () => {
      for (const batch of batches) {
        publish(campaign, { event: "waiting", batch_index: batch.index, observed_depth: 0, required_depth: REQUIRED_DEPTH });
      }
    },
  });

  // A block: every batch has one more confirmation.
  for (let depth = 1; depth <= REQUIRED_DEPTH; depth += 1) {
    steps.push({
      after: 1,
      apply: () => {
        for (const batch of batches) {
          const state = campaign.states[batch.index];
          if (state === undefined || state.name === "planned") continue;
          campaign.states[batch.index] = { name: "confirmed", txid: state.txid, depth };
          publish(campaign, {
            event: "confirmed",
            batch_index: batch.index,
            txid: state.txid,
            depth,
            required_depth: REQUIRED_DEPTH,
          });
        }
      },
    });
  }

  steps.push({
    after: 0.4,
    apply: () => {
      campaign.run = "settled";
      publish(campaign, { event: "settled", campaign_id: campaign.id, batches: batches.length });
    },
  });
  return steps;
}

/** Start the campaign's run: it is running from this moment, and the steps follow one `pace.stepMs` apart. */
export function startRun(campaign: Campaign, scheduler: Scheduler, random: RandomBytes): void {
  campaign.run = "running";
  // A run says its whole story afresh: what an earlier one said is not replayed.
  campaign.events = [];
  const steps = stepsOf(campaign, random);
  const next = (index: number): void => {
    const step = steps[index];
    if (step === undefined) return;
    scheduler.after(Math.round(step.after * pace.stepMs), () => {
      step.apply();
      next(index + 1);
    });
  };
  next(0);
}
