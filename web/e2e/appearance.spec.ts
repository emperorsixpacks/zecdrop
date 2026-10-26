import { expect, test, type Page } from "@playwright/test";

import { axeViolations, overflowReport, THEMES, useTheme, VIEWPORTS, watchProblems } from "./helpers.js";

// Midnight, dark and light, at phone and desktop width: the public pages, and the
// small panels that open over them, must have no accessibility violation and no sideways
// scroll. (src/colours.test.ts has already computed the contrast of every pair of roles; this
// is the browser's own check of what was drawn.)

async function check(page: Page, label: string, problems: () => string[]) {
  expect(problems(), `${label}: console`).toEqual([]);
  const overflow = await overflowReport(page);
  expect(overflow.wide, `${label}: elements wider than the viewport`).toEqual([]);
  expect(overflow.page, `${label}: horizontal scroll`).toBeLessThanOrEqual(0);
  expect(await axeViolations(page), `${label}: accessibility violations`).toEqual([]);
}

for (const viewport of VIEWPORTS) {
  {
    for (const theme of THEMES) {
      test.describe(`${theme}, ${viewport.name}`, () => {
        test.use({ viewport: { width: viewport.width, height: viewport.height } });

        test("the public pages and their panels", async ({ page }) => {
          await useTheme(page, theme);
          const problems = watchProblems(page);

          await page.goto("/");
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await page.getByRole("radio", { name: "Public" }).waitFor();
          await check(page, "home, public view", problems);
          await page.getByRole("radio", { name: "Auditor" }).click();
          await check(page, "home, auditor view", problems);
          await page.getByRole("radio", { name: "One person" }).click();
          await check(page, "home, one person", problems);

          await page.getByRole("button", { name: "Appearance" }).click();
          await expect(page.getByRole("dialog")).toBeVisible();
          await expect(page.getByRole("radio", { name: "Light" })).toBeVisible();
          await check(page, "the appearance panel", problems);
          await page.keyboard.press("Escape");

          if (viewport.width < 640) {
            await page.getByRole("button", { name: "Menu" }).click();
            await expect(page.getByRole("navigation", { name: "Menu" })).toBeVisible();
            await check(page, "the phone menu", problems);
            await page.keyboard.press("Escape");
          }

          await page.goto("/r/demo?demo=real");
          await page.getByRole("heading", { level: 2, name: "Status" }).waitFor({ state: "attached" });
          await check(page, "receipt", problems);
          for (const name of ["Details", "Transaction", "Funding address", "List fingerprint", "What this proves and what it does not"]) {
            await page.getByRole("button", { name, exact: true }).click();
          }
          await check(page, "receipt, everything open", problems);

          await page.goto("/r/demo?demo=findings");
          await page.getByRole("heading", { name: "What the verifier found" }).waitFor();
          await check(page, "receipt with findings", problems);

          await page.goto("/privacy");
          await page.getByRole("heading", { level: 1, name: "How privacy works" }).waitFor();
          await check(page, "privacy", problems);
        });
      });
    }
  }
}
