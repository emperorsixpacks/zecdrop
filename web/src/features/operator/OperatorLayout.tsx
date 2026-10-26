import { Outlet } from "react-router";

import { Shell } from "@/components/AppShell";
import { UnitProvider } from "@/components/UnitProvider";
import { config } from "@/lib/config";

import { useHealth } from "./hooks";
import { OperatorGate } from "./OperatorGate";
import { OperatorHealthNotice } from "./OperatorHealthNotice";

/** Routes served by the local operator app: the operator header (with the
 * fake-chain pill when the operator is on the mock chain) and the gate that
 * asks for the operator link. The network pill shows the OPERATOR's network, not
 * the page's build default. */
export function OperatorLayout() {
  const health = useHealth();
  return (
    <Shell
      showOperatorNav
      {...(health.data ? { network: health.data.network, mock: health.data.mock === true, modeUnknown: health.data.mock === null } : {})}
    >
      {/* Amounts are in the coin of the OPERATOR's network. */}
      <UnitProvider network={health.data?.network ?? config.network}>
        <OperatorHealthNotice />
        <OperatorGate>
          <Outlet />
        </OperatorGate>
      </UnitProvider>
    </Shell>
  );
}
