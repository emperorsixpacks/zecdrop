import { expect, test, type Locator } from "@playwright/test";

import { capsuleInside, overflowReport, widerThanTheScreen } from "./helpers.js";

// Phones, as they are. The other specs run at 360px and at 1280px; this one runs the widths in between and below (WCAG 2.2, 1.4.10
// Reflow: no sideways scroll at 320px, which is also what a desktop window gets at 400% zoom) on every public page. What it asks of
// each: that nothing is wider than the screen (the page itself, and any box that is not inside one that scrolls or hides its own
// overflow), and that the capsule is whole and inside the screen. A whole payout, the operator's screens, is walked the same way on
// the smallest phone and in landscape by operator/responsive.spec.ts.

const WIDTHS = [320, 340, 360, 375, 414, 600, 768, 1024] as const;
const PUBLIC_PAGES = [
  ["the home page", "/"],
  ["make a payout", "/start"],
  ["get paid", "/get-paid"],
  ["check a payslip", "/payslip"],
  ["how privacy works", "/privacy"],
  ["a receipt", "/r/demo?demo=real"],
  ["a receipt with findings", "/r/demo?demo=findings"],
  ["a page that is not there", "/nope"],
] as const;

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
