import { expect, test, type Page } from "@playwright/test";

import { axeViolations, capsuleInside, island, widerThanTheScreen } from "../helpers.js";
import { operatorUrl } from "./env.js";

// A whole payout, the operator's own screens, on the smallest phone, in landscape and on a tablet, through the real operator on
// the mock chain (WCAG 2.2, 1.4.10 Reflow). The public pages are walked at every width by ../responsive.spec.ts. Each screen is
// checked as it comes: nothing is wider than the screen, the capsule is whole and inside it, and the sheet that asks before
// sending fits the window or scrolls, with both of its buttons reachable.

/** From the example list to a settled payout, with every screen checked as it comes. */
async function payout(page: Page, width: number, height: number) {
  await page.goto(operatorUrl("/new", { token: true }));
  await expect(page.getByRole("heading", { level: 1, name: "Add the payouts" })).toBeVisible();
  const seen: Record<string, string[]> = {};
  const look = async (screen: string) => {
    seen[screen] = await widerThanTheScreen(page);
    await capsuleInside(page, width);
  };
  await look("add the payouts");
  await page.getByRole("button", { name: "Use the example list" }).click();
  await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
  await look("the example list");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Check the payouts" })).toBeVisible();
  await look("check");
  await page.getByRole("link", { name: "Looks right, continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Fund and send" })).toBeVisible();
  await look("fund");
  await page.getByRole("button", { name: "Record mock deposit" }).click();
  await expect(page.getByText(/in deposit/u)).toBeVisible();
  await page.getByRole("button", { name: "Send 8 payouts" }).click();

  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox()) as { x: number; y: number; width: number; height: number };
  expect(box.x, "the sheet starts inside the screen").toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, "the sheet ends inside the screen").toBeLessThanOrEqual(width + 0.5);
  expect(box.y, "the sheet starts inside the window").toBeGreaterThanOrEqual(-0.5);
  expect(box.y + box.height, "the sheet ends inside the window").toBeLessThanOrEqual(height + 0.5);
  const scrolls = await sheet.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 || ["auto", "scroll"].includes(getComputedStyle(el).overflowY));
  expect(scrolls, "a sheet taller than its window scrolls").toBe(true);
  for (const name of ["Send 8 payouts", "Cancel"]) {
    const button = sheet.getByRole("button", { name });
    await button.scrollIntoViewIfNeeded();
    const where = (await button.boundingBox()) as { y: number; height: number };
    expect(where.y, `${name} is inside the window`).toBeGreaterThanOrEqual(0);
    expect(where.y + where.height, `${name} is inside the window`).toBeLessThanOrEqual(height + 0.5);
  }

  await sheet.getByRole("button", { name: "Send 8 payouts" }).click();
  await expect(page).toHaveURL(/\/campaign\/c-[0-9a-f]{12}$/u);
  await look("sending");
  await expect(page.getByText("Complete: all batches confirmed").first()).toBeVisible({ timeout: 90_000 });
  await look("settled");
  return seen;
}

test.describe("a whole payout, on a small phone and in landscape", () => {
  for (const [name, width, height] of [
    ["the smallest phone, 320x568", 320, 568],
    ["a phone in landscape, 667x375", 667, 375],
    ["a tablet in portrait, 768x1024", 768, 1024],
  ] as const) {
    test(`${name}: every screen fits the screen`, async ({ page }) => {
      test.setTimeout(150_000);
      await page.setViewportSize({ width, height });
      const seen = await payout(page, width, height);
      for (const [screen, wider] of Object.entries(seen)) expect(wider, `${screen}: wider than the screen`).toEqual([]);
    });
  }
});

// The screen (web/DESIGN.md, "The screen"; the public pages' side is in ../screen.spec.ts): the sheet that asks before sending is a
// modal dialog in the browser's top layer, above the frame, and on a phone its bottom corners follow the screen's own.
test.describe("the confirm sheet on a phone", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("is above the frame, and sits inside the curve", async ({ page }) => {
    await page.goto(operatorUrl("/new", { token: true }));
    await page.getByRole("button", { name: "Use the example list" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("link", { name: "Looks right, continue" }).click();
    await page.getByRole("button", { name: "Record mock deposit" }).click();
    await expect(page.getByText(/in deposit/u)).toBeVisible();
    await page.getByRole("button", { name: "Send 8 payouts" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    expect(await sheet.evaluate((el) => el.matches(":modal"))).toBe(true);
    const box = (await sheet.boundingBox()) as { x: number; y: number; width: number; height: number };
    // The sheet's corners: its bottom ones follow the screen's own, and it is a bezel's width in from the edges.
    expect(box.x).toBe(6);
    expect(box.x + box.width).toBe(390 - 6);
    expect(box.y + box.height).toBe(800 - 6);
    const radii = await sheet.evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.borderTopLeftRadius, s.borderBottomLeftRadius];
    });
    expect(radii).toEqual(["20px", "26px"]);
    expect(await axeViolations(page), "the sheet over the frame").toEqual([]);
  });
});

// A page opened by a link starts at its top (../scroll.spec.ts has the reason): here, the stage after "Looks right, continue",
// pressed at the foot of a long page.
for (const width of [360, 1280]) {
  test.describe(`the stages of a payout, at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test("open at their top: the page after 'Looks right, continue'", async ({ page }) => {
      await page.goto(operatorUrl("/new", { token: true }));
      await page.getByRole("button", { name: "Use the example list" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Check the payouts" })).toBeVisible();
      const next = page.getByRole("link", { name: "Looks right, continue" });
      await next.scrollIntoViewIfNeeded();
      await page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      await next.click();
      const heading = page.getByRole("heading", { level: 1, name: "Fund and send" });
      await expect(heading).toBeVisible();
      expect(await page.evaluate(() => window.scrollY), "the funding screen is at its top").toBe(0);
      const title = await heading.boundingBox();
      const capsule = await island(page).boundingBox();
      expect((title as { y: number }).y, "its heading is below the capsule").toBeGreaterThanOrEqual((capsule as { y: number; height: number }).y + (capsule as { height: number }).height);
    });
  });
}
