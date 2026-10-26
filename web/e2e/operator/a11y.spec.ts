import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { axeViolations, chooseFromIsland, NARROWEST, overflowReport, THEMES, useTheme, VIEWPORTS } from "../helpers.js";
import { operatorUrl, seeded } from "./env.js";
import { loadSentinels } from "./privacy.js";

// The operator pages, signed in, against the real operator: both themes, phone
// and desktop width. Each page is checked for console problems, sideways
// scrolling and WCAG 2.2 A/AA violations (colour contrast and target size
// included). The practice-mode pill must be present on every one of them.

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

const CAPTURED_DIR = resolve(process.cwd(), "../fixtures/contract/operator");

/** A response the real operator binary wrote (fixtures/contract/operator). */
function captured(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CAPTURED_DIR, name), "utf8")) as Record<string, unknown>;
}

/** Open every section behind a click, so what is inside is checked too. */
async function openEverything(page: Page): Promise<void> {
  const closed = page.locator("main button[aria-expanded='false']:not([data-slot='why-trigger']):not([aria-haspopup])");
  for (let i = 0; i < 20 && (await closed.count()) > 0; i++) await closed.first().click();
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

async function check(page: Page, label: string, watched: Watched, options: { sheet?: boolean } = {}): Promise<void> {
  // While a sheet is open the page behind it is hidden from assistive technology, the pill with it.
  if (options.sheet !== true) {
    await expect(page.getByRole("status").filter({ hasText: "Practice mode: nothing is sent to Zcash" }), `${label}: practice pill`).toBeVisible();
  }
  expect(watched.problems(), `${label}: console`).toEqual([]);
  const overflow = await overflowReport(page);
  expect(overflow.wide, `${label}: elements wider than the viewport`).toEqual([]);
  expect(overflow.page, `${label}: horizontal scroll`).toBeLessThanOrEqual(0);
  expect(await axeViolations(page), `${label}: accessibility violations`).toEqual([]);
}

for (const viewport of [NARROWEST, ...VIEWPORTS]) {
  for (const theme of THEMES) {
    test.describe(`operator, ${viewport.name}, ${theme} theme`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      test("the explainer screen (no token)", async ({ page }) => {
        await useTheme(page, theme);
        const watched = watch(page);
        await page.goto(operatorUrl("/campaigns"));
        await expect(page.getByRole("heading", { level: 1, name: "Open the operator link" })).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        // The pill is on the explainer too: health needs no token.
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

        await expect(page.getByRole("list", { name: "Payouts" })).toBeVisible();
        await check(page, "payouts list", watched);

        await chooseFromIsland(page, "Audit");
        await expect(page.getByRole("heading", { level: 1, name: "Audit" })).toBeVisible();
        await check(page, "audit", watched);
        await openEverything(page);
        await check(page, "audit, everything open", watched);

        for (const [label, id, ready] of [
          ["campaign awaiting funding", awaiting, page.getByRole("heading", { name: "Practice mode: record a pretend deposit" })],
          ["funded campaign", funded, page.getByRole("button", { name: "Send 5 payouts" })],
          ["settled campaign", settled, page.getByText("Sealed")],
        ] as const) {
          await page.goto(operatorUrl(`/campaign/${id}`, { token: true }));
          await expect(ready, label).toBeVisible();
          await check(page, label, watched);
          await openEverything(page);
          await check(page, `${label}, everything open`, watched);
        }

        // The sheet that asks before sending: a state of its own.
        await page.goto(operatorUrl(`/campaign/${funded}`, { token: true }));
        await page.getByRole("button", { name: "Send 5 payouts" }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await check(page, "the send sheet", watched, { sheet: true });
        await page.keyboard.press("Escape");

        // A campaign that does not exist.
        await page.goto(operatorUrl("/campaign/c-ffffffffffff", { token: true }));
        await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
        expect(watched.take(/status of 404/u), "the missing campaign").toBe(1);
        await check(page, "campaign not found", watched);
      });

      test("a run in progress, one that stopped, and one that failed", async ({ page }) => {
        await useTheme(page, theme);
        const watched = watch(page);
        const id = "c-000000000001";
        let current = captured("campaign-running.json");
        await page.route(new RegExp(`/api/campaigns/${id}$`, "u"), (route) => route.fulfill({ json: current }));
        await page.route(new RegExp(`/api/campaigns/${id}/events$`, "u"), (route) =>
          route.fulfill({ contentType: "text/event-stream", body: readFileSync(join(CAPTURED_DIR, "events-running.sse.txt"), "utf8") }),
        );
        // The captured campaign names itself with its own id, and that is the one its receipt is asked for under.
        await page.route(/\/api\/campaigns\/[^/]+\/receipt$/u, (route) => route.fulfill({ json: captured("receipt-running.json") }));
        const open = async (label: string, ready: string | RegExp) => {
          await page.goto("about:blank");
          await page.goto(operatorUrl(`/campaign/${id}`, { token: true }));
          await expect(page.getByRole("heading", { name: "Sending the payouts" }), label).toBeVisible();
          await expect(page.getByText(ready).first(), label).toBeVisible();
          await check(page, label, watched);
          await openEverything(page);
          await check(page, `${label}, everything open`, watched);
        };

        await open("sending", "Confirming 1");
        current = captured("campaign-crashed.json");
        await open("stopped unexpectedly", /never built a second time/u);
        const running = captured("campaign-running.json") as { batches: Record<string, unknown>[] };
        current = {
          ...running,
          run: { state: "halted" },
          batches: running.batches.map((b, i) => (i === 0 ? { ...b, state: "failed", reason: "rejected by the node" } : b)),
        };
        await open("halted", /rejected by the node/u);
      });

      test("the three stages, and the list with problems", async ({ page }) => {
        await useTheme(page, theme);
        const watched = watch(page);
        const sentinels = loadSentinels();
        const bad = loadSentinels("row-errors.csv");
        const paste = async (csv: string) => {
          await page.getByRole("button", { name: "or paste it" }).click();
          await page.getByLabel("Paste your list").fill(csv);
          await page.getByRole("button", { name: "Use this list" }).click();
        };
        await page.goto(operatorUrl("/new", { token: true }));
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

        await expect(page.getByRole("heading", { level: 1, name: "Add the payouts" })).toBeVisible();
        await check(page, "payouts, empty", watched);

        // Pasting opens the box for it.
        await page.getByRole("button", { name: "or paste it" }).click();
        await expect(page.getByLabel("Paste your list")).toBeVisible();
        await check(page, "payouts, paste box", watched);
        await page.getByLabel("Paste your list").fill(bad.csv);
        await page.getByRole("button", { name: "Use this list" }).click();
        await expect(page.getByTestId("payout-table")).toBeVisible();
        await check(page, "payouts, list", watched);

        // The operator's problems, in the rows they are about.
        await page.getByRole("button", { name: "Continue" }).click();
        await expect(page.getByText(/problems? to fix\./u)).toBeVisible();
        expect(watched.take(/status of 422/u), "the refused CSV").toBe(1);
        await check(page, "payouts, with problems", watched);

        // Use a different list, with the options open, and go on.
        await page.getByRole("button", { name: "Use a different list" }).click();
        await paste(sentinels.csv);
        await page.getByLabel("Name this payout run").fill(`A11y ${theme} ${String(viewport.width)}`);
        await page.getByRole("button", { name: "Options" }).click();
        await page.getByLabel("Payouts per batch").fill("3");
        await expect(page.getByLabel("Payouts per batch")).toHaveValue("3");
        await check(page, "payouts, options open", watched);

        await page.getByRole("button", { name: "Continue" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Check the payouts" })).toBeVisible();
        await expect(page.getByTestId("payout-summary")).toBeVisible();
        await check(page, "check, public view", watched);

        // The lens, in each view, and a "Why?" open.
        await page.getByRole("radio", { name: "One person" }).click();
        await expect(page.getByLabel("Who?")).toBeVisible();
        await check(page, "check, one person", watched);
        await page.getByRole("radio", { name: "Auditor" }).click();
        await check(page, "check, auditor view", watched);
        await page.getByRole("button", { name: /^Why: / }).first().click();
        await expect(page.locator("[data-slot='popover-content']")).toBeVisible();
        await check(page, "check, a Why open", watched);
        await page.keyboard.press("Escape");
        await openEverything(page);
        await expect(page.getByTestId("manifest-commitment")).toBeVisible();
        await check(page, "check, everything open", watched);

        await page.getByRole("link", { name: "Looks right, continue" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Fund and send" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Practice mode: record a pretend deposit" })).toBeVisible();
        await check(page, "send, not yet funded", watched);

        await page.getByRole("button", { name: "Record mock deposit" }).click();
        await expect(page.getByText("Funded.")).toBeVisible();
        await check(page, "send, funded", watched);
        await page.getByRole("button", { name: "Send 5 payouts" }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await check(page, "send, the sheet", watched, { sheet: true });
        await page.keyboard.press("Escape");

        // And back one stage.
        await page.getByRole("link", { name: "Back to check" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Check the payouts" })).toBeVisible();
        await check(page, "check again", watched);
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
          // Not the mock chain: no practice pill and no pretend deposit on these pages.
          await expect(page.getByText("Practice mode"), `${label}: no practice pill`).toHaveCount(0);
          await expect(page.getByText("Practice mode: record"), `${label}: no pretend deposit`).toHaveCount(0);
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
        await expect(page.getByRole("button", { name: /^Send \d+ payouts?$/u })).toBeEnabled();
        await checkReal("funded");

        // The viewing key: not offered until the person agrees, hidden again on request.
        await page.getByRole("button", { name: "Auditor access" }).click();
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
