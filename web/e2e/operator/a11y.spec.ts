import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { axeViolations, overflowReport, THEMES, useTheme, VIEWPORTS } from "../helpers.js";
import { operatorUrl, seeded } from "./env.js";
import { loadSentinels } from "./privacy.js";

// The operator pages, signed in, against the real operator: both themes, phone
// and desktop width. Each page is checked for console problems, sideways
// scrolling and WCAG 2.2 A/AA violations (colour contrast and target size
// included). The mock-chain banner must be present on every one of them.

interface Watched {
  problems: () => string[];
  /** Remove the console errors matching `pattern` and say how many there were. */
  take: (pattern: RegExp) => number;
}

/** Console errors and uncaught exceptions. The browser logs every failed fetch
 * ("Failed to load resource: ... 404") as a console error, and some pages are
 * checked in exactly the state where the operator is MEANT to answer with an
 * error (a refused token, a missing campaign, a CSV with problems). A spec
 * declares the one it expects with `take`, which counts it and removes it, so
 * anything else, or anything unexpected later, still fails. */
const GOLDEN_DIR = resolve(process.cwd(), "../fixtures/contract/operator/golden");

/** A real-chain response written by the operator's own Rust test. */
function golden(name: string): unknown {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, name), "utf8"));
}

function watch(page: Page): Watched {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problems.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
  return {
    problems: () => problems,
    take: (pattern) => {
      let taken = 0;
      for (let i = problems.length - 1; i >= 0; i--) {
        if (pattern.test(problems[i] ?? "")) {
          problems.splice(i, 1);
          taken += 1;
        }
      }
      return taken;
    },
  };
}

