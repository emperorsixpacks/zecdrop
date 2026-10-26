import { useSyncExternalStore } from "react";

/** Whether a media query matches, kept up to date. For choosing WHERE a single element goes (one
 * button in the first line on a wide screen, in the status line on a phone) without drawing it
 * twice and hiding one copy. Where there is no matchMedia (a test) it does not match. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof globalThis.matchMedia !== "function") return () => undefined;
      const list = globalThis.matchMedia(query);
      list.addEventListener("change", notify);
      return () => {
        list.removeEventListener("change", notify);
      };
    },
    () => typeof globalThis.matchMedia === "function" && globalThis.matchMedia(query).matches,
    () => false,
  );
}
