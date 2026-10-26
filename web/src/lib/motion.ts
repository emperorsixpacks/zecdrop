// How much the page moves: Calm or Lively.
//
// Lively is the default: counts run up, bars wipe away in a stagger, the sealed stamp
// throws a little confetti, a soft glow drifts behind the page. Calm keeps the useful
// motion (the lens wipe, the sending timeline) short and drops the rest. A person who has
// asked their system for reduced motion gets Calm and no choice: nothing animates for them
// (src/index.css switches every animation and transition off), and the confetti and the
// glow are not even drawn.
//
// The choice is a harmless UI convenience, kept in localStorage with the theme.

export type Motion = "calm" | "lively";

export const MOTION_STORAGE_KEY = "zd:motion";

function isMotion(value: unknown): value is Motion {
  return value === "calm" || value === "lively";
}

/** The system's "reduce motion" setting. Without matchMedia (a test) it is treated as set. */
export function prefersReducedMotion(): boolean {
  return typeof globalThis.matchMedia !== "function" || globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function readStoredMotion(): Motion | null {
  try {
    const raw = globalThis.localStorage.getItem(MOTION_STORAGE_KEY);
    return isMotion(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function storeMotion(motion: Motion): void {
  try {
    globalThis.localStorage.setItem(MOTION_STORAGE_KEY, motion);
  } catch {
    /* storage unavailable: the choice just won't survive a reload */
  }
}

/** The saved choice, else Lively; Calm whatever was saved when the system asks for reduced motion. */
export function resolveInitialMotion(): Motion {
  if (prefersReducedMotion()) return "calm";
  return readStoredMotion() ?? "lively";
}

export function applyMotion(motion: Motion): void {
  document.documentElement.dataset["motion"] = motion;
}

export function currentMotion(): Motion {
  const value = document.documentElement.dataset["motion"];
  return isMotion(value) ? value : "calm";
}

/** How long a JS-driven animation lasts, as a fraction of its Lively length: none when
 * reduced, short when Calm. CSS animations get the same from --motion in index.css. */
export function motionScale(): number {
  if (prefersReducedMotion()) return 0;
  return currentMotion() === "calm" ? 0.3 : 1;
}

/** True when decoration (confetti, the glow) may be drawn. */
export function isLively(): boolean {
  return !prefersReducedMotion() && currentMotion() === "lively";
}
