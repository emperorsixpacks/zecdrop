import { describe, expect, it } from "vitest";

import type { OperatorBatch, OperatorCampaign, ProgressEvent } from "@/api/operator/schemas";

import { DEFAULT_REQUIRED_DEPTH, elapsedText, expectation, requiredDepthFrom, timelineSteps } from "./timeline";

const TX = "a".repeat(64);

function batch(state: OperatorBatch["state"], confirmations = 0, index = 0): OperatorBatch {
  return {
    index,
    recipients: 4,
    total: "100000",
    fee: "10000",
    fundingRequired: "110000",
    state,
    txid: state === "planned" ? null : TX,
    confirmations,
    reason: state === "failed" ? "the node refused it" : null,
  };
}

type Input = Pick<OperatorCampaign, "batches" | "phase" | "run" | "recipientCount">;

function campaign(batches: OperatorBatch[], run: OperatorCampaign["run"] = { state: "running" }, recipientCount = 8): Input {
  const settled = run.state === "settled";
  return {
    batches,
    run,
    recipientCount,
    phase: settled ? { phase: "settled" } : { phase: "sending", done: batches.filter((b) => b.state === "confirmed").length, total: batches.length },
  };
}

const states = (input: Input, log: ProgressEvent[] = []) => timelineSteps(input, log).map((s) => `${s.label}:${s.state}`);

