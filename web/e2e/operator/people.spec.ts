import { expect, test, type Page } from "@playwright/test";

import { axeViolations, NARROWEST, overflowReport, THEMES, useTheme, VIEWPORTS } from "../helpers.js";
import { operatorUrl } from "./env.js";

// The payout list built in the page (REQ-IMP-002), against the real operator binary on the mock chain: three people
// typed in by hand, notes with commas, quotes and letters of other languages, a lucky split of a total, and the
// operator's own importer reading the text the page wrote. Then the screen itself at phone and desktop width, in both
// themes: nothing wider than the screen and no accessibility violation.

const PEOPLE = [
  { address: "u1peoplespecaddressone", note: 'For Ada, "with love", from all of us' },
  { address: "u1peoplespecaddresstwo", note: "Ẹ ku ọdun; happy new year" },
  { address: "u1peoplespecaddressthree", note: "" },
] as const;

async function fillPeople(page: Page) {
  for (const [i, person] of PEOPLE.entries()) {
    if (i > 0) await page.getByRole("button", { name: "Add a person" }).click();
    const group = page.getByRole("group", { name: `Person ${String(i + 1)}` });
    await group.getByLabel("Address").fill(person.address);
    if (person.note !== "") await group.getByLabel("Note they'll see").fill(person.note);
  }
}

/** The ZEC (or TAZ) amount a person's row shows, in zatoshi. */
async function shareOf(page: Page, n: number): Promise<bigint> {
  const text = await page.getByRole("group", { name: `Person ${String(n)}` }).getByText(/^\d+(\.\d+)? TAZ$/u).innerText();
  const [whole = "0", fraction = ""] = text.replace(" TAZ", "").split(".");
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
}

// covers: REQ-IMP-002
test("three people typed in, a lucky split, and the operator's importer takes the list as the page wrote it", async ({ page }) => {
  await page.goto(operatorUrl("/new", { token: true }));
  await expect(page.getByRole("heading", { level: 1, name: "Add the payouts" })).toBeVisible();
  await page.getByLabel("Name this payout run").fill(`People list ${String(Date.now())}`);
  await fillPeople(page);
  await page.getByRole("radio", { name: "Lucky" }).click();
  await page.getByLabel("Total to split").fill("0.3");
  await expect(page.getByTestId("payout-count")).toHaveText("3 people");
  await expect(page.getByTestId("payout-total")).toContainText("0.3");

  const shares = [await shareOf(page, 1), await shareOf(page, 2), await shareOf(page, 3)];
  expect(shares.reduce((a, b) => a + b, 0n)).toBe(30_000_000n);
  expect(new Set(shares).size).toBeGreaterThan(1);

  await page.getByRole("button", { name: "Continue" }).click();
  // The operator read the text: three payouts, the exact total, and no equal-amount warning for a lucky split.
  await expect(page.getByRole("heading", { level: 1, name: "Check the payouts" })).toBeVisible();
  await expect(page.getByText("0.3 TAZ").first()).toBeVisible();
  await expect(page.getByText(/^3 people/u).first()).toBeVisible();
  await expect(page.getByText(/equal amounts are easy to see/u)).toHaveCount(0);
});

for (const theme of THEMES) {
  for (const viewport of [NARROWEST, ...VIEWPORTS]) {
    test(`the people list at ${viewport.name}, ${theme}: fits the screen and passes axe`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await useTheme(page, theme);
      await page.goto(operatorUrl("/new", { token: true }));
      await fillPeople(page);
      await page.getByRole("radio", { name: "Even" }).click();
      await page.getByLabel("Total to split").fill("0.01");
      await expect(page.getByText(/^Each gets 0\.00333333 TAZ\./u)).toBeVisible();
      // A row with a problem showing, so its colours are checked too.
      await page.getByRole("button", { name: "Add a person" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByText("Add their address.")).toBeVisible();

      const overflow = await overflowReport(page);
      expect(overflow.page, "sideways scroll").toBeLessThanOrEqual(0);
      expect(overflow.wide, "wider than the screen").toEqual([]);
      expect(await axeViolations(page)).toEqual([]);
    });
  }
}
