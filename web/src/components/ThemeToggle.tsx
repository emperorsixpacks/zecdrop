import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { useAppearance } from "@/lib/appearance";

const ICON = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function Sun() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-5" {...ICON}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function Moon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-5" {...ICON}>
      <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />
    </svg>
  );
}

/** An icon button that says what pressing it will do ("Switch to light theme"),
 * never what the page is in, so it cannot be mistaken for a status label. It changes
 * the mode (light or dark). */
export function ThemeToggle() {
  const theme = useAppearance((s) => s.theme);
  const setTheme = useAppearance((s) => s.setTheme);
  const sync = useAppearance((s) => s.sync);
  // What <html> says is the truth; the store follows it when the page is first drawn.
  useEffect(() => {
    sync();
  }, [sync]);
  const isDark = theme === "dark";
  const label = isDark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={() => {
        setTheme(isDark ? "light" : "dark");
      }}
    >
      {isDark ? <Sun /> : <Moon />}
    </Button>
  );
}
