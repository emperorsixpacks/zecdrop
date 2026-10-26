// Practice mode's simulation: the operator and the public verifier, answered from inside the page (openspec REQ-DEMO-001).
//
// This is the entry of a chunk of its own. src/lib/practice-mode.ts fetches it with a dynamic import when the flag is on or
// the visitor asks for practice mode, and not otherwise, so the app that nobody practises in does not carry it.
//
// What it does: answers every call the screens make to the operator's API (/health, /campaigns...) and to the verifier's
// (/v1/receipt), with the shapes, statuses and sentences of the real ones on the practice chain, so the screens' own strict
// parsers check it. What it does not: reach the network (nothing in this folder can: practice.test.tsx scans it), keep
// anything past the page (it is memory, and `dispose` empties it), or read a chain. A receipt or a payslip that is not one it
// made is not checked, and says so.

import type { ApiTransport } from "@/api/client";

import { EXAMPLE_LIST } from "./example";
import { browserRandom, type RandomBytes } from "./random";
import { PracticeServer } from "./server";

export interface Practice {
  /** Takes the place of the network for every API call (api/client.ts). */
  transport: ApiTransport;
  /** The text of the example payout list. */
  exampleList: string;
  /** Stops every timer and stream, and forgets every campaign. */
  dispose: () => void;
}

export interface PracticeOptions {
  /** Where ids come from: the browser's randomness unless a test says otherwise. */
  random?: RandomBytes;
  /** Seconds since the Unix epoch. */
  now?: () => number;
}

export function createPractice(options: PracticeOptions = {}): Practice {
  const server = new PracticeServer(options.random ?? browserRandom, options.now ?? (() => Math.floor(Date.now() / 1_000)));
  return {
    transport: (path, init) => server.answer(path, init),
    exampleList: EXAMPLE_LIST,
    dispose: () => {
      server.dispose();
    },
  };
}
