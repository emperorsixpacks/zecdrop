import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { axeViolations, chooseFromIsland, island, overflowReport, recordTexts, THEMES, useTheme, VIEWPORTS, watchProblems, watchRequests } from "./helpers.js";
import { dumpBrowserState } from "./operator/privacy.js";

// Practice mode, in a real browser (openspec REQ-DEMO-001): the operator's own screens against a simulation inside the page. A
// whole payout is made from the home page to the simulated receipt at phone and desktop width in both themes, with the banner
// and axe checked on every screen, and the page watched for every request it makes: none may be to an operator, a verifier or a
// node, and the only things fetched are the app's own static files. Then practice mode is left, and what it leaves is checked.

const BANNER =
  "Practice mode: everything here is simulated in your browser. No real money, nothing is sent anywhere, nothing is saved. Reloading starts over.";
const FLAG = "zecdrop.practice";
const ORIGIN = "http://127.0.0.1:4173";

const demoList = readFileSync(resolve(process.cwd(), "../examples/demo-recipients.testnet.csv"), "utf8");
const DEMO_ADDRESSES = demoList
  .trim()
  .split("\n")
  .slice(1)
  .map((line) => line.split(",")[0] ?? "");

// Exactly: the funding screen has a section of its own whose name begins the same way.
const banner = (page: Page) => page.getByRole("region", { name: "Practice mode", exact: true });

/** What must be true of every screen of a practice payout: the banner, Practice on the header capsule, no ZEC amount, nothing
 * wider than the screen, and no accessibility violation. */
async function sound(page: Page, name: string) {
  // No token in the address bar, nor anything after a "#": practice mode needs no operator link.
  expect(new URL(page.url()).hash, `${name}: a fragment in the address`).toBe("");
  expect(page.url(), `${name}: a token in the address`).not.toMatch(/token/iu);
  await expect(banner(page), `${name}: the banner`).toContainText(BANNER);
  await expect(banner(page).getByRole("button", { name: "Leave practice mode" }), `${name}: the way out`).toBeVisible();
  // The capsule names no network: it says what this is, without being opened.
  await expect(island(page).getByText("Practice", { exact: true }), `${name}: Practice on the capsule`).toBeVisible();
  expect(await page.locator("main").innerText(), `${name}: an amount in ZEC`).not.toMatch(/\bZEC\b/u);
  const overflow = await overflowReport(page);
  expect(overflow.wide, `${name}: elements wider than the viewport`).toEqual([]);
  expect(overflow.page, `${name}: horizontal scroll`).toBeLessThanOrEqual(0);
  expect(await axeViolations(page), `${name}: accessibility violations`).toEqual([]);
}

