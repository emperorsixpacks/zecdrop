import { describe, expect, it } from "vitest";

import { DEMO_ID, DEMOS, demoCase, demoReceipt, isRealDemo, REAL_CAPTURES, SAMPLE_RECEIPT_HREF, type DemoCase } from "./demo";

describe("demoReceipt: clean (the default)", () => {
  it("is the golden receipt, validated by the strict schema", () => {
    const receipt = demoReceipt();
    expect(receipt.campaignId).toBe("golden-fixture");
    expect(receipt.batches).toHaveLength(2);
    expect(receipt.phase).toEqual({ phase: "sending", done: 1, total: 2 });
    expect(receipt.findings).toEqual([]);
  });

  it("includes a batch that is not built yet, so the pending state is visible", () => {
    expect(demoReceipt("clean").batches.some((b) => b.txid === null)).toBe(true);
  });
});

describe("demoReceipt: the real testnet batches", () => {
  const eight = demoReceipt("real");
  const smoke = demoReceipt("real-smoke");

  it("real: the full operator path with 8 shielded outputs, as the live verifier read it", () => {
    expect(eight.network).toBe("testnet");
    expect(eight.batches).toHaveLength(1);
    expect(eight.batches[0]).toMatchObject({
      txid: "6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955",
      netIntoPool: "500000",
      fee: "45000",
      shieldedActions: 8,
      pool: "ironwood",
    });
    expect(eight.declaredTotal).toBe("500000");
    expect(eight.feeTotal).toBe("45000");
    expect(eight.findings).toEqual([]);
    expect(eight.phase).toEqual({ phase: "settled" });
  });

  it("real-smoke: the first batch mined on public testnet, with 3 shielded outputs", () => {
    expect(smoke.batches).toHaveLength(1);
    expect(smoke.batches[0]).toMatchObject({
      txid: "50fb88e02e7f4b0f3b3b658f50b09b12ea973d8c3697f8bad4c59e41075ea3e3",
      netIntoPool: "60000",
      fee: "20000",
      shieldedActions: 3,
      pool: "ironwood",
    });
    expect(smoke.findings).toEqual([]);
    expect(smoke.phase).toEqual({ phase: "settled" });
  });

  it("both carry the funding address of the real campaigns", () => {
    expect(eight.fundingAddress).toBe("tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD");
    expect(smoke.fundingAddress).toBe("tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD");
  });

  it("have no campaign id (the verifier was not told one), so the page labels them itself", () => {
    expect(eight.campaignId).toBeNull();
    expect(smoke.campaignId).toBeNull();
  });

  it("say where they were mined and captured (from the fixtures' own README and confirmations)", () => {
    expect(REAL_CAPTURES.real).toEqual({ network: "public testnet", minedAt: "4,478,289", capturedAt: "4,533,356" });
    expect(REAL_CAPTURES["real-smoke"]).toEqual({ network: "public testnet", minedAt: "4,478,065", capturedAt: "4,533,356" });
    // captured height = mined height + confirmations - 1, the way the fixture READMEs count
    expect(4_478_289 + (eight.batches[0]?.confirmations ?? 0) - 1).toBe(4_533_356);
    expect(4_478_065 + (smoke.batches[0]?.confirmations ?? 0) - 1).toBe(4_533_356);
  });

  // covers: REQ-VER-007
  it("say what their deposits spent: the faucet's shielded payout, and the sweep of the first batch's change", () => {
    expect(smoke.fundingSource).toBe("shielded");
    expect(eight.fundingSource).toBe("transparent");
  });

  it("are the only samples that are real", () => {
    expect((["real", "real-smoke", "clean", "findings", "mismatch"] as const).filter(isRealDemo)).toEqual(["real", "real-smoke"]);
  });

  it("is what 'Sample receipt' opens: the 8-output batch", () => {
    expect(demoCase(DEMO_ID, new URL(SAMPLE_RECEIPT_HREF, "http://x").searchParams)).toBe("real");
  });
});

describe("demoReceipt: the other two samples", () => {
  it("findings: the verifier could not confirm everything", () => {
    const receipt = demoReceipt("findings");
    expect(receipt.phase).toEqual({ phase: "failed" });
    expect(receipt.findings.length).toBeGreaterThanOrEqual(7);
    expect(receipt.feeTotal).toBeNull();
    expect(receipt.batches.some((b) => b.netIntoPool === null)).toBe(true);
  });

  it("mismatch: the declared total does not add up, and the campaign is unnamed", () => {
    const receipt = demoReceipt("mismatch");
    expect(receipt.findings).toEqual([{ code: "declared_total_mismatch" }]);
    expect(receipt.campaignId).toBeNull();
  });

  it("all five are different receipts", () => {
    const phases = (["real", "real-smoke", "clean", "findings", "mismatch"] as const).map((c) =>
      JSON.stringify(demoReceipt(c)),
    );
    expect(new Set(phases).size).toBe(5);
  });
});

describe("demoCase", () => {
  const p = (query: string) => new URLSearchParams(query);

  it.each<[string, DemoCase]>([
    ["demo=real", "real"],
    ["demo=real-smoke", "real-smoke"],
    ["demo=1", "clean"],
    ["demo=findings", "findings"],
    ["demo=mismatch", "mismatch"],
  ])("?%s is the %s sample", (query, expected) => {
    expect(demoCase(DEMO_ID, p(query))).toBe(expected);
  });

  it.each([
    ["wrong id", "abc", "demo=1"],
    ["no flag", DEMO_ID, ""],
    ["flag off", DEMO_ID, "demo=0"],
    ["flag true", DEMO_ID, "demo=true"],
    ["unknown sample", DEMO_ID, "demo=other"],
    ["repeated flag", DEMO_ID, "demo=1&demo=1"],
    ["two different samples", DEMO_ID, "demo=1&demo=findings"],
    ["an inherited property name", DEMO_ID, "demo=constructor"],
    ["a proto key", DEMO_ID, "demo=__proto__"],
  ])("is null for %s", (_label, id, query) => {
    expect(demoCase(id, p(query))).toBeNull();
  });

  it("is null when there is no id", () => {
    expect(demoCase(undefined, p("demo=1"))).toBeNull();
  });
});

describe("DEMOS (the links between samples)", () => {
  it("has one entry per sample, and every link opens the sample it names", () => {
    expect(DEMOS.map((d) => d.case).sort()).toEqual(["clean", "findings", "mismatch", "real", "real-smoke"]);
    for (const demo of DEMOS) {
      const url = new URL(demo.href, "http://x");
      expect(url.pathname).toBe(`/r/${DEMO_ID}`);
      expect(demoCase(DEMO_ID, url.searchParams)).toBe(demo.case);
    }
  });
});

describe("the sample switcher's labels", () => {
  it("are short, different from each other, and in the order of the samples", () => {
    const shorts = DEMOS.map((d) => d.short);
    expect(shorts).toEqual(["Real batch", "First batch", "In progress", "With findings", "Total mismatch"]);
    expect(new Set(shorts).size).toBe(shorts.length);
    for (const short of shorts) expect(short.split(" ").length).toBeLessThanOrEqual(3);
  });
});