async function check(page: Page, label: string, watched: Watched): Promise<void> {
  await expect(page.getByRole("status").filter({ hasText: "Mock chain: nothing is sent to Zcash" }), `${label}: banner`).toBeVisible();
  expect(watched.problems(), `${label}: console`).toEqual([]);
  const overflow = await overflowReport(page);
  expect(overflow.wide, `${label}: elements wider than the viewport`).toEqual([]);
  expect(overflow.page, `${label}: horizontal scroll`).toBeLessThanOrEqual(0);
  expect(await axeViolations(page), `${label}: accessibility violations`).toEqual([]);
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`operator, ${viewport.name}, ${theme} theme`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      test("the explainer screen (no token)", async ({ page }) => {
        await useTheme(page, theme);
        const watched = watch(page);
        await page.goto(operatorUrl("/campaigns"));
        await expect(page.getByRole("heading", { level: 1, name: "Open the operator link" })).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        // No banner on the explainer when the operator is on the mock chain? It is shown: health needs no token.
        await check(page, "explainer", watched);
      });

      test("the explainer screen after a refused token", async ({ page }) => {
        await useTheme(page, theme);
        const watched = watch(page);
        await page.goto(operatorUrl("/campaigns", { token: "00".repeat(32) }));
        await expect(page.getByText("The operator did not accept this link")).toBeVisible();
        expect(watched.take(/status of 401/u), "the refused call").toBeGreaterThanOrEqual(1);
        await check(page, "refused token", watched);
      });

      test("campaigns, audit and campaign pages", async ({ page }) => {
        await useTheme(page, theme);
        const watched = watch(page);
        const { awaiting, funded, settled } = seeded();
        await page.goto(operatorUrl("/campaigns", { token: true }));
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

        await expect(page.getByRole("list", { name: "Campaigns" })).toBeVisible();
        await check(page, "campaigns list", watched);

        await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Audit" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Audit" })).toBeVisible();
        await check(page, "audit", watched);

        for (const [label, id, ready] of [
          ["campaign awaiting funding", awaiting, page.getByRole("heading", { name: "Mock chain: record a pretend deposit" })],
          ["funded campaign", funded, page.getByRole("button", { name: "Start sending" })],
          ["settled campaign", settled, page.getByTestId("receipt-link")],
        ] as const) {
          await page.goto(operatorUrl(`/campaign/${id}`, { token: true }));
          await expect(ready, label).toBeVisible();
          await check(page, label, watched);
        }

        // A campaign that does not exist.
        await page.goto(operatorUrl("/campaign/c-ffffffffffff", { token: true }));
        await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
        expect(watched.take(/status of 404/u), "the missing campaign").toBe(1);
        await check(page, "campaign not found", watched);
      });

      test("every wizard step, and the CSV problems list", async ({ page }) => {
        await useTheme(page, theme);
        const watched = watch(page);
        const sentinels = loadSentinels();
        await page.goto(operatorUrl("/new/basics", { token: true }));
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

        await expect(page.getByRole("heading", { level: 1, name: "Basics" })).toBeVisible();
        await check(page, "basics", watched);

        // Validation message on Basics.
        await page.getByRole("button", { name: "Next: Recipients" }).click();
        await expect(page.getByText("Give the campaign a name.")).toBeVisible();
        await check(page, "basics with a problem", watched);

        await page.getByLabel("Campaign name").fill(`A11y ${theme} ${String(viewport.width)}`);
        await page.getByLabel("Payouts per batch").fill("3");
        await page.getByRole("button", { name: "Next: Recipients" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Recipients" })).toBeVisible();
        await check(page, "recipients", watched);

        // The problems list, from a CSV with every kind of row error.
        const bad = loadSentinels("row-errors.csv");
        await page.getByLabel("Recipients (CSV)").fill(bad.csv);
        await page.getByRole("button", { name: "Check and create campaign" }).click();
        await expect(page.getByRole("heading", { name: /problems? in the CSV/u })).toBeVisible();
        expect(watched.take(/status of 422/u), "the refused CSV").toBe(1);
        await check(page, "recipients with CSV problems", watched);

        // Fix it and go on.
        await page.getByLabel("Recipients (CSV)").fill(sentinels.csv);
        await page.getByRole("button", { name: "Check and create campaign" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Auditor" })).toBeVisible();
        await check(page, "auditor", watched);

        await page.getByRole("link", { name: /^Next: Review/u }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Review" })).toBeVisible();
        await expect(page.getByTestId("manifest-commitment")).toBeVisible();
        await check(page, "review", watched);

        await page.getByRole("link", { name: /^Next: Fund/u }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Fund & Send" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Mock chain: record a pretend deposit" })).toBeVisible();
        await check(page, "fund", watched);

        // Back to a locked step.
        await page.getByRole("navigation", { name: "Wizard progress" }).getByRole("link", { name: /Basics/u }).click();
        await expect(page.getByRole("heading", { name: "Basics (locked)" })).toBeVisible();
        await check(page, "basics locked", watched);
      });

      test("a real chain's funding states and the viewing key, from the operator's golden responses", async ({ page }) => {
        // The mock chain has no funding address, no deposit in progress and no
        // viewing key. The operator's own Rust test writes what a real chain
        // answers (fixtures/contract/operator/golden/); serve those to the page
        // in place of the mock chain's answers and check the pages they produce.
        await useTheme(page, theme);
        const watched = watch(page);
        const { funded } = seeded();
        let current = golden("campaign-real-awaiting-deposit.json");
        await page.route(/\/api\/health$/u, (route) => route.fulfill({ json: golden("health-real.json") }));
        await page.route(new RegExp(`/api/campaigns/${funded}$`, "u"), (route) => route.fulfill({ json: current }));
        await page.route(/\/api\/campaigns\/[^/]+\/audit-ufvk-export$/u, (route) =>
          route.fulfill({ json: golden("audit-ufvk-export.json") }),
        );
        const open = async (file: string) => {
          current = golden(file);
          // A full load each time: going from "/x" to "/x#token=..." is only a fragment change,
          // which would leave the previous state on screen.
          await page.goto("about:blank");
          await page.goto(operatorUrl(`/campaign/${funded}`, { token: true }));
        };
        const checkReal = async (label: string) => {
          // Not the mock chain: no banner on these pages.
          await expect(page.getByText("Mock chain:"), `${label}: no mock banner`).toHaveCount(0);
          expect(watched.problems(), `${label}: console`).toEqual([]);
          const overflow = await overflowReport(page);
          expect(overflow.wide, `${label}: elements wider than the viewport`).toEqual([]);
          expect(overflow.page, `${label}: horizontal scroll`).toBeLessThanOrEqual(0);
          expect(await axeViolations(page), `${label}: accessibility violations`).toEqual([]);
        };

        await open("campaign-real-awaiting-deposit.json");
        await expect(page.getByTestId("funding-address")).toHaveText("tFAKEfundingAddressNotARealAddress0000");
        await expect(page.getByText("No deposit seen yet.")).toBeVisible();
        await checkReal("awaiting a deposit");

        await open("campaign-real-deposit-too-small.json");
        await expect(page.getByText(/so it does not count/u)).toBeVisible();
        await checkReal("deposit too small");

        await open("campaign-real-deposit-shallow.json");
        await expect(page.getByText(/has 2 of 3 confirmations/u)).toBeVisible();
        await checkReal("deposit still confirming");

        await open("campaign-real-wrong-wallet.json");
        await expect(page.getByText("This campaign belongs to a different wallet")).toBeVisible();
        await checkReal("wrong wallet");

        await open("campaign-real-funded.json");
        await expect(page.getByRole("button", { name: "Start sending" })).toBeVisible();
        await checkReal("funded");

        // The viewing key: not offered until the person agrees, hidden again on request.
        const card = page.getByRole("heading", { name: "Give an auditor the viewing key" });
        await card.scrollIntoViewIfNeeded();
        const reveal = page.getByRole("button", { name: "Show the viewing key" });
        await expect(reveal).toBeDisabled();
        await page.getByRole("checkbox", { name: /I understand that whoever receives this key/u }).check();
        await expect(reveal).toBeEnabled();
        await reveal.click();
        await expect(page.getByLabel(/Viewing key for testnet/u)).toHaveValue(/^uviewFAKEplaceholder/u);
        await expect(page.getByRole("button", { name: "Copy viewing key" })).toBeVisible();
        await checkReal("viewing key shown");

        await page.getByRole("button", { name: "Hide key" }).click();
        await expect(page.getByLabel(/Viewing key for testnet/u)).toHaveCount(0);
        const kept = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
        expect(kept).not.toContain("uviewFAKE");
      });
    });
  }
}
