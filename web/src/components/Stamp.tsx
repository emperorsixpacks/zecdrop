import type { ReactNode } from "react";

/** The one stamp: it comes down once when a campaign settles. Under "reduce motion"
 * it is simply there. */
export function Stamp({ children }: { children: ReactNode }) {
  return <span className="stamp stamp-in">{children}</span>;
}
