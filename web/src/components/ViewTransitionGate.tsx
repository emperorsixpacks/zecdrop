import { useLayoutEffect } from "react";
import { useLocation } from "react-router";

import { pageCommitted } from "@/lib/view-transition";

/** Tells the view transition (src/lib/view-transition.ts) when a new page is on the screen. Draws nothing. */
export function ViewTransitionGate() {
  const { key } = useLocation();
  useLayoutEffect(() => {
    pageCommitted();
  }, [key]);
  return null;
}
