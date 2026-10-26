import { expect, test, type Locator, type Page } from "@playwright/test";

import { overflowReport } from "./helpers.js";

// Phones, as they are. The other specs run at 360px and at 1280px; this one runs the widths in between and below (WCAG 2.2, 1.4.10
// Reflow: no sideways scroll at 320px, which is also what a desktop window gets at 400% zoom) on every public page, and the whole
// practice payout, the operator's screens, on the smallest phone and in landscape. What it asks of each screen: that nothing is wider
// than the screen (the page itself, and any box that is not inside one that scrolls or hides its own overflow), that the capsule is
// whole and inside the screen, and that a dialog fits the window or scrolls.

const WIDTHS = [320, 340, 360, 375, 414, 600, 768, 1024] as const;
const PUBLIC_PAGES = [
  ["the home page", "/"],
  ["get paid", "/get-paid"],
  ["check a payslip", "/payslip"],
  ["how privacy works", "/privacy"],
  ["a receipt", "/r/demo?demo=real"],
  ["a receipt with findings", "/r/demo?demo=findings"],
  ["a page that is not there", "/nope"],
] as const;

/** What is wider than the screen, from the width the layout has (not `innerWidth`, which a phone widens to fit a wide page, and so
 * never says a page is too wide). Empty when nothing is. */
async function widerThanTheScreen(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const found: string[] = [];
    if (document.documentElement.scrollWidth > width) found.push(`the page scrolls sideways: ${String(document.documentElement.scrollWidth)} in ${String(width)}`);
    for (const el of document.body.querySelectorAll("*")) {
      if (el.closest(".screen-frame, .sr-only") !== null) continue;
      const style = getComputedStyle(el);
      if (style.position === "fixed" || style.visibility === "hidden" || style.display === "none") continue;
      const box = el.getBoundingClientRect();
      if (box.width < 1) continue;
      let clipped = false;
      for (let parent = el.parentElement; parent !== null && parent !== document.body; parent = parent.parentElement) {
        const overflow = getComputedStyle(parent).overflowX;
        if (overflow === "hidden" || overflow === "auto" || overflow === "scroll" || overflow === "clip") {
          clipped = true;
          break;
        }
      }
      if (!clipped && box.right > width + 0.5) found.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}" ends at ${String(Math.round(box.right))} in ${String(width)}`);
    }
    return found.slice(0, 4);
  });
}

/** The capsule is whole and inside the screen. */
async function capsuleInside(page: Page, width: number): Promise<void> {
  const box = await page.locator(".island").boundingBox();
  expect(box, "the capsule is drawn").not.toBeNull();
  const { x, width: w } = box as { x: number; width: number };
  expect(x, "the capsule starts inside the screen").toBeGreaterThanOrEqual(0);
  expect(x + w, "the capsule ends inside the screen").toBeLessThanOrEqual(width + 0.5);
}

for (const width of WIDTHS) {
  test.describe(`at ${String(width)}px wide`, () => {
    test.use({ viewport: { width, height: 700 } });

    for (const [name, path] of PUBLIC_PAGES) {
      test(`${name}: nothing is wider than the screen, and the capsule is inside it`, async ({ page }) => {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        if (path.startsWith("/r/demo")) await expect(page.getByRole("heading", { name: "Status" }).first()).toBeVisible();
        expect(await widerThanTheScreen(page)).toEqual([]);
        expect((await overflowReport(page)).page, "horizontal scroll").toBeLessThanOrEqual(0);
        await capsuleInside(page, width);
      });
    }
  });
}

// The home page's switch has four views, which do not fit in one row on a phone: there they sit two by two, inside the sheet, and
// the pill goes down to the second row with a choice there. From `sm` (640px) up they are one row.
for (const [width, rows] of [
  [320, 2],
  [414, 2],
  [640, 1],
] as const) {
  test.describe(`the four views at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 700 } });

    test(`sit in ${String(rows)} row${rows === 1 ? "" : "s"} inside the sheet, and the pill is on the one chosen`, async ({ page }) => {
      await page.goto("/");
      const group = page.getByRole("radiogroup", { name: "Who is looking" });
      await expect(group).toBeVisible();
      const box = async (locator: Locator) => (await locator.boundingBox()) as { x: number; y: number; width: number; height: number };
      const sheet = await box(page.locator("section[aria-labelledby='lens-heading']"));
      const switchBox = await box(group);
      expect(switchBox.x, "the switch starts inside the sheet").toBeGreaterThanOrEqual(sheet.x);
      expect(switchBox.x + switchBox.width, "the switch ends inside the sheet").toBeLessThanOrEqual(sheet.x + sheet.width + 0.5);

      const tops = new Set<number>();
      for (const name of ["Everyone", "One person", "Auditor", "You"]) tops.add(Math.round((await box(group.getByRole("radio", { name }))).y));
      expect(tops.size, "rows of options").toBe(rows);

      // The pill lies on the option within a pixel (it is placed in whole pixels; a grid's cells need not be).
      await group.getByRole("radio", { name: "You" }).click();
      const you = await box(group.getByRole("radio", { name: "You" }));
      const thumb = page.locator('[data-slot="segmented-thumb"]').first();
      await expect
        .poll(async () => {
          const at = await box(thumb);
          return [at.x - you.x, at.y - you.y, at.width - you.width, at.height - you.height].every((gap) => Math.abs(gap) < 1);
        })
        .toBe(true);
    });
  });
}

/** The practice payout from the first screen to the simulated receipt, with every screen checked as it comes. */
async function practicePayout(page: Page, width: number, height: number) {
  await page.addInitScript(() => {
    sessionStorage.setItem("zecdrop.practice", "1");
  });
  await page.goto("/new");
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
  await expect(page.getByText("Funded.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send 8 payouts" }).click();

  // The sheet fits the window, or scrolls inside it, and its buttons can be reached.
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
  await expect(page.getByRole("heading", { level: 2, name: "Sending the payouts" })).toBeVisible();
  await look("sending");
  await expect(page.getByRole("heading", { level: 2, name: "All 1 batch is confirmed" })).toBeVisible({ timeout: 30_000 });
  await look("settled");
  await page.getByRole("link", { name: "Open public receipt" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Payout receipt" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Status" }).first()).toBeVisible();
  await look("the simulated receipt");
  return seen;
}

test.describe("the practice payout, the operator's screens, on a small phone and in landscape", () => {
  for (const [name, width, height] of [
    ["the smallest phone, 320x568", 320, 568],
    ["a phone in landscape, 667x375", 667, 375],
    ["a tablet in portrait, 768x1024", 768, 1024],
  ] as const) {
    test(`${name}: every screen fits the screen`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height });
      const seen = await practicePayout(page, width, height);
      for (const [screen, wider] of Object.entries(seen)) expect(wider, `${screen}: wider than the screen`).toEqual([]);
    });
  }
});
