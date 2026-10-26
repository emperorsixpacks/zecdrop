import { useState } from "react";

import { Button } from "@/components/ui/button";
import { applyTheme, currentTheme, storeTheme } from "@/lib/theme";

/** A toggle button: the label stays "Light theme" and `aria-pressed` carries
 * the state, which is how assistive tech expects a two-state switch. */
export function ThemeToggle() {
  const [isLight, setIsLight] = useState(() => currentTheme() === "light");

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={isLight}
      onClick={() => {
        const next = isLight ? "dark" : "light";
        applyTheme(next);
        storeTheme(next);
        setIsLight(!isLight);
      }}
    >
      Light theme
    </Button>
  );
}
