// One place that holds how the page looks and moves (theme, motion), applies it to <html>,
// and remembers it. The header's button and the appearance panel both read and change it here,
// so they cannot disagree.

import { create } from "zustand";

import { applyMotion, currentMotion, prefersReducedMotion, resolveInitialMotion, storeMotion, type Motion } from "./motion";
import { applyTheme, currentTheme, resolveInitialTheme, storeTheme, type Theme } from "./theme";

interface AppearanceState {
  theme: Theme;
  motion: Motion;
  /** Read what is on <html> (set before the first render). */
  sync: () => void;
  setTheme: (theme: Theme) => void;
  setMotion: (motion: Motion) => void;
}

/** Set <html> from what was saved. Called once, before the first render, so there is no flash. */
export function initAppearance(): void {
  applyTheme(resolveInitialTheme());
  applyMotion(resolveInitialMotion());
  useAppearance.getState().sync();
}

export const useAppearance = create<AppearanceState>()((set) => ({
  theme: currentTheme(),
  motion: currentMotion(),
  sync: () => {
    set({ theme: currentTheme(), motion: currentMotion() });
  },
  setTheme: (theme) => {
    applyTheme(theme);
    storeTheme(theme);
    set({ theme });
  },
  setMotion: (motion) => {
    // The system's "reduce motion" is not overruled.
    if (prefersReducedMotion()) return;
    applyMotion(motion);
    storeMotion(motion);
    set({ motion });
  },
}));