describe("the sending timeline", () => {
  it("has the steps Preparing, Proving, Sending, Confirming 1 to 3, Done", () => {
    expect(timelineSteps(campaign([batch("planned")]), []).map((s) => s.label)).toEqual([
      "Preparing",
      "Proving",
      "Sending",
      "Confirming 1",
      "Confirming 2",
      "Confirming 3",
      "Done",
    ]);
  });

  it("starts at Proving: the operator took the start, and building takes a while", () => {
    const steps = timelineSteps(campaign([batch("planned")]), []);
    expect(states(campaign([batch("planned")]))).toEqual([
      "Preparing:done",
      "Proving:active",
      "Sending:next",
      "Confirming 1:next",
      "Confirming 2:next",
      "Confirming 3:next",
      "Done:next",
    ]);
    expect(steps[1]?.detail).toBe("About 10 seconds.");
  });

  it("moves to Sending when the transaction is built, and to Confirming 1 once it is on the network", () => {
    expect(states(campaign([batch("built")]))[2]).toBe("Sending:active");
    expect(states(campaign([batch("broadcast", 0)]))).toEqual([
      "Preparing:done",
      "Proving:done",
      "Sending:done",
      "Confirming 1:active",
      "Confirming 2:next",
      "Confirming 3:next",
      "Done:next",
    ]);
  });

  it.each([
    [1, "Confirming 2"],
    [2, "Confirming 3"],
  ])("with %s confirmation(s) it is on %s", (count, label) => {
    const steps = timelineSteps(campaign([batch("broadcast", count)]), []);
    expect(steps.find((s) => s.state === "active")?.label).toBe(label);
    expect(steps.find((s) => s.state === "active")?.detail).toBe(`${String(count)} of 3 confirmations. Waiting for the next block.`);
  });

  it.each([
    [1, "Confirming 2"],
    [2, "Confirming 3"],
  ])("a batch the operator calls confirmed with only %s confirmation(s) is still confirming: it is on %s, not Done", (count, label) => {
    // The operator says "confirmed" from the first confirmation and keeps the count beside it.
    const steps = timelineSteps(campaign([batch("confirmed", count)]), []);
    expect(steps.find((s) => s.state === "active")?.label).toBe(label);
    expect(steps.find((s) => s.state === "active")?.detail).toBe(`${String(count)} of 3 confirmations. Waiting for the next block.`);
    expect(steps.at(-1)).toMatchObject({ label: "Done", state: "next" });
  });

  it("a confirmed batch with all the confirmations that are waited for is final", () => {
    const steps = timelineSteps(campaign([batch("confirmed", 3)]), []);
    expect(steps.at(-1)?.state).toBe("active"); // Done, in progress until the run says settled
  });

  it("with two batches it is as far along as the one with fewer confirmations", () => {
    const steps = timelineSteps(campaign([batch("confirmed", 2, 0), batch("confirmed", 1, 1)]), []);
    expect(steps.find((s) => s.state === "active")?.label).toBe("Confirming 2");
    expect(steps.find((s) => s.state === "active")?.detail).toBe("1 of 3 confirmations. Waiting for the next block.");
  });

  it("is done only when the operator says it is settled", () => {
    const settled = timelineSteps(campaign([batch("confirmed", 3)], { state: "settled" }), []);
    expect(settled.every((s) => s.state === "done")).toBe(true);
    expect(settled.at(-1)?.detail).toBe("Every batch is confirmed.");
  });

  it("with every batch confirmed but the campaign not yet settled, Done is in progress, not done", () => {
    const steps = timelineSteps(campaign([batch("confirmed", 3)]), []);
    expect(steps.at(-1)).toMatchObject({ label: "Done", state: "active", detail: "Checking that every batch is final." });
  });

  it("is only as far along as its slowest batch", () => {
    const input = campaign([batch("confirmed", 3, 0), batch("built", 0, 1), batch("planned", 0, 2)]);
    expect(timelineSteps(input, []).find((s) => s.state === "active")?.label).toBe("Proving");
    expect(timelineSteps(input, []).find((s) => s.state === "active")?.detail).toBe("2 of 3 batches built.");
    const later = campaign([batch("confirmed", 3, 0), batch("broadcast", 2, 1)]);
    expect(timelineSteps(later, []).find((s) => s.state === "active")?.label).toBe("Confirming 3");
  });

  it("marks the step a failed batch is at, with the reason in the core's sentence", () => {
    const steps = timelineSteps(campaign([{ ...batch("failed", 0, 2), txid: null }], { state: "halted" }), []);
    const failed = steps.find((s) => s.state === "failed");
    expect(failed?.label).toBe("Proving");
    expect(failed?.detail).toBe("Batch 2: failed. the node refused it");
    // Nothing after it is claimed.
    expect(steps.filter((s) => s.state === "done").map((s) => s.label)).toEqual(["Preparing"]);
  });

  it("says a halted run needs attention even when no batch carries a reason", () => {
    const steps = timelineSteps(campaign([batch("built")], { state: "halted" }), []);
    expect(steps.find((s) => s.state === "failed")?.detail).toBe("Some batches failed and cannot be retried automatically. They need attention.");
  });

  it("keeps the step in progress when the run is paused or stopped, and says why", () => {
    const stalled = timelineSteps(campaign([batch("built")], { state: "stalled", error: "the node is not answering." }), []);
    expect(stalled.find((s) => s.state === "active")?.detail).toContain("the node is not answering.");
    const crashed = timelineSteps(campaign([batch("broadcast", 1)], { state: "crashed" }), []);
    expect(crashed.find((s) => s.state === "active")?.label).toBe("Confirming 2");
    expect(crashed.find((s) => s.state === "active")?.detail).toContain("Starting again resumes from where it stopped");
  });

  it("takes the required depth from the latest event, and folds a long wait into one step", () => {
    const event = (depth: number): ProgressEvent => ({ event: "confirmed", batchIndex: 0, txid: TX, depth: 1, requiredDepth: depth });
    expect(requiredDepthFrom([])).toBe(DEFAULT_REQUIRED_DEPTH);
    expect(requiredDepthFrom([event(5)])).toBe(5);
    expect(timelineSteps(campaign([batch("broadcast", 1)]), [event(5)]).map((s) => s.label)).toEqual([
      "Preparing",
      "Proving",
      "Sending",
      "Confirming 1",
      "Confirming 2",
      "Confirming 3",
      "Confirming 4",
      "Confirming 5",
      "Done",
    ]);
    const long = timelineSteps(campaign([batch("broadcast", 4)]), [event(12)]);
    expect(long.map((s) => s.label)).toEqual(["Preparing", "Proving", "Sending", "Confirming", "Done"]);
    expect(long.find((s) => s.state === "active")?.detail).toBe("4 of 12 confirmations. Waiting for the next block.");
  });

  it("with no batches yet, is at Proving", () => {
    expect(states(campaign([]))[1]).toBe("Proving:active");
  });
});

