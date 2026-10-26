import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { axeViolations, overflowReport, THEMES, useTheme, VIEWPORTS } from "../helpers.js";
import { decodeScreenshot } from "../qr.js";
import { operatorUrl, seeded } from "./env.js";

// The QR code beside a campaign's funding address (openspec REQ-FUND-003), in a real browser: what a scanner reads from the
// pixels that were drawn, at phone and desktop width in both themes, that it is dark on light whatever the theme, and
// that the page around it is still sound. The mock chain has no funding address, so (as in a11y.spec.ts) the operator's
// own real-chain answers are served to the page in place of the mock chain's.

const GOLDEN_DIR = resolve(process.cwd(), "../fixtures/contract/operator/golden");
const golden = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(GOLDEN_DIR, name), "utf8")) as Record<string, unknown>;

const WALLET_LINK = "zcash:tFAKEfundingAddressNotARealAddress0000?amount=4.5002";
const MAINNET_ADDRESS = "t1cFrgk2qsbNHgNSmV8DNauWTCe6EKRLW9L";

async function serve(page: Page, campaign: Record<string, unknown> = {}, health: Record<string, unknown> = {}) {
  const { funded } = seeded();
  await page.route(/\/api\/health$/u, (route) => route.fulfill({ json: { ...golden("health-real.json"), ...health } }));
  await page.route(new RegExp(`/api/campaigns/${funded}$`, "u"), (route) =>
    route.fulfill({ json: { ...golden("campaign-real-awaiting-deposit.json"), ...campaign } }),
  );
  await page.goto(operatorUrl(`/campaign/${funded}`, { token: true }));
  await expect(page.getByTestId("funding-address")).toBeVisible();
}

const code = (page: Page) => page.getByRole("img", { name: /^QR code for this deposit/u });

/** What a scanner reads from the code on the screen. */
async function scanned(page: Page): Promise<string | null> {
  await expect(code(page)).toBeVisible();
  return decodeScreenshot(await code(page).screenshot());
}

function watch(page: Page): () => string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problems.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
  return () => problems;
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`the funding QR code, ${viewport.name}, ${theme} theme`, () => {
      // The density of a phone's screen, which is what a code on it is drawn at.
      test.use({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 2 });
      const wide = viewport.width >= 768;

      test("is read by a scanner as the wallet link, is dark on light, and the page stays sound", async ({ page }) => {
        await useTheme(page, theme);
        const problems = watch(page);
        await serve(page);
        await expect(page.getByRole("link", { name: "Open in wallet" })).toHaveAttribute("href", WALLET_LINK);

        if (wide) {
          // Shown beside the address, with nothing to press.
          await expect(page.getByRole("button", { name: /QR code/u })).toHaveCount(0);
        } else {
          // Behind a button: nothing is drawn until it is pressed.
          await expect(code(page)).toHaveCount(0);
          const show = page.getByRole("button", { name: "Show QR code" });
          await expect(show).toHaveAttribute("aria-expanded", "false");
          await show.click();
          await expect(page.getByRole("button", { name: "Hide QR code" })).toHaveAttribute("aria-expanded", "true");
        }
        await expect(page.getByText("Scan with a Zcash wallet on your phone: it fills in this address and the exact amount.")).toBeVisible();

        // The pixels, read by a decoder that did not draw them: exactly the wallet link.
        expect(await scanned(page)).toBe(WALLET_LINK);

        // Dark on light in both themes: the roles are black and white, and that is what was painted.
        await expect(code(page).locator("rect")).toHaveCSS("fill", "rgb(255, 255, 255)");
        await expect(code(page).locator("path")).toHaveCSS("fill", "rgb(0, 0, 0)");

        // Big enough to scan, and clean: from md up a whole number of pixels (five) to a module; on a phone as wide as the box allows.
        const box = await code(page).boundingBox();
        const modules = Number((await code(page).getAttribute("viewBox"))?.split(" ")[2]);
        if (wide) expect(box?.width).toBe(modules * 5);
        else expect(box?.width ?? 0).toBeGreaterThanOrEqual(270);

        expect(problems()).toEqual([]);
        const overflow = await overflowReport(page);
        expect(overflow.wide, "elements wider than the viewport").toEqual([]);
        expect(overflow.page, "horizontal scroll").toBeLessThanOrEqual(0);
        expect(await axeViolations(page), "accessibility violations").toEqual([]);
      });
    });
  }
}

test.describe("the funding QR code, for mainnet", () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });

  test("holds the mainnet wallet link, and the page still says to send exactly that", async ({ page }) => {
    await serve(page, { network: "mainnet", funding_address: MAINNET_ADDRESS }, { network: "mainnet" });
    await expect(page.getByText("Send exactly that amount.", { exact: false })).toBeVisible();
    expect(await scanned(page)).toBe(`zcash:${MAINNET_ADDRESS}?amount=4.5002`);
  });
});

test.describe("no funding QR code", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("when the campaign needs nothing, so that there is no wallet link either", async ({ page }) => {
    await serve(page, { funding_required: "0" });
    await expect(page.getByRole("link", { name: "Open in wallet" })).toHaveCount(0);
    await expect(code(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /QR code/u })).toHaveCount(0);
  });

  test("on the practice chain, where the operator's own answers are the mock chain's", async ({ page }) => {
    const { awaiting } = seeded();
    await page.goto(operatorUrl(`/campaign/${awaiting}`, { token: true }));
    await expect(page.getByRole("heading", { name: "Practice mode: record a pretend deposit" })).toBeVisible();
    await expect(code(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /QR code/u })).toHaveCount(0);
  });
});
