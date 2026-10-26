import { describe, expect, it } from "vitest";

import { parseCampaign, type OperatorBatch } from "@/api/operator/schemas";
import { fixtureJson } from "@/test/operator-fixtures";

import { batchStatus } from "./BatchStatus";

const batch = (patch: Partial<OperatorBatch>): OperatorBatch => ({
  index: 0,
  recipients: 3,
  total: "1",
  fee: "1",
  fundingRequired: "2",
  state: "planned",
  txid: null,
  confirmations: 0,
  reason: null,
  ...patch,
});

const sending = { phase: "sending", done: 0, total: 2 } as const;

describe("batchStatus", () => {
  it("describes each state in words", () => {
    expect(batchStatus(batch({ state: "planned" }), sending)).toEqual({ label: "Planned", tone: "outline", note: null });
    expect(batchStatus(batch({ state: "built" }), sending).note).toBe("Not sent yet");
    expect(batchStatus(batch({ state: "broadcast" }), sending)).toMatchObject({ label: "Sent", note: "Waiting for a block" });
  });

  it("a confirmed batch is 'confirming' until the whole campaign has settled", () => {
    const b = batch({ state: "confirmed", confirmations: 2 });
    expect(batchStatus(b, sending)).toEqual({ label: "Confirming", tone: "shielded", note: "2 confirmations" });
    expect(batchStatus(b, { phase: "settled" })).toEqual({ label: "Final", tone: "done", note: "2 confirmations" });
  });

  it("never calls a batch final just because it has many confirmations", () => {
    expect(batchStatus(batch({ state: "confirmed", confirmations: 99 }), sending).label).toBe("Confirming");
  });

  it("pluralises confirmations", () => {
    expect(batchStatus(batch({ state: "confirmed", confirmations: 1 }), sending).note).toBe("1 confirmation");
  });

  it("a failed batch shows the operator's reason", () => {
    expect(batchStatus(batch({ state: "failed", reason: "rejected by the node" }), sending)).toEqual({
      label: "Failed",
      tone: "destructive",
      note: "rejected by the node",
    });
  });

  it("describes every batch the real operator reported, with a non-empty label", () => {
    for (const file of ["campaign-awaiting-funding", "campaign-running", "campaign-crashed", "campaign-settled"]) {
      const campaign = parseCampaign(fixtureJson(`${file}.json`));
      for (const b of campaign.batches) expect(batchStatus(b, campaign.phase).label.length, file).toBeGreaterThan(3);
    }
  });

  it("the real settled campaign has only final batches", () => {
    const campaign = parseCampaign(fixtureJson("campaign-settled.json"));
    expect(campaign.batches.map((b) => batchStatus(b, campaign.phase).label)).toEqual(["Final", "Final"]);
  });
});