/** Every URL the page asked for that is not one of the app's own static files. */
function notStatic(urls: string[]): string[] {
  return urls.filter((href) => {
    const url = new URL(href);
    if (url.origin !== ORIGIN) return true;
    // The app's own static files: the page, its code and fonts, the tour's pictures, the icon, and the paper's grain (public/grain.png).
    return !(url.pathname === "/" || /^\/(assets|tour)\//u.test(url.pathname) || ["/favicon.svg", "/favicon.ico", "/grain.png"].includes(url.pathname));
  });
}

/** Every URL the page asked for that went to another origin, or to a route that only an operator or a verifier answers. */
function reachedAServer(urls: string[]): string[] {
  return urls.filter((href) => {
    const url = new URL(href);
    return url.origin !== ORIGIN || /^\/(api|v1|health)\b/u.test(url.pathname) || /^\/campaigns\/./u.test(url.pathname);
  });
}

/** The tab's own memory of itself: the keys of both storages, and the cookie string. */
async function kept(page: Page) {
  return await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage), cookie: document.cookie }));
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`practice mode, ${viewport.name}, ${theme} theme`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      test("a whole practice payout, from the home page to the simulated receipt", async ({ page }) => {
        test.setTimeout(90_000);
        await useTheme(page, theme);
        const problems = watchProblems(page);
        const requests = watchRequests(page);
        const recorded = await recordTexts(page);

        await page.goto("/");
        await expect(page.getByRole("heading", { level: 1, name: /Pay many people/u })).toBeVisible();
        // Before it is asked for, practice mode is nowhere: no banner, and its code is not fetched.
        await expect(banner(page)).toHaveCount(0);
        expect(requests().some((url) => /\/assets\/simulation-/u.test(url))).toBe(false);
        expect(await axeViolations(page), "the home page").toEqual([]);

        await page.getByRole("button", { name: "Try a practice payout" }).click();

        // 1. Add the payouts, with the example list.
        await expect(page.getByRole("heading", { level: 1, name: "Add the payouts" })).toBeVisible();
        expect(requests().some((url) => /\/assets\/simulation-/u.test(url))).toBe(true);
        await sound(page, "add the payouts");
        await expect(page.getByRole("button", { name: "Use the example list" })).toBeVisible();
        await page.getByRole("button", { name: "Use the example list" }).click();
        await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
        await expect(page.getByTestId("payout-count")).toHaveText("8 people");
        await sound(page, "the example list");
        await page.getByRole("button", { name: "Continue" }).click();

        // 2. Check them: the lens and the privacy notes.
        await expect(page.getByRole("heading", { level: 1, name: "Check the payouts" })).toBeVisible();
        await expect(page.getByTestId("payout-summary")).toContainText("8 people");
        await expect(page.getByTestId("payout-summary")).toContainText("0.005 TAZ");
        await expect(page.getByRole("heading", { level: 2, name: "Who sees what" })).toBeVisible();
        await expect(page.getByRole("heading", { level: 2, name: "Privacy warnings" })).toBeVisible();
        await sound(page, "check the payouts");
        await page.getByRole("link", { name: "Looks right, continue" }).click();

        // 3. Fund it with the pretend deposit.
        await expect(page.getByRole("heading", { level: 1, name: "Fund and send" })).toBeVisible();
        await expect(page.getByRole("heading", { level: 2, name: "Practice mode: record a pretend deposit" })).toBeVisible();
        await sound(page, "fund and send");
        await page.getByRole("button", { name: "Record mock deposit" }).click();
        await expect(page.getByText("Funded.", { exact: true })).toBeVisible();
        await sound(page, "funded");

        // 4. Send: the sheet, then the timeline.
        await page.getByRole("button", { name: "Send 8 payouts" }).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet).toBeVisible();
        // The sheet covers the banner on a phone that has scrolled, so it says what it is itself, and does not say that what it
        // simulates cannot be undone.
        await expect(sheet).toContainText("Practice mode: nothing is sent anywhere. This only simulates it.");
        await expect(sheet).toContainText("In a real run this cannot be undone.");
        await expect(sheet).not.toContainText("It cannot be undone");
        expect(await axeViolations(page), "the send sheet").toEqual([]);
        await sheet.getByRole("button", { name: "Send 8 payouts" }).click();
        await expect(page.getByRole("heading", { level: 2, name: "Sending the payouts" })).toBeVisible();
        await sound(page, "sending");
        await expect(page.getByRole("heading", { level: 2, name: "All 1 batch is confirmed" })).toBeVisible({ timeout: 20_000 });
        // The timeline said the run was simulated where the operator's own screens speak of blocks and of the network, and never
        // said it went to the network or waited for a block. Each of its wordings is on the screen for one step of the run, and an
        // accessibility check takes longer than that on a slow machine, so it is the page's own record of what it said that is read.
        const said = await recorded();
        expect(said.some((text) => /^\d of 3 confirmations \(simulated\)\.$/u.test(text)), "the confirmations, counted as simulated").toBe(true);
        expect(said.filter((text) => /to the network|next block/iu.test(text)), "what was said of the network or of a block").toEqual([]);
        await sound(page, "settled");

        // 5. Open the simulated public receipt.
        await page.getByRole("link", { name: "Open public receipt" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Payout receipt" })).toBeVisible();
        await expect(page.getByRole("heading", { level: 2, name: "Status" })).toBeAttached();
        await expect(page.getByText(/^Practice id:/u)).toBeVisible();
        await expect(page.getByText("A practice receipt")).toBeVisible();
        await sound(page, "the simulated receipt");
        // Its transaction ids are on no chain: no explorer link, and the id says so.
        await page.getByRole("button", { name: "Transaction" }).click();
        // (The batches are drawn as a table and as cards, and CSS shows one: look at the one that is shown.)
        await expect(page.getByText(/Practice id: on no chain/u).filter({ visible: true }).first()).toBeVisible();
        await expect(page.getByRole("link", { name: /Explorer/u })).toHaveCount(0);

        // Nothing went anywhere: not one request but the app's own static files, and nothing console-worthy happened.
        expect(notStatic(requests()), "requests that were not the app's own files").toEqual([]);
        expect(problems()).toEqual([]);

        // Nothing was kept but the flag: the tab's storage holds it (and the theme chosen above), no cookie, nothing else.
        const memory = await kept(page);
        expect(memory.session).toEqual([FLAG]);
        expect(memory.local.filter((key) => key !== "zd:theme")).toEqual([]);
        expect(memory.cookie).toBe("");
        const everything = await dumpBrowserState(page);
        for (const address of DEMO_ADDRESSES) expect(everything).not.toContain(address);
      });
    });
  }
}

