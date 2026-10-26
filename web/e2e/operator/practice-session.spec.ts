import { expect, test } from "@playwright/test";

import { chooseFromIsland } from "../helpers.js";
import { operatorToken, operatorUrl } from "./env.js";

// Practice mode on a real local operator (openspec REQ-DEMO-001). The person has opened the operator's link, so the page holds the
// operator's token in memory, and then presses "Try a practice payout" on the home page. The operator's session must come through
// it: practice mode asks the operator for nothing, shows nothing of what the operator holds, and sends nothing the operator's token
// goes in; and when the person leaves, the operator's own screens work again with no link to open, and the token that goes out
// is the operator's.

test("a real operator session comes through practice mode: nothing is asked of the operator meanwhile, and its token is what calls carry again", async ({ page }) => {
  test.setTimeout(90_000);
  const real = `Bearer ${operatorToken()}`;
  /** Every call the page makes to the operator's API. Only whether the real token went with it is kept: the token is not
   * written anywhere a failure would print it. */
  const calls: { path: string; real: boolean; standIn: boolean }[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return;
    const authorization = request.headers()["authorization"] ?? "";
    calls.push({ path: url.pathname, real: authorization === real, standIn: authorization === "Bearer practice" });
  });

  // 1. The operator's link, opened: its screens work, and the operator answers.
  await page.goto(operatorUrl("/campaigns", { token: true }));
  await expect(page.getByRole("heading", { level: 1, name: "Payouts" })).toBeVisible();
  await expect(page.getByText("Seed: settled")).toBeVisible();
  expect(calls.filter((call) => call.path === "/api/campaigns").every((call) => call.real)).toBe(true);
  expect(calls.some((call) => call.standIn)).toBe(false);

  // 2. To the home page without a reload, which would forget the token: the footer's privacy page, then the public header's Home.
  await page.getByRole("link", { name: "How privacy works" }).click();
  await chooseFromIsland(page, "Home");
  await expect(page.getByRole("heading", { level: 1, name: /Pay many people/u })).toBeVisible();
  const before = calls.length;

  // 3. Practice mode: its own screens, and what the operator holds is not on them, not even for a moment while they are drawn from
  // what the page held (the operator's payouts it had just listed).
  await page.evaluate(() => {
    const seen = window as unknown as { __operatorsPayoutShown: boolean };
    seen.__operatorsPayoutShown = false;
    new MutationObserver(() => {
      if (document.body.textContent.includes("Seed: ")) seen.__operatorsPayoutShown = true;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.getByRole("button", { name: "Try a practice payout" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Add the payouts" })).toBeVisible();
  await page.getByRole("button", { name: "Use the example list" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Check the payouts" })).toBeVisible();
  await chooseFromIsland(page, "Payouts");
  await expect(page.getByRole("heading", { level: 1, name: "Payouts" })).toBeVisible();
  await expect(page.getByText("Practice mode: everything here is simulated in your browser.")).toBeVisible();
  // The list is the simulation's (the payout just added), not the operator's: none of the operator's campaigns is on it.
  await expect(page.getByRole("list", { name: "Payouts" }).getByRole("listitem")).toHaveCount(1);
  for (const name of ["Seed: awaiting funding", "Seed: funded", "Seed: settled"]) await expect(page.getByText(name)).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __operatorsPayoutShown: boolean }).__operatorsPayoutShown), "one of the operator's payouts was on a practice screen").toBe(false);
  // Nothing was asked of the operator, and nothing went out with its token or with the stand-in.
  expect(calls.slice(before)).toEqual([]);

  // 4. Leaving: back to the start, the operator's screens open again with no link to open, and they show the operator's own.
  await page.getByRole("region", { name: "Practice mode", exact: true }).getByRole("button", { name: "Leave practice mode" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Pay many people/u })).toBeVisible();
  await expect(page.getByRole("region", { name: "Practice mode", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Running a payout? Open the operator app" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Payouts" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Open the operator link" })).toHaveCount(0);
  for (const name of ["Seed: awaiting funding", "Seed: funded", "Seed: settled"]) await expect(page.getByText(name)).toBeVisible();
  const after = calls.slice(before);
  expect(after.length).toBeGreaterThan(0);
  expect(after.filter((call) => call.path === "/api/campaigns").every((call) => call.real)).toBe(true);
  // The stand-in never left the page, at any point.
  expect(calls.some((call) => call.standIn)).toBe(false);
});
