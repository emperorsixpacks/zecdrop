import { isPublicMode } from "@/lib/mode";
import { usePractice } from "@/lib/practice-mode";

import { HostedNotice } from "./HostedNotice";
import { OperatorLayout } from "./OperatorLayout";

/** The operator routes' parent: the operator UI when the page is the local
 * operator's, and the explainer when it is a hosted public copy. The explainer
 * path never mounts the operator layout, so no operator call is made.
 *
 * In practice mode the operator UI is drawn on any copy, hosted or not: its calls are answered by the
 * simulation inside the page, so there is no operator to be missing. */
export function OperatorArea() {
  const practice = usePractice((state) => state.on);
  return practice || !isPublicMode() ? <OperatorLayout /> : <HostedNotice />;
}
