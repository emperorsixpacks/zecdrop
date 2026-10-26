import { isPublicMode } from "@/lib/mode";

import { HostedNotice } from "./HostedNotice";
import { OperatorLayout } from "./OperatorLayout";

/** The operator routes' parent: the operator UI when the page is the local
 * operator's, and the explainer when it is a hosted public copy. The explainer
 * path never mounts the operator layout, so no operator call is made. */
export function OperatorArea() {
  return isPublicMode() ? <HostedNotice /> : <OperatorLayout />;
}
