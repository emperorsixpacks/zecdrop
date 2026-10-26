// Everything a person does to send a practice payout, from the home page to the simulated receipt, with a look at every screen on
// the way: `here` is called on each, with a name for it, so that a test can check what it needs of every screen (that the banner
// is on it, that its words claim nothing they should not) without walking the flow again.
import { screen, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";

type User = ReturnType<typeof userEvent.setup>;

/** `settleMs` is how long the simulated run may take, which a test makes a few milliseconds a step: a test that slows the run
 * down (to look at what it says on the way) says how long it now lasts. It is a limit, not a wait: a run that is over sooner
 * ends the wait sooner. */
export async function practicePayout(
  user: User,
  here: (where: string) => void | Promise<void>,
  { settleMs = 6_000 }: { settleMs?: number } = {},
): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Try a practice payout" }));

  // 1. Add the payouts, with the example list.
  await screen.findByRole("heading", { level: 1, name: "Add the payouts" });
  await here("the payouts screen");
  await user.click(screen.getByRole("button", { name: "Use the example list" }));
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await here("the payouts screen with the example list");

  // 2. Check them: the lens and the privacy notes.
  await screen.findByRole("heading", { level: 1, name: "Check the payouts" });
  await here("the check screen");
  await user.click(screen.getByRole("link", { name: "Looks right, continue" }));

  // 3. Fund it with the pretend deposit, as on the practice chain.
  await screen.findByRole("heading", { level: 1, name: "Fund and send" });
  await here("the funding screen");
  await user.click(await screen.findByRole("button", { name: "Record mock deposit" }));
  await screen.findByText("Funded.");
  await here("the funded campaign");

  // 4. Send: the sheet, then the sending timeline.
  await user.click(await screen.findByRole("button", { name: "Send 8 payouts" }));
  await here("the send sheet");
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Send 8 payouts" }));
  await screen.findByRole("heading", { level: 2, name: "Sending the payouts" });
  await here("the sending timeline");
  await screen.findByRole("heading", { level: 2, name: "All 1 batch is confirmed" }, { timeout: settleMs });
  await here("the settled campaign");

  // 5. Open the simulated public receipt.
  await user.click(await screen.findByRole("link", { name: "Open public receipt" }));
  await screen.findByRole("heading", { level: 1, name: "Payout receipt" });
  await screen.findByRole("heading", { level: 2, name: "Status" });
  await here("the simulated receipt");
}
