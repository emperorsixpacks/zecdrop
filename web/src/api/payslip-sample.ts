// The sample behind "Load a sample": payslip 3 of the real 8-recipient batch mined on public testnet
// (fixtures/testnet-ironwood-batch-8, the batch the sample receipt shows). The demo recipients are
// throwaway accounts whose amounts are in examples/demo-recipients.testnet.csv, so nothing here is
// anyone's. It is bundled with Vite's `?raw` import, like the sample receipt in demo.ts, so there is
// no hand-copied duplicate to drift.

import sampleText from "../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/payslips/payslip-3.json?raw";

import { readPayslip, type Payslip } from "./payslip-input";

/** The sample, as the file holds it. */
export const SAMPLE_PAYSLIP_TEXT: string = sampleText;

/** The sample, read like any pasted payslip. */
export function samplePayslip(): Payslip {
  const read = readPayslip(sampleText);
  if (!read.ok) throw new Error("the bundled sample payslip is not a payslip this page reads");
  return read.payslip;
}

/** The sample with its amount one zatoshi higher and nothing else changed, laid out like the file:
 * the check must refuse it. */
export function changedSamplePayslipText(): string {
  const payslip = samplePayslip();
  return `${JSON.stringify({ ...payslip, value: (BigInt(payslip.value) + 1n).toString() }, null, 2)}\n`;
}
