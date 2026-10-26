import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { axeViolations, overflowReport, THEMES, useTheme } from "../helpers.js";
import { operatorUrl, seeded } from "./env.js";

// What the funding screen says about where a deposit came from (openspec REQ-FUND-004), in a real browser: the ask before any
// deposit, the calm line for a shielded one, the warning for a transparent one, at the narrowest phone width and on a desktop,
// in both themes, with the page still sound. The mock chain cannot see a real deposit, so (as in funding-qr.spec.ts) the
// operator's own real-chain answers are served to the page.

const GOLDEN_DIR = resolve(process.cwd(), "../fixtures/contract/operator/golden");
const golden = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(GOLDEN_DIR, name), "utf8")) as Record<string, unknown>;

async function serve(page: Page, file: string) {
  const { funded } = seeded();
  await page.route(/\/api\/health$/u, (route) => route.fulfill({ json: golden("health-real.json") }));
  await page.route(new RegExp(`/api/campaigns/${funded}$`, "u"), (route) => route.fulfill({ json: golden(file) }));
  await page.goto(operatorUrl(`/campaign/${funded}`, { token: true }));
}

async function sound(page: Page) {
  const overflow = await overflowReport(page);
  expect(overflow.wide, "elements wider than the viewport").toEqual([]);
  expect(overflow.page, "horizontal scroll").toBeLessThanOrEqual(0);
  expect(await axeViolations(page), "accessibility violations").toEqual([]);
}

for (const viewport of [
  { name: "phone 320px", width: 320, height: 700 },
  { name: "desktop 1280px", width: 1280, height: 800 },
]) {
  for (const theme of THEMES) {
    test.describe(`where the deposit came from, ${viewport.name}, ${theme} theme`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      test("asks for a shielded deposit before any is seen", async ({ page }) => {
        await useTheme(page, theme);
        await serve(page, "campaign-real-awaiting-deposit.json");
        await expect(page.getByTestId("funding-ask")).toContainText("Pay from your shielded balance.");
        await expect(page.getByTestId("deposit-source")).toHaveCount(0);
        await page.getByRole("button", { name: "About paying from a shielded balance" }).click();
        await expect(page.getByText(/shield them well before you pay/u)).toBeVisible();
        await page.keyboard.press("Escape");
        await sound(page);
      });

      test("says a shielded deposit names no address while it is still confirming", async ({ page }) => {
        await useTheme(page, theme);
        await serve(page, "campaign-real-deposit-shallow-shielded.json");
        await expect(page.getByTestId("deposit-source")).toHaveText(
          "From the shielded pool: the deposit names no address of yours. Its amount and time are public.",
        );
        await sound(page);
      });

      test("states a transparent deposit plainly once funded, and sending stays open", async ({ page }) => {
        await useTheme(page, theme);
        await serve(page, "campaign-real-funded.json");
        const warning = page.getByTestId("deposit-source");
        await expect(warning).toContainText("This deposit came from transparent funds");
        await expect(warning).toContainText("You can still send");
        await expect(page.getByRole("button", { name: /^Send \d+ payouts?$/u })).toBeEnabled();
        await sound(page);
      });
    });
  }
}
