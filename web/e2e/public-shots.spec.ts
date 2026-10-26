import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { test, type Page } from "@playwright/test";

import { openIsland, useTheme, VIEWPORTS, type Theme } from "./helpers.js";

// Screenshots of the public pages for design review. Not part of the normal run:
// it does nothing unless UI_SHOTS_DIR names a folder.
//
//   UI_SHOTS_DIR=/some/folder UI_SHOTS_STAGE=a npx playwright test --project=public public-shots

const DIR = process.env["UI_SHOTS_DIR"];
const STAGE = process.env["UI_SHOTS_STAGE"] ?? "a";

test.skip(DIR === undefined, "set UI_SHOTS_DIR to take screenshots");

/** Midnight, dark (the look) and light. */
const LOOKS: readonly { theme: Theme }[] = [{ theme: "dark" }, { theme: "light" }];

/** Scroll down and back, so what draws itself when it comes into view has been seen, then let it finish. */
async function settle(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1600);
}

const shotsDir = (): string => {
  const dir = join(DIR ?? "", STAGE);
  mkdirSync(dir, { recursive: true });
  return dir;
};

async function shoot(page: Page, name: string, width: number, look: string, fullPage = true) {
  if (fullPage) await settle(page);
  else await page.waitForTimeout(600);
  await page.screenshot({ path: join(shotsDir(), `${name}-${String(width)}-${look}.png`), fullPage });
}

for (const viewport of VIEWPORTS) {
  for (const look of LOOKS) {
    const name = look.theme;
    test.describe(`public ${String(viewport.width)} ${name}`, () => {
      // Motion as a visitor has it (Lively), so the stills show the glow and the drawn strip.
      test.use({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: "no-preference" });

      test("public screens", async ({ page }) => {
        test.setTimeout(120_000);
        await useTheme(page, look.theme);
        const w = viewport.width;

        await page.goto("/");
        await page.getByRole("heading", { level: 1 }).waitFor();
        await shoot(page, "home", w, name);
        await shoot(page, "home-fold", w, name, false);
        await page.getByRole("radio", { name: "One person" }).click();
        await shoot(page, "home-person", w, name);
        await page.getByRole("radio", { name: "Auditor" }).click();
        await shoot(page, "home-auditor", w, name);
        await openIsland(page);
        await shoot(page, "home-island", w, name, false);
        await page.getByRole("button", { name: "Appearance" }).click();
        await page.getByRole("dialog").waitFor();
        await shoot(page, "home-appearance", w, name, false);
        // The panel takes the first Escape, the capsule the second.
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");

        await page.goto("/r/demo?demo=real");
        await page.getByRole("heading", { level: 2, name: "Status" }).waitFor({ state: "attached" });
        await shoot(page, "receipt", w, name);
        await shoot(page, "receipt-fold", w, name, false);
        for (const label of ["Transaction", "Funding address", "List fingerprint", "What this proves and what it does not", "Details"]) {
          await page.getByRole("button", { name: label, exact: true }).click();
        }
        await shoot(page, "receipt-open", w, name);

        await page.goto("/r/demo?demo=1");
        await page.getByRole("heading", { level: 2, name: "Status" }).waitFor({ state: "attached" });
        await shoot(page, "receipt-progress", w, name);

        await page.goto("/r/demo?demo=findings");
        await page.getByRole("heading", { name: "What the verifier found" }).waitFor();
        await shoot(page, "receipt-findings", w, name);

        await page.goto("/privacy");
        await page.getByRole("heading", { level: 1, name: "How privacy works" }).waitFor();
        await shoot(page, "privacy", w, name);
      });
    });
  }
}
