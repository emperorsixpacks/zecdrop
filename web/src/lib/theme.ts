// How the page looks: Redacted paper, light or dark.
//
// The look is Redacted paper (src/index.css): a white sheet on a grey desk with black redaction
// bars, in ink alone (no colour accent). Light is the page; the dark set is the same page after
// hours, for people who switch, or whose system says dark. The choice is a harmless UI convenience,
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

function systemPrefersDark(): boolean {
  return typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** The saved choice; else dark when the system says dark; else light, which is the look. */
export function resolveInitialTheme(): Theme {
  return readStoredTheme() ?? (systemPrefersDark() ? "dark" : "light");
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
}

/** What <html> says; light, the look, when it says nothing. */
export function currentTheme(): Theme {
  const value = document.documentElement.dataset["theme"];
  return isTheme(value) ? value : "light";
}
