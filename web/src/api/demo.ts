// The sample receipts behind /r/demo?demo=..., so the page works with no
// backend and a visitor can see every state of it.
//
//   ?demo=real        a real 8-output batch from the full operator path on public
//                     testnet (the default sample, the one the video shows)
//   ?demo=real-smoke  the first real batch on public testnet, a smaller one (3 outputs)
//   ?demo=1           a campaign in progress, nothing wrong (synthetic)
//   ?demo=findings    a verifier that could not confirm everything (synthetic)
//   ?demo=mismatch    a declared total that does not add up (synthetic)
//
// The synthetic ones are golden files the Rust tests generate; the real ones are
// the live verifier's own output for batches on public testnet
// (fixtures/testnet-ironwood-batch-8 and fixtures/testnet-ironwood-batch). All are
// bundled at build time with Vite's `?raw` import. There is no hand-copied
// duplicate to drift: if the core changes the wire format the files change, and
// parsePublicReceipt either accepts them or the contract test and the demo fail
// together.

import mismatchText from "../../../fixtures/contract/public-receipt-declared-mismatch.json?raw";
import findingsText from "../../../fixtures/contract/public-receipt-findings.json?raw";
import cleanText from "../../../fixtures/contract/public-receipt.json?raw";
import smokeText from "../../../fixtures/testnet-ironwood-batch/50fb88e02e7f4b0f3b3b658f50b09b12ea973d8c3697f8bad4c59e41075ea3e3/receipt.json?raw";
import realText from "../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/receipt.json?raw";

import { parsePublicReceipt, type PublicReceipt } from "./types";

export const DEMO_ID = "demo";

export type RealDemoCase = "real" | "real-smoke";
export type DemoCase = RealDemoCase | "clean" | "findings" | "mismatch";

/** The samples that are real batches on a public chain, not made-up data. */
export function isRealDemo(kind: DemoCase): kind is RealDemoCase {
  return kind === "real" || kind === "real-smoke";
}

const SAMPLES: Record<DemoCase, string> = {
  real: realText,
  "real-smoke": smokeText,
  clean: cleanText,
  findings: findingsText,
  mismatch: mismatchText,
};

/** The value of `?demo=` for each sample. */
const PARAM_TO_CASE: Readonly<Record<string, DemoCase>> = {
  real: "real",
  "real-smoke": "real-smoke",
  "1": "clean",
  findings: "findings",
  mismatch: "mismatch",
};

export interface DemoInfo {
  case: DemoCase;
  /** Link text, e.g. "A receipt with findings". */
  label: string;
  href: string;
  /** One sentence on what this sample shows. */
  summary: string;
}

/** What "Sample receipt" links to everywhere: the real 8-output batch. */
export const SAMPLE_RECEIPT_HREF = "/r/demo?demo=real";

/** Where each real sample comes from, as the page says it. Nothing here is live:
 * the receipts' confirmations are the depth when they were captured.
 *
 * - real: mined at 4,478,289; captured at tip 4,478,307 with 19 confirmations
 *   (fixtures/testnet-ironwood-batch-8/README.md).
 * - real-smoke: mined at 4,478,065; re-captured with 137 confirmations
 *   (fixtures/testnet-ironwood-batch/README.md), so at tip 4,478,201
 *   (4,478,065 + 137 - 1). */
export const REAL_CAPTURES: Readonly<
  Record<RealDemoCase, { network: string; minedAt: string; capturedAt: string }>
> = {
  real: { network: "public testnet", minedAt: "4,478,289", capturedAt: "4,478,307" },
  "real-smoke": { network: "public testnet", minedAt: "4,478,065", capturedAt: "4,478,201" },
};

export const DEMOS: readonly DemoInfo[] = [
  {
    case: "real",
    label: "A real batch of 8 outputs from public testnet",
    href: SAMPLE_RECEIPT_HREF,
    summary:
      "One batch with 8 shielded outputs, run through the operator on public testnet and read by the live verifier.",
  },
  {
    case: "real-smoke",
    label: "The first real batch, a smaller one",
    href: "/r/demo?demo=real-smoke",
    summary: "The first batch mined on public testnet, with 3 shielded outputs, as the live verifier read it.",
  },
  {
    case: "clean",
    label: "A campaign in progress",
    href: "/r/demo?demo=1",
    summary: "Two batches: one confirmed, one not built yet. Nothing is wrong.",
  },
  {
    case: "findings",
    label: "A receipt with findings",
    href: "/r/demo?demo=findings",
    summary: "The verifier could not confirm everything, and reports each problem.",
  },
  {
    case: "mismatch",
    label: "A declared total that does not add up",
    href: "/r/demo?demo=mismatch",
    summary: "The batches add up to a different total than the one declared.",
  },
];

/** The sample receipt for a case, validated like any receipt from the verifier. */
export function demoReceipt(kind: DemoCase = "clean"): PublicReceipt {
  return parsePublicReceipt(JSON.parse(SAMPLES[kind]));
}

/** Which sample /r/<id>?demo=<value> asks for, or null if it is not a demo
 * request. Only the id "demo" with exactly one known `demo` value qualifies. */
export function demoCase(id: string | undefined, params: URLSearchParams): DemoCase | null {
  if (id !== DEMO_ID) return null;
  const values = params.getAll("demo");
  if (values.length !== 1) return null;
  const value = values[0] ?? "";
  return Object.hasOwn(PARAM_TO_CASE, value) ? (PARAM_TO_CASE[value] ?? null) : null;
}
