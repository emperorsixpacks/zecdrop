import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { test, type Page, type Route } from "@playwright/test";

import { useTheme, VIEWPORTS, type Theme } from "../helpers.js";
import { operatorUrl, seeded } from "./env.js";
import { loadDemoCsv } from "./privacy.js";

// Screenshots for design review. Not part of the normal run: it does nothing
// unless UI_SHOTS_DIR names a folder.
//
//   UI_SHOTS_DIR=/some/folder UI_SHOTS_STAGE=a npx playwright test --project=operator shots

const DIR = process.env["UI_SHOTS_DIR"];
const STAGE = process.env["UI_SHOTS_STAGE"] ?? "a";

test.skip(DIR === undefined, "set UI_SHOTS_DIR to take screenshots");

/** Midnight, dark (the look) and light. */
const LOOKS: readonly { theme: Theme }[] = [{ theme: "dark" }, { theme: "light" }];

/** The real demo list, with one amount spoiled, for the screen that shows a problem. */
function demoWithMistake(): string {
  return loadDemoCsv()
    .split("\n")
    .map((line, index) => (index === 4 ? line.replace(/,0\.\d+,/u, ",0.0005.1,") : line))
    .join("\n");
}


test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => {
    console.log("PAGEERROR", error.message.slice(0, 400));
  });
  page.on("console", (message) => {
    if (message.type() === "error") console.log("CONSOLE", message.text().slice(0, 300));
  });
});

// When a screen does not come up, keep what the page showed, so the reason can be seen.
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await page.screenshot({ path: join(shotsDir(), `FAILED-${testInfo.title.replace(/\W+/gu, "-")}-${String(Date.now())}.png`), fullPage: true });
    console.log("FAILED PAGE", page.url(), (await page.locator("body").innerText().catch(() => "")).slice(0, 500).replace(/\n/gu, " | "));
  }
});

const shotsDir = (): string => {
  const dir = join(DIR ?? "", STAGE);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** A full load: going from /x to /x#token=... is only a fragment change, which would keep the old page. */
async function load(page: Page, url: string) {
  await page.goto("about:blank");
  await page.goto(url);
}

/** Scroll down and back, so what draws itself when it comes into view has been seen, then let it finish. */
async function settle(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1200);
}

async function shoot(page: Page, name: string, width: number, look: string, fullPage = true) {
  if (fullPage) await settle(page);
  else await page.waitForTimeout(600);
  await page.screenshot({ path: join(shotsDir(), `${name}-${String(width)}-${look}.png`), fullPage });
}

