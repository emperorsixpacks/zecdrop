// How a list becomes batches, and what is worth warning about: the operator's planner, fee and warnings on the practice chain
// (crates/drop-core/src/planner.rs, fee.rs, warnings.rs), tried on their own tests' cases.
import { describe, expect, it } from "vitest";

import { warningMessage } from "@/api/warnings";

import type { PayoutRow } from "./csv";
import { planCampaign, type Plan } from "./plan";

const rows = (amounts: readonly number[]): PayoutRow[] =>
  amounts.map((amount, index) => ({ address: `u1row${String(index).padStart(6, "0")}`, amount: BigInt(amount), memo: null }));

function planned(amounts: readonly number[], max: number, policy: "zip317_text" | "zebra_main" = "zip317_text"): Plan {
  const result = planCampaign(rows(amounts), max, policy);
  if (!result.ok) throw new Error(result.message);
  return result.plan;
}

const sizes = (plan: Plan): number[] => plan.batches.map((batch) => batch.recipients);

describe("how many go in each batch", () => {
  it("fills each batch in order, and the last is what is left", () => {
    expect(sizes(planned([1, 2, 3, 4, 5, 6, 7, 8], 3))).toEqual([3, 3, 2]);
    expect(sizes(planned([1, 2, 3, 4, 5, 6], 3))).toEqual([3, 3]);
    expect(sizes(planned([1, 2, 3, 4, 5, 6, 7, 8], 50))).toEqual([8]);
  });

  it("never ends in a batch of one, which would publish that person's amount: one moves back from the batch before", () => {
    // 3 + 3 + 1 becomes 3 + 2 + 2, the operator's own example.
    const plan = planned([10, 20, 30, 40, 50, 60, 70], 3);
    expect(sizes(plan)).toEqual([3, 2, 2]);
    expect(plan.batches.map((batch) => batch.total)).toEqual([60n, 90n, 130n]);
    expect(sizes(planned([1, 2, 3, 4, 5], 4))).toEqual([3, 2]);
  });

  it("is one batch of one only for a campaign of one", () => {
    expect(sizes(planned([5], 10))).toEqual([1]);
    expect(sizes(planned([5], 2))).toEqual([1]);
  });

  it("cannot split what cannot be split without a batch of one, and says so in the operator's words", () => {
    for (const [count, max] of [
      [3, 2],
      [5, 2],
      [2, 1],
    ] as const) {
      const result = planCampaign(rows(Array.from({ length: count }, (_, i) => i + 1)), max, "zip317_text");
      expect(result).toEqual({
        ok: false,
        message: `cannot split ${String(count)} recipients into batches of at most ${String(max)} without a single-recipient batch; raise the batch size`,
      });
    }
    expect(sizes(planned([1, 2, 3, 4], 2))).toEqual([2, 2]);
  });

  it("refuses what the operator refuses before it splits anything", () => {
    expect(planCampaign(rows([1]), 0, "zip317_text")).toEqual({ ok: false, message: "max outputs per batch must be at least 1" });
    expect(planCampaign([], 5, "zip317_text")).toEqual({ ok: false, message: "there are no recipients to plan" });
    expect(planCampaign([], 0, "zip317_text")).toEqual({ ok: false, message: "max outputs per batch must be at least 1" });
    const big = planCampaign(rows([2_100_000_000_000_000, 1]), 10, "zip317_text");
    expect(big).toEqual({ ok: false, message: "amount exceeds the maximum possible supply of 21,000,000 ZEC" });
  });
});

describe("what it costs", () => {
  it("is the fee of each batch, one action more than its payouts and at least three, at 5,000 or 1,000 an action", () => {
    // The example list: eight payouts and the one transparent action make nine.
    const plan = planned([60_000, 40_000, 90_000, 50_000, 70_000, 30_000, 100_000, 60_000], 50);
    expect(plan.batches).toEqual([{ index: 0, recipients: 8, total: 500_000n, fee: 45_000n, required: 545_000n }]);
    expect(plan.declaredTotal).toBe(500_000n);
    expect(plan.feeTotal).toBe(45_000n);
    expect(plan.required).toBe(545_000n);
    // A batch of two is padded to two actions and still pays for three; the lower policy asks a fifth as much.
    expect(planned([1, 2], 10).batches[0]?.fee).toBe(15_000n);
    expect(planned([1, 2], 10, "zebra_main").batches[0]?.fee).toBe(3_000n);
    expect(planned([5], 10).batches[0]?.fee).toBe(15_000n);
  });

  it("adds up across batches", () => {
    const plan = planned([100, 200, 300, 400, 500], 3);
    expect(sizes(plan)).toEqual([3, 2]);
    expect(plan.declaredTotal).toBe(1_500n);
    expect(plan.feeTotal).toBe(35_000n);
    expect(plan.required).toBe(36_500n);
    // Each batch: what enters the pool and its fee (three recipients: four actions, 20,000; two: three actions, 15,000).
    expect(plan.batches.map((batch) => batch.required)).toEqual([600n + 20_000n, 900n + 15_000n]);
  });
});

describe("what is worth a warning", () => {
  const codes = (plan: Plan) => plan.warnings.map((warning) => warning.code);

  it("is one person: the public total is that person's amount", () => {
    expect(codes(planned([5], 10))).toEqual(["singleton_campaign"]);
  });

  it("is fewer than five people, which narrows every amount, and nothing at five", () => {
    expect(codes(planned([1, 2, 3, 4], 10))).toEqual(["small_campaign"]);
    expect(planned([1, 2, 3, 4], 10).warnings[0]).toMatchObject({ recipients: 4 });
    expect(codes(planned([1, 2, 3, 4, 5], 10))).toEqual([]);
    expect(codes(planned([1, 2, 3, 4, 5, 6, 7, 8], 10))).toEqual([]);
  });

  it("is a batch of two, in which each can work out the other's amount", () => {
    expect(planned([1, 2, 3, 4, 5], 3).warnings).toEqual([
      { code: "two_recipient_batch", batch_index: 1, message: "Batch 1 has two recipients; each can work out the other's amount from the public total and their own." },
    ]);
  });

  it("is a batch in which everyone gets the same, which the public total then gives away", () => {
    const plan = planned([2, 2, 2, 2, 2], 10);
    expect(plan.warnings).toEqual([
      { code: "uniform_batch", batch_index: 0, message: "Every recipient in batch 0 gets the same amount, so the public total reveals each amount." },
    ]);
    // A batch of one is the exception: a single amount is not "everyone the same", it is the campaign of one.
    expect(codes(planned([7], 10))).not.toContain("uniform_batch");
  });

  it("is said campaign first, then batch by batch, a batch of two before the same amounts in it", () => {
    expect(codes(planned([3, 3], 10))).toEqual(["small_campaign", "two_recipient_batch", "uniform_batch"]);
    // Seven in batches of five: the second has two, different amounts, so only that is said.
    expect(codes(planned([1, 2, 3, 4, 5, 6, 7], 5))).toEqual(["two_recipient_batch"]);
  });

  it("says each in the operator's sentence, which is the page's own", () => {
    for (const warning of planned([3, 3], 10).warnings) {
      const { message, ...fields } = warning;
      const view =
        "batch_index" in fields
          ? ({ code: fields.code, batchIndex: fields.batch_index } as const)
          : "recipients" in fields
            ? ({ code: fields.code, recipients: fields.recipients } as const)
            : ({ code: fields.code } as const);
      expect(message).toBe(warningMessage(view));
    }
  });
});
