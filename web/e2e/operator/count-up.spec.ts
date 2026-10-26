import { expect, test, type Page } from "@playwright/test";

import { useTheme, VIEWPORTS } from "../helpers.js";
import { operatorUrl } from "./env.js";
import { loadDemoCsv } from "./privacy.js";

// A number that counts up must not move anything around it: the box it sits in is as wide as the
// finished number, and its digits are tabular, so the figures next to it stay where they are from
// the first frame to the last. The page's own clock is Playwright's here (requestAnimationFrame and
// the time), so each frame is the number at a stated millisecond of its 700 ms count.

test.use({ reducedMotion: "no-preference" });

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The place each of the three figures takes up, and the place the whole line takes. */
async function boxes(page: Page): Promise<Box[]> {
  return await page.evaluate(() => {
    const line = document.querySelector("[data-testid='payout-summary']");
    if (line === null) return [];
    const rect = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
    };
    return [rect(line), ...Array.from(line.children).map(rect)];
  });
}

for (const viewport of VIEWPORTS) {
  for (const theme of ["dark", "light"] as const) {
    test.describe(`count-up layout, ${viewport.name}, ${theme} theme`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      test("the figures around a counting number stay where they are, frame by frame", async ({ page }) => {
        test.setTimeout(90_000);
        await useTheme(page, theme);
        await page.clock.install();
        await page.goto(operatorUrl("/new", { token: true }));
        await page.getByLabel("Name this payout run").fill("Layout check");
        await page.getByRole("radio", { name: "Organisation" }).click();
        await page.getByRole("button", { name: "or paste it" }).click();
        await page.getByLabel("Paste your list").fill(loadDemoCsv());
        await page.getByRole("button", { name: "Use this list" }).click();
        await page.getByTestId("payout-table").waitFor();

        const now = await page.evaluate(() => Date.now());
        await page.clock.pauseAt(now + 1000);
        await page.getByRole("button", { name: "Continue" }).click({ force: true });
        await page.getByRole("heading", { level: 1, name: "Check the payouts" }).waitFor();

        const frames: { at: number; text: string; boxes: Box[] }[] = [];
        let elapsed = 0;
        for (const at of [16, 175, 350, 525, 760, 900]) {
          await page.clock.runFor(at - elapsed);
          elapsed = at;
          frames.push({ at, text: (await page.getByTestId("payout-summary").innerText()).replace(/\s+/gu, " "), boxes: await boxes(page) });
        }

        // It really did count: the first frame is not the last.
        expect(frames[0]?.text).not.toBe(frames.at(-1)?.text);
        expect(frames.at(-1)?.text).toContain("0.005 TAZ");
        // And nothing moved: the line, and each figure in it, kept its place and size at every frame.
        const settled = frames.at(-1)?.boxes ?? [];
        expect(settled.length).toBeGreaterThan(2);
        for (const frame of frames) {
          frame.boxes.forEach((box, i) => {
            const end = settled[i];
            expect(box.x, `frame at ${String(frame.at)} ms, box ${String(i)}: x`).toBeCloseTo(end?.x ?? 0, 0);
            expect(box.y, `frame at ${String(frame.at)} ms, box ${String(i)}: y`).toBeCloseTo(end?.y ?? 0, 0);
            expect(box.width, `frame at ${String(frame.at)} ms, box ${String(i)}: width`).toBeCloseTo(end?.width ?? 0, 0);
            expect(box.height, `frame at ${String(frame.at)} ms, box ${String(i)}: height`).toBeCloseTo(end?.height ?? 0, 0);
          });
        }
      });
    });
  }
}
