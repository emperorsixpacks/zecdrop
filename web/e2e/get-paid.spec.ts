import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { axeViolations, chooseFromIsland, overflowReport, THEMES, useTheme, VIEWPORTS, watchProblems } from "./helpers.js";
import { dumpBrowserState } from "./operator/privacy.js";

// The page that tells someone how to be paid, in a real browser: every kind of address that can be pasted, at phone
// and desktop width in both themes (no console problem, no sideways scroll, no accessibility violation), Share and
// Copy as a phone does them, the keyboard path, thumb-sized controls, and that nothing leaves the page and nothing
// is kept (openspec REQ-ONB-001). The hosted build under its Content-Security-Policy is e2e/hosted/hosted.spec.ts.

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const MAINNET = `u1${BECH32.repeat(4).slice(0, 104)}`;
const TESTNET = (readFileSync(resolve(process.cwd(), "..", "examples", "demo-recipients.testnet.csv"), "utf8").trim().split("\n")[1] ?? "").split(",")[0] ?? "";
const TRANSPARENT = "t1cFrgk2qsbNHgNSmV8DNauWTCe6EKRLW9L";
const SAPLING = `zs1${BECH32.repeat(3).slice(0, 75)}`;

interface Kind {
  name: string;
  text: string;
  kind: string;
  title: string;
  /** Whether Share and Copy turn on. */
  suits: boolean;
}

const KINDS: Kind[] = [
  { name: "a real-money address", text: MAINNET, kind: "mainnet_unified", title: "Looks like a real-money address", suits: true },
  { name: "a practice address", text: TESTNET, kind: "testnet_unified", title: "Looks like a practice address", suits: true },
  { name: "a transparent address", text: TRANSPARENT, kind: "transparent", title: "Looks like a transparent address", suits: false },
  { name: "a Sapling address", text: SAPLING, kind: "sapling", title: "Looks like a Sapling address", suits: false },
  { name: "something that is not an address", text: "hello there", kind: "unrecognised", title: "Not recognised", suits: false },
];

async function check(page: Page, label: string, problems: () => string[]) {
  expect(problems(), `${label}: console`).toEqual([]);
  const overflow = await overflowReport(page);
  expect(overflow.wide, `${label}: elements wider than the viewport`).toEqual([]);
  expect(overflow.page, `${label}: horizontal scroll`).toBeLessThanOrEqual(0);
  expect(await axeViolations(page), `${label}: accessibility violations`).toEqual([]);
}

/** The phone has a share sheet: `navigator.share` is there from the first script, and answers as said. */
async function withShare(page: Page, answer: "ok" | "closed" | "refused") {
  await page.addInitScript((how) => {
    const shared: unknown[] = [];
    (window as unknown as { __shared: unknown[] }).__shared = shared;
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: (data: unknown) => {
        shared.push(data);
        if (how === "closed") return Promise.reject(new DOMException("Share canceled", "AbortError"));
        if (how === "refused") return Promise.reject(new DOMException("not allowed", "NotAllowedError"));
        return Promise.resolve();
      },
    });
  }, answer);
}

const shared = (page: Page) => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared);

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`${viewport.name}, ${theme} theme`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      for (const kind of KINDS) {
        test(`the get-paid page: ${kind.name}`, async ({ page }) => {
          await useTheme(page, theme);
          await withShare(page, "ok");
          const problems = watchProblems(page);
          await page.goto("/get-paid");
          await expect(page.getByRole("heading", { level: 1, name: "Get paid in ZEC" })).toBeVisible();
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

          await page.getByLabel("Your address").fill(kind.text);
          const shape = page.getByTestId("shape");
          await expect(shape).toHaveAttribute("data-kind", kind.kind);
          await expect(shape).toContainText(kind.title);
          for (const name of ["Share", "Copy"]) {
            if (kind.suits) await expect(page.getByRole("button", { name, exact: true })).toBeEnabled();
            else await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
          }
          await check(page, kind.name, problems);
        });
      }

      test("the get-paid page: after Copy", async ({ page, context }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await useTheme(page, theme);
        const problems = watchProblems(page);
        await page.goto("/get-paid");
        await page.getByLabel("Your address").fill(MAINNET);
        await page.getByRole("button", { name: "Copy", exact: true }).click();
        await expect(page.getByTestId("share-feedback")).toHaveText("Address copied.");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(MAINNET);
        await check(page, "after Copy", problems);
      });
    });
  }
}