test.describe("practice mode, around the edges", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("works from the keyboard alone, from a reload in practice mode to the receipt", async ({ page }) => {
    test.setTimeout(90_000);
    // A tab that was in practice mode: the flag is there when the page loads, and the app carries on in it.
    await page.addInitScript((flag) => {
      sessionStorage.setItem(flag, "1");
    }, FLAG);
    await page.goto("/new");
    await expect(page.getByRole("heading", { level: 1, name: "Add the payouts" })).toBeVisible();
    await expect(banner(page)).toBeVisible();

    // The banner and its button come first: after the skip link, before the header.
    await page.locator("body").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(banner(page).getByRole("button", { name: "Leave practice mode" })).toBeFocused();

    const press = async (name: string | RegExp, role: "button" | "link" = "button") => {
      const target = page.getByRole(role, { name });
      await target.focus();
      await page.keyboard.press("Enter");
    };
    await press("Use the example list");
    await press("Continue");
    await expect(page.getByRole("heading", { level: 1, name: "Check the payouts" })).toBeVisible();
    await press("Looks right, continue", "link");
    await expect(page.getByRole("heading", { level: 1, name: "Fund and send" })).toBeVisible();
    await press("Record mock deposit");
    await expect(page.getByText("Funded.", { exact: true })).toBeVisible();

    // The sheet opens on its safe answer, and Escape closes it without sending anything.
    await press("Send 8 payouts");
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("heading", { level: 2, name: "Sending the payouts" })).toHaveCount(0);
    await press("Send 8 payouts");
    await sheet.getByRole("button", { name: "Send 8 payouts" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 2, name: "All 1 batch is confirmed" })).toBeVisible({ timeout: 20_000 });
    await press("Open public receipt", "link");
    await expect(page.getByRole("heading", { level: 1, name: "Payout receipt" })).toBeVisible();
    await expect(page.getByText("A practice receipt")).toBeVisible();
  });

  test("starts over when the page is reloaded, and is still practice mode", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Try a practice payout" }).click();
    await page.getByRole("button", { name: "Use the example list" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Check the payouts" })).toBeVisible();

    await page.reload();
    // The tab is still in practice mode ...
    await expect(banner(page)).toBeVisible();
    // ... and what it held is gone: the list, the campaign, everything.
    await expect(page.getByRole("heading", { level: 1, name: "Add the payouts first" })).toBeVisible();
    await chooseFromIsland(page, "Payouts");
    await expect(page.getByTestId("payouts-empty")).toBeVisible();
    await expect(page.getByRole("button", { name: "Use the example list" })).toBeVisible();
    expect(await axeViolations(page), "the empty payouts list").toEqual([]);
  });

  test("leaving puts the app back as it was, and leaves nothing in the tab", async ({ page }) => {
    const requests = watchRequests(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Try it yourself in practice mode" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Add the payouts" })).toBeVisible();
    expect((await kept(page)).session).toEqual([FLAG]);

    await banner(page).getByRole("button", { name: "Leave practice mode" }).click();
    await expect(page.getByRole("heading", { level: 1, name: /Pay many people/u })).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    expect(await kept(page)).toEqual({ local: [], session: [], cookie: "" });
    // The header names a network again, as it did.
    await expect(island(page).getByText("Practice", { exact: true })).toHaveCount(0);
    await expect(island(page).getByText("testnet", { exact: true })).toBeVisible();

    // Reloading does not bring it back.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: /Pay many people/u })).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    expect(notStatic(requests())).toEqual([]);
  });

  test("answers what it cannot read honestly: a payslip is not checked, and a receipt that is not its own is not shown", async ({ page }) => {
    // A tab that was in practice mode: the app carries on in it, whichever page is opened.
    await page.addInitScript((flag) => {
      sessionStorage.setItem(flag, "1");
    }, FLAG);
    const requests = watchRequests(page);

    // The payslip page checks with a verifier, which practice mode has not got.
    await page.goto("/payslip");
    await expect(banner(page)).toBeVisible();
    await page.getByRole("button", { name: "Load a sample" }).click();
    await page.getByRole("button", { name: "Check payslip" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Practice mode does not check payslips" })).toBeVisible();
    expect(await axeViolations(page), "the payslip page in practice mode").toEqual([]);

    // A receipt link from somewhere else, with transactions practice mode never made.
    await page.goto(`/r/someone-else?network=testnet&tx=${"ab".repeat(32)}&commitment=${"cd".repeat(32)}&declared_total=1000`);
    await expect(page.getByRole("heading", { level: 2, name: "Practice mode does not read the chain" })).toBeVisible();
    expect(await axeViolations(page), "a receipt that practice mode did not make").toEqual([]);

    // None of it reached any server: what was asked for is the pages themselves and the app's own files.
    expect(reachedAServer(requests())).toEqual([]);
  });
});