describe("elapsed time and the expectation", () => {
  it("shows minutes and seconds", () => {
    expect(elapsedText(0)).toBe("0:00");
    expect(elapsedText(42_900)).toBe("0:42");
    expect(elapsedText(65_000)).toBe("1:05");
    expect(elapsedText(-5)).toBe("0:00");
  });

  it("calls itself an estimate, scales with the people and the block time, and says nothing on the practice chain", () => {
    expect(expectation(8, 3, "testnet", false)).toBe("Usually about 10 seconds to build, then about 1 minute to confirm. These are estimates.");
    expect(expectation(8, 3, "mainnet", false)).toBe("Usually about 10 seconds to build, then about 4 minutes to confirm. These are estimates.");
    expect(expectation(8, 3, "testnet", true)).toBeNull();
  });
});

// covers: REQ-DEMO-001
describe("the sending timeline in practice mode", () => {
  const detailOf = (input: Input, practice: boolean) => timelineSteps(input, [], practice).find((s) => s.state === "active")?.detail;

  it("says the send is pretended, and that nothing leaves the browser, where the operator says it is sending to the network", () => {
    const input = campaign([batch("built")]);
    expect(detailOf(input, true)).toBe("Pretending to send: nothing leaves your browser.");
    expect(detailOf(input, false)).toBe("Sending to the network.");
  });

  it("says the confirmations are simulated, and does not wait for a block", () => {
    for (const count of [0, 1, 2]) {
      const input = campaign([batch("broadcast", count)]);
      expect(detailOf(input, true)).toBe(`${String(count)} of 3 confirmations (simulated).`);
      expect(detailOf(input, false)).toBe(`${String(count)} of 3 confirmations. Waiting for the next block.`);
    }
  });

  it("counts the depth the run waits for, as it does without practice", () => {
    const long = timelineSteps(campaign([batch("broadcast", 4)]), [{ event: "waiting", batchIndex: 0, observedDepth: 4, requiredDepth: 12 }], true);
    expect(long.find((s) => s.state === "active")?.detail).toBe("4 of 12 confirmations (simulated).");
  });

  it("is the operator's own wording when it is not asked for, and changes nothing but those two sentences when it is", () => {
    const inputs = [
      campaign([batch("planned")]),
      campaign([batch("built")]),
      campaign([batch("broadcast", 1)]),
      campaign([batch("confirmed", 2), batch("broadcast", 0, 1)]),
      campaign([batch("confirmed", 3)], { state: "settled" }),
      campaign([batch("failed", 0)], { state: "halted" }),
      campaign([batch("built")], { state: "stalled", error: "the node is not answering." }),
    ];
    for (const input of inputs) {
      const real = timelineSteps(input, []);
      expect(timelineSteps(input, [], false)).toEqual(real);
      const pretend = timelineSteps(input, [], true);
      expect(pretend.map((s) => [s.key, s.label, s.state])).toEqual(real.map((s) => [s.key, s.label, s.state]));
      const differing = pretend.filter((s, i) => s.detail !== real[i]?.detail);
      for (const step of differing) expect(step.detail).toMatch(/Pretending to send|\(simulated\)/u);
    }
    // Nothing the practice timeline says is about a network or a block.
    for (const input of inputs) {
      for (const step of timelineSteps(input, [], true)) expect(step.detail ?? "").not.toMatch(/to the network|next block/iu);
    }
  });
});
