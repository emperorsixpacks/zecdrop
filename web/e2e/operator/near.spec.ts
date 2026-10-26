import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Page, type Request } from "@playwright/test";

import { axeViolations, overflowReport, THEMES, useTheme, VIEWPORTS } from "../helpers.js";
import { operatorUrl, seeded } from "./env.js";

// "Fund from another coin": the collapsed row under the funding address of a real-chain
// campaign. The mock chain has no funding address, so this serves the real-chain answers from
// the operator's golden files, for the campaign and for the price service's routes. The page is
// never allowed to reach the routes that create or follow a swap: this is a TESTNET campaign,
// where only a price preview exists, and nothing here can send a quote or a deposit anywhere.

const GOLDEN = resolve(process.cwd(), "../fixtures/contract/operator/golden");
const golden = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(GOLDEN, name), "utf8")) as Record<string, unknown>;

const NEAR_REQUEST = /\/api\/near\//u;
const SWAP_REQUEST = /dry-quote|live-quote|funding\/near/u;

async function serveRealChain(page: Page, id: string, options: { tokens?: "ok" | "unavailable" } = {}): Promise<Request[]> {
  const seen: Request[] = [];
  page.on("request", (request) => {
    if (NEAR_REQUEST.test(request.url()) || SWAP_REQUEST.test(request.url())) seen.push(request);
  });
  await page.route(/\/api\/health$/u, (route) => route.fulfill({ json: golden("health-real.json") }));
  await page.route(new RegExp(`/api/campaigns/${id}$`, "u"), (route) =>
    route.fulfill({ json: { ...golden("campaign-real-awaiting-deposit.json"), id } }),
  );
  await page.route(/\/api\/near\/tokens$/u, (route) =>
    options.tokens === "unavailable"
      ? route.fulfill({ status: 503, json: golden("error-near-unavailable.json") })
      : route.fulfill({ json: golden("near-tokens.json") }),
  );
  await page.route(/\/api\/near\/preview$/u, (route) => route.fulfill({ json: golden("near-preview.json") }));
  return seen;
}

/** A MAINNET campaign, for the part of the row that has a refund address and a confirmation. Every route the page can
 * reach is answered here from golden files, so nothing leaves the browser; the one that would create a deposit address
 * is not answered at all: asking for it fails the test. */
async function serveMainnet(page: Page, id: string): Promise<{ liveAsked: () => number }> {
  let live = 0;
  await page.route(/\/api\/health$/u, (route) => route.fulfill({ json: golden("health-real.json") }));
  await page.route(new RegExp(`/api/campaigns/${id}$`, "u"), (route) =>
    route.fulfill({ json: { ...golden("campaign-real-awaiting-deposit.json"), id, network: "mainnet" } }),
  );
  await page.route(/\/api\/near\/tokens$/u, (route) => route.fulfill({ json: golden("near-tokens.json") }));
  await page.route(/\/funding\/near\/status$/u, (route) => route.fulfill({ status: 409, json: golden("error-near-no-live-quote.json") }));
  await page.route(/\/funding\/near\/dry-quote$/u, (route) => route.fulfill({ json: golden("near-dry-quote.json") }));
  await page.route(/\/funding\/near\/live-quote$/u, (route) => {
    live += 1;
    return route.abort();
  });
  return { liveAsked: () => live };
}

const row = (page: Page) => page.getByRole("button", { name: "Fund from another coin" });

async function noProblems(page: Page, label: string, problems: string[]): Promise<void> {
  expect(problems, `${label}: console`).toEqual([]);
  const overflow = await overflowReport(page);
  expect(overflow.wide, `${label}: elements wider than the viewport`).toEqual([]);
  expect(overflow.page, `${label}: horizontal scroll`).toBeLessThanOrEqual(0);
  expect(await axeViolations(page), `${label}: accessibility violations`).toEqual([]);
}

