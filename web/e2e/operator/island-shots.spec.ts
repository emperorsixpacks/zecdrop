import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { test, type Page } from "@playwright/test";

import { island, openIsland, useTheme, type Theme } from "../helpers.js";
import { operatorUrl } from "./env.js";

// Screenshots of the header capsule for design review, closed and open, on a public page and on an operator page, with the
// mainnet chip and the practice chip. Not part of the normal run: it does nothing unless UI_SHOTS_DIR names a folder.
//
//   UI_SHOTS_DIR=/some/folder npx playwright test --project=operator island-shots

const DIR = process.env["UI_SHOTS_DIR"];

test.skip(DIR === undefined, "set UI_SHOTS_DIR to take screenshots");

const SIZES = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;
const LOOKS: readonly Theme[] = ["light", "dark"];

const dir = (): string => {
  mkdirSync(DIR ?? "", { recursive: true });
  return DIR ?? "";
};

/** The receipt of a real batch, said to be on mainnet, for the page to show behind a mainnet capsule. */
const MAINNET_RECEIPT = (() => {
  const golden = JSON.parse(readFileSync(join(process.cwd(), "../fixtures/contract/public-receipt.json"), "utf8")) as object;
  return { ...golden, network: "mainnet" };
})();
const MAINNET_LINK = `/r/camp-01?network=mainnet&tx=${"a".repeat(64)}&commitment=${"e".repeat(64)}&declared_total=534500000`;

/** What a still shows: the top of the page, as it is drawn (the pointer is moved off the capsule, so the hover tint is not). */
async function shoot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(dir(), `${name}.png`) });
}

for (const size of SIZES) {
  for (const theme of LOOKS) {
    const tag = `${String(size.width)}-${theme}`;
    test.describe(`island ${tag}`, () => {
      test.use({ viewport: size, deviceScaleFactor: 2 });

      test("a public page: the home page", async ({ page }) => {
        await useTheme(page, theme);
        await page.goto(operatorUrl("/"));
        await page.getByRole("heading", { level: 1 }).waitFor();
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        await shoot(page, `public-home-${tag}-collapsed`);
        await openIsland(page);
        await shoot(page, `public-home-${tag}-open`);
      });

      test("a public page with the longest name: how privacy works", async ({ page }) => {
        await useTheme(page, theme);
        await page.goto(operatorUrl("/privacy"));
        await page.getByRole("heading", { level: 1, name: "How privacy works" }).waitFor();
        await shoot(page, `public-privacy-${tag}-collapsed`);
        await openIsland(page);
        await shoot(page, `public-privacy-${tag}-open`);
      });

      test("an operator page: the payouts", async ({ page }) => {
        await useTheme(page, theme);
        await page.goto(operatorUrl("/campaigns", { token: true }));
        await page.getByRole("list", { name: "Payouts" }).waitFor();
        await shoot(page, `operator-payouts-${tag}-collapsed`);
        await openIsland(page);
        await shoot(page, `operator-payouts-${tag}-open`);
      });

      test("an operator page that is not the payouts: the audit, where starting a payout is a quiet outline", async ({ page }) => {
        await useTheme(page, theme);
        await page.goto(operatorUrl("/audit", { token: true }));
        await page.getByRole("heading", { level: 1, name: "Audit" }).waitFor();
        await shoot(page, `operator-audit-${tag}-collapsed`);
      });

      test("the mainnet chip: a receipt link for mainnet, and a real mainnet operator", async ({ page }) => {
        await useTheme(page, theme);
        await page.route("**/v1/receipt**", (route) => route.fulfill({ json: MAINNET_RECEIPT }));
        await page.goto(operatorUrl(MAINNET_LINK));
        await page.getByRole("heading", { level: 2, name: "Status" }).waitFor();
        await shoot(page, `mainnet-receipt-${tag}-collapsed`);
        await openIsland(page);
        await shoot(page, `mainnet-receipt-${tag}-open`);

        await page.route("**/api/health", async (route) => {
          const response = await route.fetch();
          const body = (await response.json()) as Record<string, unknown>;
          await route.fulfill({ response, json: { ...body, mock: false, network: "mainnet" } });
        });
        await page.goto(operatorUrl("/campaigns", { token: true }));
        await page.getByRole("list", { name: "Payouts" }).waitFor();
        await island(page).locator('[data-network="mainnet"]').waitFor();
        await shoot(page, `mainnet-operator-${tag}-collapsed`);
      });

      test("the practice chip: the practice banner above the capsule", async ({ page }) => {
        await useTheme(page, theme);
        await page.goto(operatorUrl("/"));
        await page.getByRole("button", { name: "Try it yourself in practice mode" }).click();
        await page.getByRole("heading", { level: 1, name: "Add the payouts" }).waitFor();
        await shoot(page, `practice-${tag}-collapsed`);
        await openIsland(page);
        await shoot(page, `practice-${tag}-open`);
      });
    });
  }
}
