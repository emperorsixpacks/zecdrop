import { expect, test, type Page } from "@playwright/test";

import { open, pageNamed, PAGES, THEMES, useTheme, VIEWPORTS } from "./helpers.js";

interface Stop {
  /** What a screen reader would call it, roughly. */
  label: string;
  top: number;
  left: number;
  visible: boolean;
  /** An outline or ring is actually drawn while it has focus. */
  hasIndicator: boolean;
}

/** Press Tab until focus leaves the page content, recording each stop. */
async function tabThrough(page: Page, limit = 80): Promise<Stop[]> {
  const stops: Stop[] = [];
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate((): Stop | null => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const outlined = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
      const ringed = style.boxShadow !== "none";
      const bordered = style.borderTopColor !== "rgba(0, 0, 0, 0)" && el.matches(":focus-visible");
      return {
        label: (el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim().slice(0, 50),
        top: Math.round(box.top + window.scrollY),
        left: Math.round(box.left + window.scrollX),
        visible: box.width > 0 && box.height > 0,
        hasIndicator: outlined || ringed || bordered,
      };
    });
    if (stop === null) break;
    stops.push(stop);
  }
  return stops;
}

for (const viewport of VIEWPORTS) {
  test.describe(`keyboard, ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const target of PAGES) {
      test(`${target.name}: sensible tab order with a visible focus indicator`, async ({ page }) => {
        await open(page, target);
        const stops = await tabThrough(page);

        // The first stop is the skip link, and it becomes visible when focused.
        expect(stops[0]?.label).toBe("Skip to content");
        expect(stops[0]?.visible).toBe(true);

        expect(stops.length).toBeGreaterThan(3);
        for (const stop of stops) {
          expect(stop.visible, `"${stop.label}" is focusable but not visible`).toBe(true);
          expect(stop.hasIndicator, `"${stop.label}" shows no focus indicator`).toBe(true);
        }

        // Focus never jumps back up the page: the order matches the reading
        // order. A small tolerance covers items that share a row.
        for (let i = 1; i < stops.length; i++) {
          const before = stops[i - 1];
          const here = stops[i];
          if (!before || !here) continue;
          expect(
            here.top,
            `focus jumped up from "${before.label}" to "${here.label}"`,
          ).toBeGreaterThanOrEqual(before.top - 10);
        }

        // Nothing forces its own place in the order with a positive tabindex.
        const forced = await page.evaluate(
          () => document.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])').length,
        );
        expect(forced).toBe(0);
      });
    }

    test("the skip link moves focus past the header to the main content", async ({ page }) => {
      await open(page, PAGES[0] as (typeof PAGES)[number]);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await expect(page.locator("#main")).toBeFocused();
    });
  });
}

test.describe("sample receipt", () => {
  test("a keyboard user can copy a transaction id to the real clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page, pageNamed("sample receipt"));

    // The transactions are behind a button; it opens from the keyboard too.
    const section = page.getByRole("button", { name: "Transactions" });
    await section.focus();
    await page.keyboard.press("Enter");
    await expect(section).toHaveAttribute("aria-expanded", "true");

    const button = page.getByRole("button", { name: "Copy transaction id for batch 0" }).first();
    await button.focus();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("status").filter({ hasText: "Copied to clipboard" }).first()).toBeAttached();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe("a".repeat(64));
  });

  for (const viewport of VIEWPORTS) {
    test(`shows ${viewport.width < 1024 ? "cards" : "the table"} at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await open(page, pageNamed("sample receipt"));
      await page.getByRole("button", { name: "Transactions" }).click();

      const table = page.getByRole("table", { name: "Payout batches" });
      const cards = page.getByRole("list", { name: "Payout batches" });
      if (viewport.width < 1024) {
        await expect(cards).toBeVisible();
        await expect(table).toBeHidden();
      } else {
        await expect(table).toBeVisible();
        await expect(cards).toBeHidden();
      }
    });
  }

  for (const theme of THEMES) {
    test(`the sample line and the boundary section are readable (${theme})`, async ({ page }) => {
      await useTheme(page, theme);
      await open(page, pageNamed("sample receipt"));
      await expect(page.locator("#main").getByText("Sample data: a campaign in progress")).toBeVisible();
      await page.getByRole("button", { name: "What this proves and what it does not" }).click();
      await expect(page.getByRole("heading", { name: "What this does not prove" })).toBeVisible();
    });
  }
});
