import { describe, expect, it } from "vitest";

import payslip1 from "../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/payslips/payslip-1.json?raw";
import payslip2 from "../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/payslips/payslip-2.json?raw";
import payslip3 from "../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/payslips/payslip-3.json?raw";
import payslip4 from "../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/payslips/payslip-4.json?raw";
import payslip5 from "../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/payslips/payslip-5.json?raw";
import payslip6 from "../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/payslips/payslip-6.json?raw";
import payslip7 from "../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/payslips/payslip-7.json?raw";
import payslip8 from "../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/payslips/payslip-8.json?raw";

import { demoReceipt } from "./demo";
import { readPayslip } from "./payslip-input";
import { changedSamplePayslipText, SAMPLE_PAYSLIP_TEXT, samplePayslip } from "./payslip-sample";

const ALL = [payslip1, payslip2, payslip3, payslip4, payslip5, payslip6, payslip7, payslip8];

describe("the payslips of the real 8-recipient testnet batch", () => {
  it("every one is a payslip this page reads, as the operator wrote it", () => {
    for (const [i, text] of ALL.entries()) {
      const read = readPayslip(text);
      expect(read.ok, `payslip ${String(i + 1)}`).toBe(true);
    }
  });

  it("are for the one transaction the sample receipt shows, one for each of its outputs", () => {
    const slips = ALL.map((text) => {
      const read = readPayslip(text);
      if (!read.ok) throw new Error("expected a payslip");
      return read.payslip;
    });
    const batch = demoReceipt("real").batches[0];
    expect(batch?.shieldedActions).toBe(8);
    for (const slip of slips) {
      expect(slip.network).toBe("testnet");
      expect(slip.txid).toBe(batch?.txid);
      expect(slip.action).toBeLessThan(batch?.shieldedActions ?? 0);
    }
    expect(new Set(slips.map((slip) => slip.action)).size).toBe(8);
  });

  it("are laid out the way this page lays a payslip out, so a changed copy differs in one value only", () => {
    for (const text of ALL) expect(`${JSON.stringify(JSON.parse(text), null, 2)}\n`).toBe(text);
  });
});

describe("the sample", () => {
  it("is payslip 3 of that batch, as its file holds it", () => {
    expect(SAMPLE_PAYSLIP_TEXT).toBe(payslip3);
    expect(samplePayslip()).toMatchObject({ network: "testnet", action: 5, value: "90000" });
  });

  it("is one of the demo payouts, so the amount is the one in the public demo list", () => {
    // examples/demo-recipients.testnet.csv: 0.0009 for the third row.
    expect(samplePayslip().value).toBe("90000");
  });

  it("has a changed copy that is the same file but for the amount, one zatoshi higher", () => {
    const original = JSON.parse(SAMPLE_PAYSLIP_TEXT) as Record<string, unknown>;
    const changed = JSON.parse(changedSamplePayslipText()) as Record<string, unknown>;
    expect(Object.keys(changed)).toEqual(Object.keys(original));
    expect(changed["value"]).toBe("90001");
    expect({ ...changed, value: original["value"] }).toEqual(original);
    expect(changedSamplePayslipText()).toBe(SAMPLE_PAYSLIP_TEXT.replace('"value": "90000"', '"value": "90001"'));
  });

  it("has a changed copy that is still a payslip this page reads, so the verifier is what refuses it", () => {
    expect(readPayslip(changedSamplePayslipText()).ok).toBe(true);
  });
});
