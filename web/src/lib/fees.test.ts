import { describe, expect, it } from "vitest";

import { parseCampaign } from "@/api/operator/schemas";
import { fixtureJson } from "@/test/operator-fixtures";
import { formatZec } from "@/lib/zec";
import builderSource from "../../../crates/drop-zcash/src/builder.rs?raw";

import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_FEE_POLICY,
  describeDuration,
  estimateBatchFee,
  estimateProvingSeconds,
  FEE_POLICIES,
  logicalActions,
  MAX_BATCH_SIZE,
  MIN_BATCH_SIZE,
  type FeePolicyName,
} from "./fees";

const policyOf = (marginalFee: number): FeePolicyName => {
  const found = (Object.keys(FEE_POLICIES) as FeePolicyName[]).find((n) => FEE_POLICIES[n].marginalFee === BigInt(marginalFee));
  if (!found) throw new Error(`unknown policy ${String(marginalFee)}`);
  return found;
};

describe("the fee estimate equals what the real operator charged", () => {
  const files = ["create-valid", "create-zebra-fee", "create-uniform", "create-single", "create-small"];

  it.each(files)("every batch of %s", (file) => {
    const campaign = parseCampaign(fixtureJson(`${file}.json`));
    const policy = policyOf(campaign.feePolicy.marginalFee);
    for (const batch of campaign.batches) {
      expect(estimateBatchFee(policy, batch.recipients).toString(), `batch ${String(batch.index)}`).toBe(batch.fee);
    }
  });

  it("the policy constants equal the ones the operator reports", () => {
    const standard = parseCampaign(fixtureJson("create-valid.json")).feePolicy;
    const lower = parseCampaign(fixtureJson("create-zebra-fee.json")).feePolicy;
    expect(standard).toEqual({ marginalFee: 5000, graceActions: 2 });
    expect(lower).toEqual({ marginalFee: 1000, graceActions: 2 });
    expect(FEE_POLICIES.zip317_text.marginalFee).toBe(5000n);
    expect(FEE_POLICIES.zebra_main.marginalFee).toBe(1000n);
  });

  it("covers batches of one, two and three recipients, under both policies", () => {
    const sizes = new Set(
      files.flatMap((f) => parseCampaign(fixtureJson(`${f}.json`)).batches.map((b) => b.recipients)),
    );
    expect([...sizes].sort()).toEqual([1, 2, 3]);
  });
});

describe("logical actions", () => {
  it.each([
    [1, 3],
    [2, 3],
    [3, 4],
    [50, 51],
    [330, 331],
  ])("%i outputs -> %i actions", (outputs, actions) => {
    expect(logicalActions(outputs)).toBe(actions);
  });
});

describe("the example shown for the default batch", () => {
  it("50 payouts: 255,000 zatoshi standard, 51,000 lower", () => {
    expect(estimateBatchFee("zip317_text", 50)).toBe(255_000n);
    expect(estimateBatchFee("zebra_main", 50)).toBe(51_000n);
    expect(formatZec(estimateBatchFee("zip317_text", 50))).toBe("0.00255");
    expect(formatZec(estimateBatchFee("zebra_main", 50))).toBe("0.00051");
  });

  it("the lower policy is always exactly one fifth of the standard one", () => {
    for (const n of [1, 2, 3, 10, 50, 330]) {
      expect(estimateBatchFee("zip317_text", n)).toBe(estimateBatchFee("zebra_main", n) * 5n);
    }
  });
});

describe("defaults and limits", () => {
  it("default to the higher fee, and 50 payouts per batch", () => {
    expect(DEFAULT_FEE_POLICY).toBe("zip317_text");
    expect(DEFAULT_BATCH_SIZE).toBe(50);
    expect(MIN_BATCH_SIZE).toBe(2);
    expect(MAX_BATCH_SIZE).toBe(330);
    // And it is the number the transaction builder enforces.
    const rust = /pub const MAX_IRONWOOD_ACTIONS_PER_TX: usize = (\d+);/u.exec(builderSource);
    expect(Number(rust?.[1])).toBe(MAX_BATCH_SIZE);
  });

  it("50 payouts take about a minute to prove", () => {
    expect(estimateProvingSeconds(50)).toBe(62.5);
    expect(describeDuration(estimateProvingSeconds(50))).toBe("about 1 minute");
  });

  it.each([
    [0.5, "about 1 second"],
    [1.4, "about 1 second"],
    [30, "about 30 seconds"],
    [44, "about 44 seconds"],
    [45, "about 1 minute"],
    [62.5, "about 1 minute"],
    [89, "about 1 minute"],
    [90, "about 2 minutes"],
    [125, "about 2 minutes"],
    [412.5, "about 7 minutes"],
  ])("describes %f seconds as %s", (seconds, text) => {
    expect(describeDuration(seconds)).toBe(text);
  });
});
