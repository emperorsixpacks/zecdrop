import { expect, test, type Page, type Route } from "@playwright/test";

import { TOUR_SHOTS, TOUR_WIDTH, tourImageSrc } from "../src/features/home/tour-steps.js";
import { axeViolations, openIsland, overflowReport, THEMES, useTheme, VIEWPORTS, watchProblems } from "./helpers.js";

// The home page's tour with its pictures, in a real browser, in both looks at phone and desktop width:
// the pictures load when they are near and not before, only the look of the page is fetched, each arrives
// at the size the page says, the space for every one is held before it arrives (so the page does not grow
// and nothing moves), nothing goes sideways, the headings go down one level at a time, the tour has
// nothing to press but its one link, and axe finds nothing once every picture is in.

const TOUR = "section[aria-labelledby='tour-heading']";

/** Scroll down through the tour a screen at a time, so each lazy picture has been near once. */
async function scrollThrough(page: Page): Promise<void> {
  await page.evaluate(async (selector) => {
    const section = document.querySelector(selector);
    if (section === null) throw new Error("no tour on the page");
    const top = section.getBoundingClientRect().top + window.scrollY;
    const bottom = top + section.getBoundingClientRect().height;
    for (let y = top; y < bottom; y += Math.round(window.innerHeight * 0.6)) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, TOUR);
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`the home page tour, ${viewport.name}, ${theme} theme`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      test("loads its pictures when near, moves nothing, overflows nothing, and has no accessibility violations", async ({ page }) => {
        await useTheme(page, theme);
        const problems = watchProblems(page);
        const fetched: { path: string; status: number; type: string }[] = [];
        page.on("response", (response) => {
          const { pathname } = new URL(response.url());
          if (pathname.startsWith("/tour/")) {
            fetched.push({ path: pathname, status: response.status(), type: response.headers()["content-type"] ?? "" });
          }
        });

        await page.goto("/");
        await page.getByRole("heading", { level: 1 }).waitFor();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400);

        // Loaded when near: the last picture is far below the first screen, so it has not been asked for.
        const last = TOUR_SHOTS[TOUR_SHOTS.length - 1];
        expect(fetched.map((f) => f.path)).not.toContain(tourImageSrc(last ?? { id: "never" }, theme));

        // From here on, watch for anything that moves.
        await page.evaluate(() => {
          const holder = window as unknown as { __shift: number };
          holder.__shift = 0;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
              if (!shift.hadRecentInput) holder.__shift += shift.value;
            }
          }).observe({ type: "layout-shift" });
        });

        await scrollThrough(page);
        const pictures = page.locator(`${TOUR} img`);
        await expect(pictures).toHaveCount(TOUR_SHOTS.length);
        // Every picture arrived, at the size the page declared for it.
        await expect
          .poll(() => pictures.evaluateAll((imgs) => imgs.map((img) => `${String((img as HTMLImageElement).naturalWidth)}x${String((img as HTMLImageElement).naturalHeight)}`)))
          .toEqual(TOUR_SHOTS.map((shot) => `${String(TOUR_WIDTH)}x${String(shot.height)}`));
        // Only this look's pictures were fetched, each once, as images, with nothing in the way.
        expect(fetched.map((f) => f.path).sort()).toEqual(TOUR_SHOTS.map((shot) => tourImageSrc(shot, theme)).sort());
        for (const f of fetched) {
          expect(f.status, f.path).toBe(200);
          expect(f.type, f.path).toBe("image/webp");
        }

        // Nothing moved while they came in.
        expect(await page.evaluate(() => (window as unknown as { __shift: number }).__shift), "layout shift").toBeLessThan(0.01);

        // Each is drawn in the proportions of the file: no stretching.
        for (const [index, shot] of TOUR_SHOTS.entries()) {
          const box = await pictures.nth(index).boundingBox();
          expect(box, shot.id).not.toBeNull();
          expect((box?.height ?? 0) / (box?.width ?? 1), shot.id).toBeCloseTo(shot.height / TOUR_WIDTH, 1);
        }

        // Nothing sideways, whatever the width.
        const overflow = await overflowReport(page);
        expect(overflow.wide, "elements wider than the viewport").toEqual([]);
        expect(overflow.page, "horizontal scroll").toBeLessThanOrEqual(0);

        // Headings go down one level at a time, from the one h1.
        const levels = await page.evaluate(() => [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => Number(h.tagName.slice(1))));
        expect(levels[0]).toBe(1);
        expect(levels.filter((level) => level === 1)).toHaveLength(1);
        for (const [index, level] of levels.entries()) {
          if (index > 0) expect(level, `heading ${String(index + 1)} jumps a level`).toBeLessThanOrEqual((levels[index - 1] ?? 0) + 1);
        }

        // The tour has one thing to press: the link to the receipt.
        const pressable = await page.locator(`${TOUR} a, ${TOUR} button, ${TOUR} input, ${TOUR} select, ${TOUR} textarea, ${TOUR} [tabindex]`).allInnerTexts();
        expect(pressable).toEqual(["Open this receipt"]);

        expect(problems(), "console problems").toEqual([]);
        expect(await axeViolations(page), "accessibility violations").toEqual([]);
      });

      test("holds the space of every picture before it arrives, so the page does not grow when it does", async ({ page }) => {
        await useTheme(page, theme);
        // Ask for the pictures but do not answer, until told to.
        const held: Route[] = [];
        let release = false;
        await page.route("**/tour/*.webp", (route) => {
          if (release) void route.continue();
          else held.push(route);
        });
        await page.goto("/");
        await page.getByRole("heading", { level: 1 }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        await scrollThrough(page);
        await expect.poll(() => held.length, "the pictures were asked for").toBeGreaterThan(0);

        const pictures = page.locator(`${TOUR} img`);
        const arrived = () => pictures.evaluateAll((imgs) => imgs.filter((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0).length);
        const measure = () =>
          pictures.evaluateAll((imgs) => imgs.map((img) => ({ width: img.getBoundingClientRect().width, height: img.getBoundingClientRect().height })));
        const pageHeight = () => page.evaluate(() => document.documentElement.scrollHeight);
        expect(await arrived(), "none has arrived yet").toBe(0);
        const before = { page: await pageHeight(), boxes: await measure() };
        for (const [index, shot] of TOUR_SHOTS.entries()) {
          const box = before.boxes[index];
          // Already in the proportions of the file, from the width and height written on the tag (inside its 1px border).
          expect(box?.height ?? 0, `${shot.id} before it arrives`).toBeCloseTo((((box?.width ?? 0) - 2) * shot.height) / TOUR_WIDTH + 2, -0.5);
        }

        // Let them come in.
        release = true;
        for (const route of held) await route.continue();
        await scrollThrough(page);
        await expect.poll(arrived).toBe(TOUR_SHOTS.length);
        const after = { page: await pageHeight(), boxes: await measure() };
        expect(Math.abs(after.page - before.page), "the page grew or shrank when the pictures came in").toBeLessThanOrEqual(2);
        for (const [index, shot] of TOUR_SHOTS.entries()) {
          expect(Math.abs((after.boxes[index]?.height ?? 0) - (before.boxes[index]?.height ?? 0)), `${shot.id} changed size`).toBeLessThanOrEqual(1);
        }
      });

      test("shows the other look's pictures when the look is switched, without a jump", async ({ page }) => {
        await useTheme(page, theme);
        await page.goto("/");
        await page.getByRole("heading", { level: 1 }).waitFor();
        await scrollThrough(page);
        const pictures = page.locator(`${TOUR} img`);
        const other = theme === "light" ? "dark" : "light";
        const before = await pictures.first().boundingBox();
        // The theme button is in the header capsule, which stays at the top of the page however far this has scrolled.
        await openIsland(page);
        await page.getByRole("button", { name: `Switch to ${other} theme` }).click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", other);
        await expect(pictures.first()).toHaveAttribute("src", tourImageSrc(TOUR_SHOTS[0] ?? { id: "never" }, other));
        await expect
          .poll(() => pictures.first().evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth))
          .toBe(TOUR_WIDTH);
        const after = await pictures.first().boundingBox();
        expect(after?.height, "the picture holds its size").toBe(before?.height);
      });
    });
  }
}
