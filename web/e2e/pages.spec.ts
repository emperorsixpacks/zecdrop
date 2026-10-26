import { expect, test, type Page } from "@playwright/test";

import { axeViolations, open, overflowReport, PAGES, THEMES, useTheme, VIEWPORTS, watchProblems, watchRequests } from "./helpers.js";

// Every public page, in both themes, at phone and desktop width.
for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`${viewport.name}, ${theme} theme`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      for (const target of PAGES) {
        test(target.name, async ({ page }) => {
          await useTheme(page, theme);
          const problems = watchProblems(page);
          const requests = watchRequests(page);

          await open(page, target);

          // The theme we asked for is the theme we got.
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

          // No console errors, warnings or uncaught exceptions.
          expect(problems()).toEqual([]);

          // Nothing left the origin: no fonts, scripts or images from elsewhere.
          const origin = new URL(page.url()).origin;
          const foreign = requests().filter(
            (url) => !url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:"),
          );
          expect(foreign).toEqual([]);

          // No sideways scrolling, and nothing wider than the screen.
          const overflow = await overflowReport(page);
          expect(overflow.wide, "elements wider than the viewport").toEqual([]);
          expect(overflow.page, "horizontal scroll").toBeLessThanOrEqual(0);

          // WCAG 2.2 A and AA, including colour contrast and target size.
          expect(await axeViolations(page), "accessibility violations").toEqual([]);
        });
      }
    });
  }
}

// The states that are not the page as it loads: the lens switched, every section opened.
// Each is checked like a page of its own, in both themes, at phone and desktop width.
for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`${viewport.name}, ${theme} theme, opened up`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      async function check(page: Page, label: string, problems: () => string[]) {
        expect(problems(), `${label}: console`).toEqual([]);
        const overflow = await overflowReport(page);
        expect(overflow.wide, `${label}: elements wider than the viewport`).toEqual([]);
        expect(overflow.page, `${label}: horizontal scroll`).toBeLessThanOrEqual(0);
        expect(await axeViolations(page), `${label}: accessibility violations`).toEqual([]);
      }

      test("the home page's lens, in each view", async ({ page }) => {
        await useTheme(page, theme);
        const problems = watchProblems(page);
        await page.goto("/");
        await page.getByRole("radio", { name: "Public" }).waitFor();
        await check(page, "public view", problems);

        await page.getByRole("radio", { name: "One person" }).click();
        await expect(page.getByLabel("Who?")).toBeVisible();
        await check(page, "one person", problems);

        await page.getByRole("radio", { name: "Auditor" }).click();
        await expect(page.getByText("ZecDrop demo payout 5")).toBeVisible();
        await check(page, "auditor view", problems);
      });

      test("a receipt with every section open", async ({ page }) => {
        await useTheme(page, theme);
        const problems = watchProblems(page);
        await page.goto("/r/demo?demo=real");
        await page.getByRole("heading", { level: 2, name: "Status" }).waitFor({ state: "attached" });
        for (const name of ["Details", "Transaction", "Funding address", "List fingerprint", "What this proves and what it does not"]) {
          await page.getByRole("button", { name, exact: true }).click();
        }
        await check(page, "real receipt, open", problems);

        await page.goto("/r/demo?demo=findings");
        await page.getByRole("heading", { name: "What the verifier found" }).waitFor();
        await page.getByRole("button", { name: "Transactions", exact: true }).click();
        await check(page, "receipt with findings, batches open", problems);
      });

      test("the privacy page with its sections open", async ({ page }) => {
        await useTheme(page, theme);
        const problems = watchProblems(page);
        await page.goto("/privacy");
        await page.getByRole("heading", { level: 1, name: "How privacy works" }).waitFor();
        await page.getByRole("button", { name: "Every known limit, and who must be trusted" }).click();
        await page.getByRole("button", { name: "What anyone can check, and what only an auditor can" }).click();
        await check(page, "privacy, open", problems);
      });
    });
  }
}
