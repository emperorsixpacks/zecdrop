import { useEffect } from "react";

import { Segmented } from "@/components/Segmented";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAppearance } from "@/lib/appearance";
import { prefersReducedMotion } from "@/lib/motion";

/** The look of the page, in one small panel: light or dark, and how much
 * it moves. Each choice applies at once and is remembered on this device. */
export function AppearanceMenu() {
  const { theme, motion, setTheme, setMotion, sync } = useAppearance();
  useEffect(() => {
    sync();
  }, [sync]);
  const reduced = prefersReducedMotion();

  return (
    <Popover>
      <PopoverTrigger
        aria-label="Appearance"
        title="Appearance"
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground hover:bg-secondary"
      >
        <svg aria-hidden viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
          <circle cx="15" cy="7" r="2" />
          <circle cx="9" cy="17" r="2" />
        </svg>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(18rem,calc(100vw-1.5rem))] space-y-5">
        <div className="space-y-2">
          <p className="text-base font-bold">Mode</p>
          <Segmented
            label="Mode"
            value={theme}
            onValueChange={setTheme}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </div>
        <div className="space-y-2">
          <p className="text-base font-bold">Motion</p>
          <Segmented
            label="Motion"
            value={motion}
            onValueChange={setMotion}
            options={[
              { value: "calm", label: "Calm" },
              { value: "lively", label: "Lively", disabled: reduced },
            ]}
          />
          {reduced && <p className="text-sm text-muted-foreground">Your system asks for reduced motion, so this stays Calm.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
