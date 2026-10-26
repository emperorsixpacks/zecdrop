import { Outlet, useMatch } from "react-router";

import { Tracker, type TrackerStage } from "@/components/Tracker";

const STAGES: readonly TrackerStage[] = [
  { key: "payouts", label: "Payouts" },
  { key: "check", label: "Check" },
  { key: "send", label: "Send" },
];

/** The frame of the three stages: the slim tracker on top, the stage below. The
 * stage comes from the URL (/new, /new/check, /new/send), so there is no second
 * copy of "where am I" to fall out of sync. */
export default function PayoutFlow() {
  const here = useMatch("/new/:stage")?.params.stage;
  const onFirst = useMatch({ path: "/new", end: true }) !== null;
  const current = onFirst ? 0 : here === "check" ? 1 : here === "send" ? 2 : -1;

  return (
    <div className="space-y-10">
      {current >= 0 && <Tracker stages={STAGES} current={current} />}
      <Outlet />
    </div>
  );
}
