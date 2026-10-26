import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { axeViolations, chooseFromIsland, overflowReport, THEMES, useTheme, VIEWPORTS } from "../helpers.js";
import { operatorUrl } from "./env.js";

// The screens a first-time operator sees: no payouts yet, nothing to audit, a payout whose
// batches are not there yet. Each is read in both themes at phone and desktop width for
// console problems, sideways scrolling and WCAG 2.2 A/AA violations, and each has its one
// obvious next step.

const CAPTURED = resolve(process.cwd(), "../fixtures/contract/operator");
const captured = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(CAPTURED, name), "utf8")) as Record<string, unknown>;

async function clean(page: Page, label: string, problems: string[]): Promise<void> {
  expect(problems, `${label}: console`).toEqual([]);
  const overflow = await overflowReport(page);
  expect(overflow.wide, `${label}: elements wider than the viewport`).toEqual([]);
  expect(overflow.page, `${label}: horizontal scroll`).toBeLessThanOrEqual(0);
  expect(await axeViolations(page), `${label}: accessibility violations`).toEqual([]);
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`empty states, ${viewport.name}, ${theme} theme`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      test("no payouts, nothing to audit, and a payout with no batches", async ({ page }) => {
        await useTheme(page, theme);
        const problems: string[] = [];
        page.on("console", (m) => {
          if (m.type() === "error" || m.type() === "warning") problems.push(`console.${m.type()}: ${m.text()}`);
        });
        page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));

        await page.route(/\/api\/campaigns$/u, (route) => (route.request().method() === "GET" ? route.fulfill({ json: [] }) : route.continue()));

        await page.goto(operatorUrl("/campaigns", { token: true }));
        const empty = page.getByTestId("payouts-empty");
        await expect(empty).toBeVisible();
        await expect(empty.getByText("No payouts yet")).toBeVisible();
        await expect(empty.getByRole("button", { name: "Choose a file" })).toBeVisible();
        await clean(page, "payouts, none", problems);

        await chooseFromIsland(page, "Audit");
        const none = page.getByTestId("audit-empty");
        await expect(none).toBeVisible();
        await expect(none.getByRole("link", { name: "Start a payout" })).toHaveAttribute("href", "/new");
        await clean(page, "audit, nothing to audit", problems);

        await page.goto("about:blank");
        await page.goto(operatorUrl("/new", { token: true }));
        await expect(page.getByText("Drop the list of who to pay. Nothing is sent yet.")).toBeVisible();
        await clean(page, "first run of the drop zone", problems);

        await page.unroute(/\/api\/campaigns$/u);
        const id = "c-000000000001";
        await page.route(new RegExp(`/api/campaigns/${id}$`, "u"), (route) =>
          route.fulfill({ json: { ...captured("campaign-awaiting-funding.json"), batches: [], batch_count: 0 } }),
        );
        await page.goto("about:blank");
        await page.goto(operatorUrl(`/campaign/${id}`, { token: true }));
        await page.getByRole("button", { name: "Batches" }).click();
        await expect(page.getByTestId("batches-empty")).toContainText("No batches yet");
        await clean(page, "a payout with no batches", problems);
      });
    });
  }
}
