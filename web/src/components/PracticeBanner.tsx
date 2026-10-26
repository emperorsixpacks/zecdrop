import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { beginLeavingPractice, PRACTICE_BANNER, stopPractice, usePractice } from "@/lib/practice-mode";

function Banner() {
  const navigate = useNavigate();
  return (
    <section aria-label="Practice mode" className="hatched border-b border-foreground/50">
      <div className="mx-auto flex w-full max-w-[68rem] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3">
        <p className="max-w-[64ch] text-base font-medium">{PRACTICE_BANNER}</p>
        <Button
          variant="outline"
          onClick={() => {
            beginLeavingPractice();
            void navigate("/");
          }}
        >
          Leave practice mode
        </Button>
      </div>
    </section>
  );
}

/** What every screen says while practice mode is on, at the top of it, with the way out. It is part of the page's frame
 * (Shell), so no screen can be drawn without it, and nothing is drawn of it when practice mode is off. */
export function PracticeBanner() {
  const on = usePractice((state) => state.on);
  return on ? <Banner /> : null;
}

/** Finishes leaving practice mode, once the screens that showed the payout are gone and the start page is up: then the
 * simulation is taken away, and what the screens held of the payout goes with it. Doing it before would leave a screen
 * still mounted, asking for its data again from a simulation that is no longer there. Always mounted, so it does not
 * matter which screen the person was on. */
export function PracticeLeaver() {
  const leaving = usePractice((state) => state.leaving);
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!leaving || pathname !== "/") return;
    stopPractice();
    queryClient.clear();
  }, [leaving, pathname, queryClient]);
  return null;
}