for (const viewport of VIEWPORTS) {
  for (const look of LOOKS) {
    const name = look.theme;
    test.describe(`${String(viewport.width)} ${name}`, () => {
      // Motion as a visitor has it (Lively), so the stills show the glow and the drawn pieces.
      test.use({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: "no-preference" });

      test("stage 1 screens", async ({ page }) => {
        test.setTimeout(120_000);
        await useTheme(page, look.theme);
        const w = viewport.width;

        // Payouts: the list.
        await load(page, operatorUrl("/campaigns", { token: true }));
        await page.getByRole("heading", { level: 1, name: "Payouts" }).waitFor();
        await page.getByRole("list", { name: "Payouts" }).waitFor();
        await shoot(page, "payouts-list", w, name);

        // Payouts: empty (the operator really has some, so answer the list with none).
        await page.route(/\/api\/campaigns$/u, (route) => (route.request().method() === "GET" ? route.fulfill({ json: [] }) : route.continue()));
        await load(page, operatorUrl("/campaigns", { token: true }));
        await page.getByText("No payouts yet.").waitFor();
        await shoot(page, "payouts-empty", w, name);
        await page.unroute(/\/api\/campaigns$/u);

        // Stage 1, empty.
        await load(page, operatorUrl("/new", { token: true }));
        await page.getByRole("heading", { level: 1, name: "Add the payouts" }).waitFor();
        await shoot(page, "stage1-empty", w, name);

        // Stage 1 with the real demo list pasted in.
        await page.getByRole("button", { name: "or paste it" }).click();
        await page.getByLabel("Paste your list").fill(loadDemoCsv());
        await page.getByRole("button", { name: "Use this list" }).click();
        await page.getByTestId("payout-table").waitFor();
        await shoot(page, "stage1-list", w, name);

        // Stage 1 with Options open.
        await page.getByRole("button", { name: "Options" }).click();
        await shoot(page, "stage1-options", w, name);

        // Stage 1 with a mistake in one amount: the row says so at once, and the total leaves it out.
        await page.getByRole("button", { name: "Use a different list" }).click();
        await page.getByRole("button", { name: "or paste it" }).click();
        await page.getByLabel("Paste your list").fill(demoWithMistake());
        await page.getByRole("button", { name: "Use this list" }).click();
        await page.getByTestId("payout-table").waitFor();
        await page.getByText(/^Line \d+:/u).first().waitFor();
        await shoot(page, "stage1-mistake", w, name);
        // ...and after the operator has read it.
        await page.getByRole("button", { name: "Continue" }).click();
        await page.getByText(/problems? to fix/u).waitFor();
        await shoot(page, "stage1-problems", w, name);
      });

      // The screens a first-time operator sees: nothing yet, and what to do about it.
      test("empty states", async ({ page }) => {
        test.setTimeout(120_000);
        await useTheme(page, look.theme);
        const w = viewport.width;
        const captured = (file: string): Record<string, unknown> =>
          JSON.parse(readFileSync(join(resolve(process.cwd(), "../fixtures/contract/operator"), file), "utf8")) as Record<string, unknown>;
        const none = (route: Route) =>
          route.request().method() === "GET" ? route.fulfill({ json: [] }) : route.continue();

        // No payouts at all.
        await page.route(/\/api\/campaigns$/u, none);
        await load(page, operatorUrl("/campaigns", { token: true }));
        await page.getByRole("heading", { level: 1, name: "Payouts" }).waitFor();
        await page.getByTestId("payouts-empty").waitFor();
        await shoot(page, "payouts-empty", w, name);

        // The first run of the drop zone.
        await load(page, operatorUrl("/new", { token: true }));
        await page.getByRole("heading", { level: 1, name: "Add the payouts" }).waitFor();
        await shoot(page, "first-run-drop", w, name);

        // The audit page with nothing to audit.
        await load(page, operatorUrl("/audit", { token: true }));
        await page.getByRole("heading", { level: 1, name: "Audit" }).waitFor();
        await page.getByTestId("audit-empty").waitFor();
        await shoot(page, "audit-empty", w, name);
        await page.unroute(/\/api\/campaigns$/u);

        // A payout whose batches are not there yet.
        const id = "c-000000000001";
        await page.route(new RegExp(`/api/campaigns/${id}$`, "u"), (route) =>
          route.fulfill({ json: { ...captured("campaign-awaiting-funding.json"), batches: [], batch_count: 0 } }),
        );
        await load(page, operatorUrl(`/campaign/${id}`, { token: true }));
        await page.getByRole("button", { name: "Batches" }).click();
        await page.getByTestId("batches-empty").waitFor();
        await shoot(page, "batches-empty", w, name);
      });

      // "Fund from another coin" (served from the golden files: nothing leaves the browser), and the screens around it.
      test("the NEAR row and the quieter screens", async ({ page }) => {
        test.setTimeout(120_000);
        await useTheme(page, look.theme);
        const w = viewport.width;
        const golden = (file: string): Record<string, unknown> =>
          JSON.parse(readFileSync(join(resolve(process.cwd(), "../fixtures/contract/operator/golden"), file), "utf8")) as Record<string, unknown>;
        const { awaiting } = seeded();
        await page.route(/\/api\/health$/u, (route) => route.fulfill({ json: golden("health-real.json") }));
        let network = "testnet";
        await page.route(new RegExp(`/api/campaigns/${awaiting}$`, "u"), (route) =>
          route.fulfill({ json: { ...golden("campaign-real-awaiting-deposit.json"), id: awaiting, network } }),
        );
        await page.route(/\/api\/near\/tokens$/u, (route) => route.fulfill({ json: golden("near-tokens.json") }));
        await page.route(/\/api\/near\/preview$/u, (route) => route.fulfill({ json: golden("near-preview.json") }));
        await page.route(/\/funding\/near\/status$/u, (route) => route.fulfill({ status: 409, json: golden("error-near-no-live-quote.json") }));
        await page.route(/\/funding\/near\/dry-quote$/u, (route) => route.fulfill({ json: golden("near-dry-quote.json") }));

        await load(page, operatorUrl(`/campaign/${awaiting}`, { token: true }));
        await page.getByRole("button", { name: "Fund from another coin" }).waitFor();
        await shoot(page, "near-row-closed", w, name);
        await page.getByRole("button", { name: "Fund from another coin" }).click();
        await page.getByLabel("Asset to pay with").selectOption({ label: "USDC on near" });
        await page.getByRole("button", { name: "Show a price preview" }).click();
        await page.getByTestId("near-price").waitFor();
        await page.getByTestId("near-row").scrollIntoViewIfNeeded();
        await shoot(page, "near-row-preview", w, name, false);

        // A mainnet campaign: the refund address and the quote, held before the confirmation.
        network = "mainnet";
        await load(page, operatorUrl(`/campaign/${awaiting}`, { token: true }));
        await page.getByRole("button", { name: "Fund from another coin" }).click();
        await page.getByLabel("Asset to pay with").selectOption({ label: "USDC on near" });
        await page.getByLabel("Your refund address").fill("refund-account.near");
        await page.getByRole("button", { name: "Get a price quote" }).click();
        await page.getByRole("checkbox", { name: /I understand/u }).check();
        await page.getByRole("button", { name: "Create the deposit address" }).scrollIntoViewIfNeeded();
        await shoot(page, "near-row-quote", w, name, false);

        // The batches of a settled payout, opened.
        await page.unroute(/\/api\/health$/u);
        await page.unroute(new RegExp(`/api/campaigns/${awaiting}$`, "u"));
        await load(page, operatorUrl(`/campaign/${seeded().settled}`, { token: true }));
        await page.getByText("Sealed").waitFor();
        await page.getByRole("button", { name: "Batches" }).click();
        await page.getByRole("button", { name: "Batches" }).scrollIntoViewIfNeeded();
        await shoot(page, "batches-open", w, name, false);

        // The audit page with payouts: the command, and the rest behind its closed sections.
        await load(page, operatorUrl("/audit", { token: true }));
        await page.getByRole("heading", { level: 1, name: "Audit" }).waitFor();
        await page.getByRole("button", { name: "What the audit checks" }).waitFor();
        await shoot(page, "audit-short", w, name);

        // The screens a person meets when something is off.
        await load(page, operatorUrl("/campaigns"));
        await page.getByRole("heading", { level: 1, name: "Open the operator link" }).waitFor();
        await shoot(page, "explainer", w, name);
      });

      // Stage B: the check, send and campaign screens.
      test("stage B screens", async ({ page }) => {
        test.setTimeout(180_000);
        await useTheme(page, look.theme);
        const w = viewport.width;
        const captured = (file: string): Record<string, unknown> =>
          JSON.parse(readFileSync(join(resolve(process.cwd(), "../fixtures/contract/operator"), file), "utf8")) as Record<string, unknown>;
        const golden = (file: string): Record<string, unknown> =>
          JSON.parse(readFileSync(join(resolve(process.cwd(), "../fixtures/contract/operator/golden"), file), "utf8")) as Record<string, unknown>;
        const { funded, settled } = seeded();

        // The three stages, with the real demo list.
        await load(page, operatorUrl("/new", { token: true }));
        await page.getByRole("button", { name: "or paste it" }).click();
        await page.getByLabel("Paste your list").fill(loadDemoCsv());
        await page.getByRole("button", { name: "Use this list" }).click();
        await page.getByLabel("Name this payout run").fill("Autumn grants");
        await page.getByRole("button", { name: "Continue" }).click();
        await page.getByRole("heading", { level: 1, name: "Check the payouts" }).waitFor();
        await shoot(page, "check-public", w, name);
        await page.getByRole("radio", { name: "One person" }).click();
        await shoot(page, "check-person", w, name);
        await page.getByRole("radio", { name: "Auditor" }).click();
        await shoot(page, "check-auditor", w, name);
        await page.getByRole("radio", { name: "Public" }).click();
        await page.getByRole("button", { name: /^Why: / }).first().click();
        await shoot(page, "check-why", w, name, false);
        await page.keyboard.press("Escape");

        await page.getByRole("link", { name: "Looks right, continue" }).click();
        await page.getByRole("heading", { level: 1, name: "Fund and send" }).waitFor();
        await shoot(page, "send-unfunded", w, name);
        await page.getByRole("button", { name: "Record mock deposit" }).click();
        await page.getByText("Funded.").waitFor();
        await shoot(page, "send-funded", w, name);
        await page.getByRole("button", { name: /^Send \d+ payouts?$/u }).click();
        await page.getByRole("dialog").waitFor();
        await shoot(page, "send-sheet", w, name, false);
        await page.keyboard.press("Escape");

        // The run, as the operator reports it at three moments.
        const id = "c-000000000001";
        let current = captured("campaign-running.json");
        await page.route(new RegExp(`/api/campaigns/${id}$`, "u"), (route) => route.fulfill({ json: current }));
        await page.route(new RegExp(`/api/campaigns/${id}/events$`, "u"), (route) =>
          route.fulfill({ contentType: "text/event-stream", body: readFileSync(join(resolve(process.cwd(), "../fixtures/contract/operator"), "events-running.sse.txt"), "utf8") }),
        );
        await page.route(/\/api\/campaigns\/[^/]+\/receipt$/u, (route) => route.fulfill({ json: captured("receipt-running.json") }));
        await load(page, operatorUrl(`/campaign/${id}`, { token: true }));
        await page.getByRole("heading", { name: "Sending the payouts" }).waitFor();
        await shoot(page, "campaign-sending", w, name);
        current = captured("campaign-crashed.json");
        await load(page, operatorUrl(`/campaign/${id}`, { token: true }));
        await page.getByRole("button", { name: "Resume sending" }).waitFor();
        await shoot(page, "campaign-stopped", w, name);
        const running = captured("campaign-running.json") as { batches: Record<string, unknown>[] };
        current = {
          ...running,
          run: { state: "halted" },
          batches: running.batches.map((b, i) => (i === 0 ? { ...b, state: "failed", reason: "the node refused the transaction" } : b)),
        };
        await load(page, operatorUrl(`/campaign/${id}`, { token: true }));
        await page.getByText("the node refused the transaction").first().waitFor();
        await shoot(page, "campaign-failed", w, name);
        await page.unroute(new RegExp(`/api/campaigns/${id}$`, "u"));

        // Settled, from the real operator: the stamp and the three actions.
        await load(page, operatorUrl(`/campaign/${settled}`, { token: true }));
        await page.getByText("Sealed").waitFor();
        await shoot(page, "campaign-settled", w, name);
        await page.getByRole("button", { name: "Give an auditor access" }).click();
        await shoot(page, "campaign-auditor", w, name);

        // Waiting for a real deposit: "Is it funded?".
        await page.route(/\/api\/health$/u, (route) => route.fulfill({ json: golden("health-real.json") }));
        await page.route(new RegExp(`/api/campaigns/${funded}$`, "u"), (route) => route.fulfill({ json: golden("campaign-real-awaiting-deposit.json") }));
        await load(page, operatorUrl(`/campaign/${funded}`, { token: true }));
        await page.getByRole("heading", { name: "Is it funded?" }).waitFor();
        await shoot(page, "campaign-real-funding", w, name);

        // The audit page.
        await page.unroute(/\/api\/health$/u);
        await load(page, operatorUrl("/audit", { token: true }));
        await page.getByRole("heading", { level: 1, name: "Audit" }).waitFor();
        await shoot(page, "audit", w, name);
      });
    });
  }
}
