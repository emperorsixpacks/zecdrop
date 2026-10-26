import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { axeViolations, overflowReport, THEMES, useTheme, VIEWPORTS } from "../helpers.js";
import { operatorUrl, seeded } from "./env.js";
import { loadDemoCsv } from "./privacy.js";

// The operator's screens in both modes, at phone and desktop width:
// the three stages (with the real demo list), the sheet that asks before sending, a run
// in progress, and a sealed campaign. No accessibility violation, no sideways scroll,
// and the fake-chain pill on every one that is not behind the sheet.

const CAPTURED = resolve(process.cwd(), "../fixtures/contract/operator");
const captured = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(CAPTURED, name), "utf8")) as Record<string, unknown>;

function watch(page: Page): () => string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problems.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
  return () => problems;
}

async function check(page: Page, label: string, problems: () => string[], sheet = false) {
  if (!sheet) await expect(page.getByRole("status").filter({ hasText: "Fake chain: nothing is sent to Zcash" }), `${label}: pill`).toBeVisible();
  expect(problems(), `${label}: console`).toEqual([]);
  const overflow = await overflowReport(page);
  expect(overflow.wide, `${label}: elements wider than the viewport`).toEqual([]);
  expect(overflow.page, `${label}: horizontal scroll`).toBeLessThanOrEqual(0);
  expect(await axeViolations(page), `${label}: accessibility violations`).toEqual([]);
}

for (const viewport of VIEWPORTS) {
  {
    for (const theme of THEMES) {
      test.describe(`operator, ${theme}, ${viewport.name}`, () => {
        test.use({ viewport: { width: viewport.width, height: viewport.height } });

        test("the stages, the sheet, a run and a sealed campaign", async ({ page }) => {
          test.setTimeout(120_000);
          await useTheme(page, theme);
          const problems = watch(page);
          const { settled } = seeded();

          await page.goto(operatorUrl("/campaigns", { token: true }));
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await page.getByRole("list", { name: "Payouts" }).waitFor();
          await check(page, "payouts", problems);

          await page.getByRole("link", { name: "New payout" }).click();
          await page.getByRole("radio", { name: "Organisation" }).click();
          await page.getByRole("button", { name: "or paste it" }).click();
          await page.getByLabel("Paste your list").fill(loadDemoCsv());
          await page.getByRole("button", { name: "Use this list" }).click();
          await page.getByTestId("payout-table").waitFor();
          await check(page, "stage 1, the list", problems);

          await page.getByRole("button", { name: "Continue" }).click();
          await page.getByRole("heading", { level: 1, name: "Check the payouts" }).waitFor();
          await check(page, "stage 2, public view", problems);
          await page.getByRole("radio", { name: "Auditor" }).click();
          await check(page, "stage 2, auditor view", problems);

          await page.getByRole("link", { name: "Looks right, continue" }).click();
          await page.getByRole("heading", { level: 1, name: "Fund and send" }).waitFor();
          await page.getByRole("button", { name: "Record mock deposit" }).click();
          await page.getByText("Funded.").waitFor();
          await check(page, "stage 3, funded", problems);
          await page.getByRole("button", { name: /^Send \d+ payouts?$/u }).click();
          await expect(page.getByRole("dialog")).toBeVisible();
          await check(page, "stage 3, the sheet", problems, true);
          await page.keyboard.press("Escape");

          // A run in progress.
          const id = "c-000000000001";
          await page.route(new RegExp(`/api/campaigns/${id}$`, "u"), (route) => route.fulfill({ json: captured("campaign-running.json") }));
          await page.route(new RegExp(`/api/campaigns/${id}/events$`, "u"), (route) =>
            route.fulfill({ contentType: "text/event-stream", body: readFileSync(join(CAPTURED, "events-running.sse.txt"), "utf8") }),
          );
          await page.route(/\/api\/campaigns\/[^/]+\/receipt$/u, (route) => route.fulfill({ json: captured("receipt-running.json") }));
          await page.goto("about:blank");
          await page.goto(operatorUrl(`/campaign/${id}`, { token: true }));
          await page.getByRole("heading", { name: "Sending the payouts" }).waitFor();
          await check(page, "sending", problems);

          // Sealed.
          await page.goto("about:blank");
          await page.goto(operatorUrl(`/campaign/${settled}`, { token: true }));
          await page.getByText("Sealed").waitFor();
          await check(page, "sealed", problems);
        });
      });
    }
  }
}
