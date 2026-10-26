import { expect, test } from "@playwright/test";

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
