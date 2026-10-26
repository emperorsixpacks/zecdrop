import { expect, test } from "@playwright/test";

import { island, watchProblems } from "./helpers.js";

// A page that is opened by a link or a button starts at its top. The router does not do that for an app like this one: without it a
// link at the foot of a page opened the next page at the same depth, with its heading far above the window (the owner found it on
// 2026-10-19, while looking at a payout: the capsule was over the title of the funding screen). The operator's own stages are
// checked the same way in operator/responsive.spec.ts. Going back or forward
// is the browser's, and a change that leaves the path alone (a choice in the address) moves nothing.

for (const width of [360, 1280]) {
  test.describe(`at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test("a link at the foot of the home page opens the next page at its top, with its heading clear of the capsule", async ({ page }) => {
      const problems = watchProblems(page);
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      expect(await page.evaluate(() => window.scrollY), "the home page was scrolled to its foot").toBeGreaterThan(1000);

      await page.getByRole("contentinfo").getByRole("link", { name: "How privacy works" }).click();
      const heading = page.getByRole("heading", { level: 1, name: "How privacy works" });
      await expect(heading).toBeVisible();
      expect(await page.evaluate(() => window.scrollY), "the next page is at its top").toBe(0);
      const title = await heading.boundingBox();
      const capsule = await island(page).boundingBox();
      expect(title).not.toBeNull();
      expect(capsule).not.toBeNull();
      expect((title as { y: number }).y, "the heading is below the capsule").toBeGreaterThanOrEqual((capsule as { y: number; height: number }).y + (capsule as { height: number }).height);
      expect(problems()).toEqual([]);
    });
  });
}

test.describe("what it leaves alone", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a choice that changes the address but not the path moves nothing: the receipt's sample list", async ({ page }) => {
    await page.goto("/r/demo?demo=real");
    await expect(page.getByRole("heading", { level: 2, name: "Status" }).first()).toBeVisible();
    await page.evaluate(() => {
      window.scrollTo(0, 300);
    });
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(100);
    await page.getByLabel("Sample").selectOption({ index: 1 });
    await expect(page).toHaveURL(/demo=(?!real$)/u);
    expect(await page.evaluate(() => window.scrollY), "the page was not sent to its top").toBeGreaterThan(100);
  });
});

test.describe("with the cross-fade on", () => {
  test.use({ viewport: { width: 390, height: 800 }, reducedMotion: "no-preference" });

  test("the new page is at its top when the cross-fade takes its picture, and the picture is not held up", async ({ page }) => {
    await page.addInitScript(() => {
      const seen: { y: number }[] = [];
      (window as unknown as { __at: typeof seen }).__at = seen;
      const original = document.startViewTransition.bind(document);
      document.startViewTransition = (...args: Parameters<typeof original>) => {
        const transition = original(...args);
        void transition.updateCallbackDone.then(() => {
          seen.push({ y: window.scrollY });
        });
        return transition;
      };
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await page.getByRole("contentinfo").getByRole("link", { name: "How privacy works" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "How privacy works" })).toBeVisible();
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __at: { y: number }[] }).__at)).length).toBe(1);
    const at = await page.evaluate(() => (window as unknown as { __at: { y: number }[] }).__at);
    expect(at, "where the page was when the browser was let go to take its picture").toEqual([{ y: 0 }]);
  });
});
