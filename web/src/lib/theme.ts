// Theme preference: dark by default, light on request or when the OS asks.
//
// The preference is a harmless UI convenience, so it is the one thing this
// app keeps in localStorage. Every access is wrapped: storage can be blocked
// (private windows, disabled site data) and must never break rendering.

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

/** Stored choice wins, then the OS preference, then dark (dark-first). */
export function resolveInitialTheme(): Theme {
  const stored = readStoredTheme();
  if (stored) return stored;
  if (
    typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    return "light";
  }
  return "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
}

export function currentTheme(): Theme {
  const value = document.documentElement.dataset["theme"];
  return isTheme(value) ? value : "dark";
}
