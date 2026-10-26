// How the page looks: Midnight, dark or light.
//
// The look is Midnight (src/index.css): a deep indigo page with a violet action and a teal
// second colour. Dark is what it is; the light set is the same family on a pale lavender-white,
// for people who switch, or whose system says light. The choice is a harmless UI convenience,
// so it is the one thing this app keeps in localStorage (with the motion setting, motion.ts).
// Every access is wrapped: storage can be blocked (private windows, disabled site data) and
// must never break rendering.

export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "zd:theme";

function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light";
}

export function readStoredTheme(): Theme | null {
  try {
    const raw = globalThis.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function storeTheme(theme: Theme): void {
  try {
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* storage unavailable: the choice just won't survive a reload */
  }
}

function systemPrefersLight(): boolean {
  return typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(prefers-color-scheme: light)").matches;
}

/** The saved choice; else light when the system says light; else dark, which is the look. */
export function resolveInitialTheme(): Theme {
  return readStoredTheme() ?? (systemPrefersLight() ? "light" : "dark");
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
}

/** What <html> says; dark, the look, when it says nothing. */
export function currentTheme(): Theme {
  const value = document.documentElement.dataset["theme"];
  return isTheme(value) ? value : "dark";
}
