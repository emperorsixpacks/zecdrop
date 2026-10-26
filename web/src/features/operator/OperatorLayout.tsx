import { Outlet } from "react-router";

import { Shell } from "@/components/AppShell";
import { UnitProvider } from "@/components/UnitProvider";
import { config } from "@/lib/config";

import { useHealth } from "./hooks";
import { OperatorGate } from "./OperatorGate";
import { OperatorStatusBar } from "./OperatorStatusBar";

/** Routes served by the local operator app: the operator menu, the persistent
 * mock-chain banner, and the gate that asks for the operator link. The network
 * badge shows the OPERATOR's network, not the page's build default. */
export function OperatorLayout() {
  const health = useHealth();
  return (
    <Shell
      showOperatorNav
      {...(health.data ? { network: health.data.network, mock: health.data.mock === true } : {})}
      banner={<OperatorStatusBar />}
    >
      {/* Amounts are in the coin of the OPERATOR's network. */}
      <UnitProvider network={health.data?.network ?? config.network}>
        <OperatorGate>
          <Outlet />
        </OperatorGate>
      </UnitProvider>
    </Shell>
  );
}