test.describe("Share and Copy, as a phone does them", () => {
  test.use({ viewport: { width: 360, height: 740 }, permissions: ["clipboard-read", "clipboard-write"] });

  test("Share hands the share sheet one sentence with the address, and nothing else is said or sent", async ({ page }) => {
    await withShare(page, "ok");
    await page.goto("/get-paid");
    await page.getByLabel("Your address").fill(`\n  ${MAINNET.toUpperCase()}  \n`);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect.poll(() => shared(page)).toEqual([{ text: `My Zcash address for payouts: ${MAINNET}` }]);
    await expect(page.getByTestId("share-feedback")).toBeEmpty();
  });

  test("closing the share sheet says nothing, and the address stays", async ({ page }) => {
    await withShare(page, "closed");
    await page.goto("/get-paid");
    await page.getByLabel("Your address").fill(MAINNET);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect.poll(async () => (await shared(page)).length).toBe(1);
    await expect(page.getByTestId("share-feedback")).toBeEmpty();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByLabel("Your address")).toHaveValue(MAINNET);
    await expect(page.getByRole("button", { name: "Share", exact: true })).toBeEnabled();
  });

  test("a share that is refused falls back to copying the address, and says so", async ({ page }) => {
    await withShare(page, "refused");
    await page.goto("/get-paid");
    await page.getByLabel("Your address").fill(MAINNET);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect(page.getByTestId("share-feedback")).toHaveText("Sharing did not work here, so the address was copied instead.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(MAINNET);
  });

  test("with no share sheet there is Copy alone", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    });
    await page.goto("/get-paid");
    await expect(page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
    await page.getByLabel("Your address").fill(MAINNET);
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(page.getByTestId("share-feedback")).toHaveText("Address copied.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(MAINNET);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("every control is at least as tall as a thumb, and nothing is wider than the screen", async ({ page }) => {
    await withShare(page, "ok");
    await page.goto("/get-paid");
    await page.getByLabel("Your address").fill(MAINNET);
    const small: string[] = [];
    for (const control of await page.locator("main a, main button, main textarea").all()) {
      if (!(await control.isVisible())) continue;
      const box = await control.boundingBox();
      if (box !== null && box.height < 44) small.push(`${(await control.innerText()).slice(0, 30)}: ${String(Math.round(box.height))}px`);
    }
    expect(small).toEqual([]);
    const overflow = await overflowReport(page);
    expect(overflow.wide).toEqual([]);
    expect(overflow.page).toBeLessThanOrEqual(0);
  });

  test("a long address wraps in its box, and the box does not push the page sideways", async ({ page }) => {
    await page.goto("/get-paid");
    await page.getByLabel("Your address").fill(`u1${"q".repeat(1000)}`);
    const overflow = await overflowReport(page);
    expect(overflow.wide).toEqual([]);
    expect(overflow.page).toBeLessThanOrEqual(0);
  });
});

test.describe("what the page does with an address", () => {
  test.use({ viewport: { width: 360, height: 740 }, permissions: ["clipboard-read", "clipboard-write"] });

  // covers: REQ-ONB-001
  test("asks for nothing once it has loaded, keeps nothing, and puts nothing in the address bar", async ({ page }) => {
    await withShare(page, "ok");
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    const messages: string[] = [];
    page.on("console", (message) => messages.push(`${message.type()}: ${message.text()}`));
    await page.goto("/get-paid");
    await expect(page.getByRole("heading", { level: 1, name: "Get paid in ZEC" })).toBeVisible();
    // A font is fetched the first time a letter of it is drawn, so draw the box's once before counting.
    await page.getByLabel("Your address").fill(MAINNET);
    await page.getByLabel("Your address").fill("");
    await page.waitForLoadState("networkidle");
    const origin = new URL(page.url()).origin;
    const loaded = requests.length;
    // Everything the page fetched was its own: files from this site, and nothing else.
    expect(requests.filter((url) => !url.startsWith(origin) && !url.startsWith("data:"))).toEqual([]);

    // Pasted, checked, shared, copied: an address of every kind.
    for (const kind of KINDS) {
      await page.getByLabel("Your address").fill(kind.text);
      await expect(page.getByTestId("shape")).toHaveAttribute("data-kind", kind.kind);
    }
    await page.getByLabel("Your address").fill(MAINNET);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(page.getByTestId("share-feedback")).toHaveText("Address copied.");
    await page.waitForLoadState("networkidle");

    // Not one request after it had loaded; nothing left in any place the browser keeps; the address bar is as it was.
    expect(requests.slice(loaded)).toEqual([]);
    expect(await dumpBrowserState(page)).not.toContain(MAINNET);
    expect(await dumpBrowserState(page)).not.toContain(TESTNET);
    expect(page.url()).toBe(`${origin}/get-paid`);
    expect(requests.join(" ")).not.toContain(MAINNET);
    expect(messages.filter((line) => line.includes(MAINNET) || line.includes(TESTNET))).toEqual([]);
    // And going to another page and back finds an empty box.
    await chooseFromIsland(page, "How privacy works");
    await expect(page.getByRole("heading", { level: 1, name: "How privacy works" })).toBeVisible();
    await page.goBack();
    await expect(page.getByLabel("Your address")).toHaveValue("");
  });

  test("works from the keyboard alone", async ({ page }) => {
    // No share sheet here, so Copy is the one button and the order is the same on every machine.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    });
    await page.goto("/get-paid");
    await page.getByLabel("Your address").focus();
    await page.keyboard.insertText(MAINNET);
    await expect(page.getByTestId("shape")).toHaveAttribute("data-kind", "mainnet_unified");
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toHaveText("Copy");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("share-feedback")).toHaveText("Address copied.");
    // Tab carries on to the link in step 4; Shift+Tab comes back, to Copy and to the box.
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toHaveText("Check a payslip");
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator(":focus")).toHaveText("Copy");
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByLabel("Your address")).toBeFocused();
  });
});
