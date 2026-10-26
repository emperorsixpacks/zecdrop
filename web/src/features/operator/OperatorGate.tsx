import type { ReactNode } from "react";

import { useSession } from "@/api/operator/session";

import { OpenOperatorLink } from "./OpenOperatorLink";

/** Shows the operator pages only when there is a token to use. Otherwise it
 * explains how to open the operator link, instead of letting every page fail
 * on its own with a 401. */
export function OperatorGate({ children }: { children: ReactNode }) {
  const status = useSession((s) => s.status);
  if (status === "ready") return <>{children}</>;
  return <OpenOperatorLink reason={status === "rejected" ? "rejected" : "missing"} />;
}
