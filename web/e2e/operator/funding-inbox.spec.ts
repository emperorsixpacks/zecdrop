import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { axeViolations, overflowReport, THEMES, useTheme } from "../helpers.js";
import { decodeScreenshot } from "../qr.js";
import { operatorUrl, seeded } from "./env.js";

// A payout's shielded deposit address on the funding screen (openspec REQ-FUND-008), in a real browser. The mock chain has no
// inbox, so (as in funding-qr.spec.ts) the operator's own real-chain answers for each of the inbox's states are served to the
// page: at the narrowest phone width and on a desktop, in both themes, the QR code a scanner reads is the inbox's wallet
// link, the public address is one tap away until anything arrives, nothing is wider than the screen, and there are no
// accessibility violations.

const GOLDEN_DIR = resolve(process.cwd(), "../fixtures/contract/operator/golden");
const golden = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(GOLDEN_DIR, name), "utf8")) as Record<string, unknown>;

const INBOX_ADDRESS = "utest1FAKEinboxDepositAddressNotARealAddress";
const INBOX_LINK = `zcash:${INBOX_ADDRESS}?amount=4.50035`;

async function serve(page: Page, file: string) {
  const { funded } = seeded();
  await page.route(/\/api\/health$/u, (route) => route.fulfill({ json: golden("health-real.json") }));
  await page.route(new RegExp(`/api/campaigns/${funded}$`, "u"), (route) => route.fulfill({ json: golden(file) }));
  // A fresh load each time: going to the same URL again only moves within the page, which then shows what it already has
  // (a funded payout's page does not ask again).
  await page.goto("about:blank");
  await page.goto(operatorUrl(`/campaign/${funded}`, { token: true }));
}

async function sound(page: Page, label: string) {
  const overflow = await overflowReport(page);
  expect(overflow.wide, `${label}: elements wider than the viewport`).toEqual([]);
  expect(overflow.page, `${label}: horizontal scroll`).toBeLessThanOrEqual(0);
  expect(await axeViolations(page), `${label}: accessibility violations`).toEqual([]);
}

for (const viewport of [
  { name: "phone 320px", width: 320, height: 700 },
  { name: "desktop 1280px", width: 1280, height: 800 },
]) {
  for (const theme of THEMES) {
    test.describe(`the shielded deposit address, ${viewport.name}, ${theme} theme`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 2 });
      const wide = viewport.width >= 768;

      test("leads with the shielded address, whose QR code reads as its wallet link, with the public one as the fallback", async ({ page }) => {
        await useTheme(page, theme);
        await serve(page, "campaign-real-inbox-waiting.json");
        await expect(page.getByTestId("inbox-address")).toHaveText(INBOX_ADDRESS);
        await expect(page.getByRole("link", { name: "Open in wallet" })).toHaveAttribute("href", INBOX_LINK);
        if (!wide) await page.getByRole("button", { name: "Show QR code" }).click();
        const code = page.getByRole("img", { name: /^QR code for this deposit: the payout's shielded address/u });
        await expect(code).toBeVisible();
        expect(decodeScreenshot(await code.screenshot())).toBe(INBOX_LINK);
        await sound(page, "waiting");
        await page.getByRole("button", { name: "Pay the public address instead" }).click();
        await expect(page.getByTestId("funding-address")).toBeVisible();
        await sound(page, "the public address, opened");
      });

      test("says where it stands in each state, and the page stays sound", async ({ page }) => {
        await useTheme(page, theme);
        for (const [file, text] of [
          ["campaign-real-inbox-confirming.json", /has 1 of 10 confirmations/u],
          ["campaign-real-inbox-short.json", /has arrived\. Send .+ more\./u],
          ["campaign-real-inbox-scheduled.json", /is ready\. At about/u],
          ["campaign-real-inbox-moving.json", /Moving .+ to the payout's public address/u],
          ["campaign-real-inbox-unavailable.json", /can't be used right now/u],
          ["campaign-real-inbox-checking.json", /Checking what has reached this payout's shielded address/u],
        ] as const) {
          await serve(page, file);
          await expect(page.getByTestId("inbox-status")).toContainText(text);
          await sound(page, file);
          await page.unrouteAll({ behavior: "ignoreErrors" });
        }
        await serve(page, "campaign-real-inbox-moved.json");
        await expect(page.getByText("Moved here from this payout's shielded address.")).toBeVisible();
        await expect(page.getByTestId("inbox-left")).toBeVisible();
        await sound(page, "moved");
        await page.unrouteAll({ behavior: "ignoreErrors" });
        await serve(page, "campaign-real-inbox-returning.json");
        await expect(page.getByTestId("inbox-returning")).toContainText(/Sending what is left back, in transaction/u);
        await sound(page, "returning");
      });
    });
  }
}