function listen(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problems.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
  return problems;
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`the NEAR row, ${viewport.name}, ${theme} theme`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      test("is closed under the funding address, asks the service nothing, and is accessible", async ({ page }) => {
        await useTheme(page, theme);
        const problems = listen(page);
        const { awaiting } = seeded();
        const seen = await serveRealChain(page, awaiting);
        await page.goto(operatorUrl(`/campaign/${awaiting}`, { token: true }));

        await expect(page.getByTestId("funding-address")).toBeVisible();
        await expect(row(page)).toBeVisible();
        await expect(row(page)).toHaveAttribute("aria-expanded", "false");
        expect(seen, "nothing is asked of the price service until the row is opened").toHaveLength(0);
        // The row sits under the address and above the waiting line.
        const addressBox = await page.getByTestId("funding-address").boundingBox();
        const rowBox = await row(page).boundingBox();
        const waitingBox = await page.getByText("Waiting for funds").boundingBox();
        expect(rowBox?.y ?? 0).toBeGreaterThan(addressBox?.y ?? Infinity);
        expect(rowBox?.y ?? Infinity).toBeLessThan(waitingBox?.y ?? 0);
        expect(rowBox?.height ?? 0, "a touch target").toBeGreaterThanOrEqual(44);
        await noProblems(page, "closed", problems);
      });

      test("opens to a price preview that creates nothing, and never reaches a route that does", async ({ page }) => {
        await useTheme(page, theme);
        const problems = listen(page);
        const { awaiting } = seeded();
        const seen = await serveRealChain(page, awaiting);
        await page.goto(operatorUrl(`/campaign/${awaiting}`, { token: true }));

        await row(page).click();
        await expect(row(page)).toHaveAttribute("aria-expanded", "true");
        await page.getByLabel("Asset to pay with").selectOption({ label: "USDC on near" });
        await noProblems(page, "open, asset chosen", problems);

        await page.getByRole("button", { name: "Show a price preview" }).click();
        const shown = page.getByTestId("near-price");
        await expect(shown).toBeVisible();
        await expect(shown).toContainText("Nothing is created. There is no deposit address.");
        await expect(shown).toContainText("you would send about 7.679013 USDC on near");
        // Proportional figures, so the decimal point is not given a digit's width.
        await expect(shown.locator("strong")).toHaveCSS("font-variant-numeric", "normal");
        await expect(page.getByText("The campaign counts as funded only when the coin appears on chain.")).toBeVisible();
        await noProblems(page, "preview shown", problems);

        const asked = seen.filter((r) => r.method() === "POST");
        expect(asked.map((r) => new URL(r.url()).pathname)).toEqual(["/api/near/preview"]);
        expect(asked[0]?.postDataJSON()).toEqual({
          origin_asset_id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
          amount_zat: "450020000",
        });
        expect(
          seen.filter((r) => SWAP_REQUEST.test(r.url())).map((r) => r.url()),
          "no quote, deposit address or swap status is ever asked for on a testnet campaign",
        ).toEqual([]);
        // The checkbox, the refund field and the deposit address belong to mainnet only.
        await expect(page.getByRole("checkbox")).toHaveCount(0);
        await expect(page.getByLabel("Your refund address")).toHaveCount(0);
        await expect(page.getByTestId("near-deposit")).toHaveCount(0);
      });

      test("when the price service is unreachable, says so inside the row and leaves the page usable", async ({ page }) => {
        await useTheme(page, theme);
        const problems = listen(page);
        const { awaiting } = seeded();
        await serveRealChain(page, awaiting, { tokens: "unavailable" });
        await page.goto(operatorUrl(`/campaign/${awaiting}`, { token: true }));

        await row(page).click();
        await expect(page.getByRole("heading", { name: "The price service could not be reached" })).toBeVisible();
        await expect(page.getByText(/Nothing was created/u)).toBeVisible();
        await expect(page.getByTestId("funding-address")).toBeVisible();
        await expect(page.getByRole("button", { name: "Check for the deposit now" })).toBeEnabled();
        // The browser logs the failed fetch itself; anything else is a problem.
        const logged = problems.splice(0).filter((p) => !/status of 503/u.test(p));
        await noProblems(page, "service unreachable", logged);
      });
    });
  }
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`the NEAR row on a mainnet campaign, ${viewport.name}, ${theme} theme`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      test("takes a refund address, shows a price quote, and holds at the confirmation without asking for a deposit address", async ({
        page,
      }) => {
        await useTheme(page, theme);
        const problems = listen(page);
        const { awaiting } = seeded();
        const served = await serveMainnet(page, awaiting);
        const asked: Request[] = [];
        page.on("request", (request) => {
          if (SWAP_REQUEST.test(request.url())) asked.push(request);
        });
        await page.goto(operatorUrl(`/campaign/${awaiting}`, { token: true }));

        await row(page).click();
        const find = page.getByLabel("Asset to pay with");
        await expect(find).toBeVisible();
        const quote = page.getByRole("button", { name: "Get a price quote" });
        await expect(quote).toBeDisabled();
        await find.selectOption({ label: "USDC on near" });
        await page.getByLabel("Your refund address").fill("refund-account.near");
        await expect(quote).toBeEnabled();
        // The operator's 409 for "no swap yet" is the answer to the first look, and expected.
        const logged = problems.splice(0).filter((p) => !/status of 409/u.test(p));
        await noProblems(page, "form", logged);

        await quote.click();
        await expect(page.getByTestId("near-price")).toContainText("Nothing is created yet.");
        const create = page.getByRole("button", { name: "Create the deposit address" });
        await expect(create).toBeDisabled();
        await noProblems(page, "quote shown", []);

        const understood = page.getByRole("checkbox", { name: /I understand that this creates a deposit address/u });
        const box = await understood.boundingBox();
        expect(box?.width ?? 0, "a checkbox people can hit").toBeGreaterThanOrEqual(20);
        await understood.check();
        await expect(create).toBeEnabled();
        await noProblems(page, "confirmed, not yet asked", []);

        // Held here: the person has not pressed the button, and the test never does.
        expect(served.liveAsked(), "no deposit address was asked for").toBe(0);
        expect(asked.filter((r) => /live-quote/u.test(r.url()))).toHaveLength(0);
        expect(asked.find((r) => /dry-quote/u.test(r.url()))?.postDataJSON()).toEqual({
          origin_asset_id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
          refund_to: "refund-account.near",
        });
      });
    });
  }
}

test("the row works from the keyboard alone", async ({ page }) => {
  const { awaiting } = seeded();
  await serveRealChain(page, awaiting);
  await page.goto(operatorUrl(`/campaign/${awaiting}`, { token: true }));
  await row(page).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Asset to pay with")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Asset to pay with")).toHaveCount(0);
  await page.keyboard.press("Space");
  await expect(page.getByLabel("Asset to pay with")).toBeVisible();
});
