// Practice mode: the operator's own screens, run against a simulation inside the page (openspec REQ-DEMO-001).
//
// This file is the part that is always in the app, and it is small on purpose: the flag, the marker that says a value is
// simulated, and the switch. The simulation itself (src/practice) is a chunk of its own that is fetched only when practice
// mode starts, from the page's own origin like the rest of the app, so a visitor who never turns it on never loads it.
//
// What practice mode leaves behind is one flag in sessionStorage, and that goes when the tab does. The simulation's state
// is in memory, so reloading starts over. While it is on, every call the app makes to an operator or a verifier (see
// sendToApi in api/client.ts) is answered by the simulation and never reaches the network.

import { create } from "zustand";

import { installApiTransport } from "@/api/client";
import { enterPracticeSession, leavePracticeSession } from "@/api/operator/session";
import { useWizardDraft } from "@/features/wizard/draft";
import type { Practice } from "@/practice/simulation";

/** The one thing practice mode writes to browser storage: "1" while it is on. */
export const PRACTICE_KEY = "zecdrop.practice";
const FLAG_ON = "1";

/** What every screen says while practice mode is on. */
export const PRACTICE_BANNER =
  "Practice mode: everything here is simulated in your browser. No real money, nothing is sent anywhere, nothing is saved. Reloading starts over.";

/** Every simulated 64-hex value (a transaction id, a list fingerprint) begins with these eight bytes, which are the ASCII
 * of "practice". No chain has such an id, so it cannot be taken for one by anyone who decodes it, and the page can tell it
 * is simulated by looking at it. */
export const PRACTICE_MARKER = "7072616374696365";

/** Whether a 64-hex id is one practice mode made. Such an id is on no chain: it gets no explorer link. */
export function isPracticeId(hex: string): boolean {
  return /^[0-9a-f]{64}$/u.test(hex) && hex.startsWith(PRACTICE_MARKER);
}

/** Where practice mode gets its randomness: `length` random bytes. */
export type RandomBytes = (length: number) => Uint8Array;

export const browserRandom: RandomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

/** A 64-hex id that begins with the practice marker: a transaction id or a list fingerprint that is on no chain. */
export function practiceId(random: RandomBytes = browserRandom): string {
  return `${PRACTICE_MARKER}${Array.from(random(24), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// ---- the flag ------------------------------------------------------------------------------

function flagIsSet(): boolean {
  try {
    return globalThis.sessionStorage.getItem(PRACTICE_KEY) === FLAG_ON;
  } catch {
    return false;
  }
}

function setFlag(): void {
  try {
    globalThis.sessionStorage.setItem(PRACTICE_KEY, FLAG_ON);
  } catch {
    // No storage: practice mode works for as long as this page does, and the next load is not in it.
  }
}

function clearFlag(): void {
  try {
    globalThis.sessionStorage.removeItem(PRACTICE_KEY);
  } catch {
    // Nothing to remove from.
  }
}

/** Whether the flag says this tab was in practice mode (read at start-up, to carry on after a reload). */
export function hasPracticeFlag(): boolean {
  return flagIsSet();
}

// ---- the state the screens read -------------------------------------------------------------

interface PracticeState {
  /** True from the moment the simulation answers the app's calls until practice mode is left. */
  on: boolean;
  /** The example payout list the payouts screen offers, once the simulation is loaded. */
  exampleList: string | null;
  /** The person has asked to leave and the screens are on their way out (see PracticeLeaver). */
  leaving: boolean;
}

export const usePractice = create<PracticeState>(() => ({ on: false, exampleList: null, leaving: false }));

/** Ask to leave practice mode. The screens still showing the payout go first, and only then is the simulation taken away
 * (PracticeLeaver), so that no screen is left asking a network that was never meant to be asked. */
export function beginLeavingPractice(): void {
  if (usePractice.getState().on) usePractice.setState({ leaving: true });
}

// ---- the switch -----------------------------------------------------------------------------

/** How the simulation is fetched: a dynamic import, so it is a chunk of its own. Replaceable, so a test can make it fail. */
export type SimulationLoader = () => Promise<{ createPractice: () => Practice }>;

const loadSimulation: SimulationLoader = () => import("@/practice/simulation");

let starting: Promise<void> | null = null;
let stopRunning: (() => void) | null = null;

/** Turn practice mode on: load the simulation, let it answer the app's API calls, write the flag. Rejects, with nothing
 * changed, if the simulation cannot be loaded. Turning it on twice is the same as once. */
export function startPractice(load: SimulationLoader = loadSimulation): Promise<void> {
  if (stopRunning !== null) return Promise.resolve();
  starting ??= (async () => {
    try {
      const { createPractice } = await load();
      const practice = createPractice();
      const uninstall = installApiTransport(practice.transport);
      enterPracticeSession();
      stopRunning = () => {
        uninstall();
        practice.dispose();
        leavePracticeSession();
      };
      setFlag();
      // Practice starts from a clean sheet: what was being added to the wizard before is not part of it.
      useWizardDraft.getState().reset();
      usePractice.setState({ on: true, exampleList: practice.exampleList, leaving: false });
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/** Turn practice mode off: take the simulation out of the way, stop everything it was running, forget what it held,
 * and remove the flag. After this the app talks to the network again, as it did before. */
export function stopPractice(): void {
  stopRunning?.();
  stopRunning = null;
  clearFlag();
  usePractice.setState({ on: false, exampleList: null, leaving: false });
  // Whatever a practice payout put in the wizard is not the next person's to see.
  useWizardDraft.getState().reset();
}

/** At start-up, before anything is drawn: if the tab was in practice mode, carry on in it, with a simulation that starts
 * empty (so reloading starts over). If the simulation cannot be loaded the tab leaves practice mode and the app starts as it
 * normally does, so nothing is ever drawn without a simulation to answer for it. */
export async function resumePractice(load: SimulationLoader = loadSimulation): Promise<void> {
  if (!flagIsSet()) return;
  try {
    await startPractice(load);
  } catch {
    clearFlag();
  }
}
