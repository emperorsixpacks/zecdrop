import { expect, test } from "@playwright/test";

import { watchProblems, watchRequests } from "./helpers.js";

// The default sample receipt is a REAL 8-output batch from the full operator path
// on public testnet, bundled with the page; ?demo=real-smoke is the first, smaller
// real batch. Each must say what it is, link to its real transaction, read as ONE
// batch with several shielded outputs, and call the coins what they are.

const SAMPLES = [
  {
    name: "the 8-output batch",
    path: "/r/demo?demo=real",
    txid: "6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955",
    title: "Sample receipt: a real batch",
    banner: ["Mined on public testnet at height 4,478,289", "captured at height 4,478,307"],
    amounts: ["0.005 TAZ", "0.00045 TAZ"],
    outputs: "8",
  },
  {
    name: "the first, smaller batch",
    path: "/r/demo?demo=real-smoke",
    txid: "50fb88e02e7f4b0f3b3b658f50b09b12ea973d8c3697f8bad4c59e41075ea3e3",
    title: "Sample receipt: the first real batch",
    banner: ["Mined on public testnet at height 4,478,065", "captured at height 4,478,201"],
    amounts: ["0.0006 TAZ", "0.0002 TAZ"],
    outputs: "3",
  },
] as const;

for (const sample of SAMPLES) {
  test(`${sample.name}: says what it is, links the real transaction, reads as one batch`, async ({ page }) => {
    const problems = watchProblems(page);
    const requests = watchRequests(page);
    await page.goto(sample.path);
    await expect(page.getByRole("heading", { level: 2, name: "Status" })).toBeVisible();

    // It says what it is.
    const banner = page.getByRole("status").filter({ hasText: sample.title });
    for (const text of sample.banner) await expect(banner).toContainText(text);
    await expect(banner).toContainText("confirmations are shown as of the capture, not live");

    // The explorer link is to the real transaction on the default testnet explorer.
    const explorer = page.locator(`a[href="https://testnet.zecblock.com/tx/${sample.txid}"]`).first();
    await expect(explorer).toBeVisible();
    await expect(explorer).toHaveAttribute("target", "_blank");
    await expect(explorer).toHaveAttribute("rel", /noopener/u);

    // Testnet coins are TAZ, never ZEC, and the page says they are worth nothing.
    for (const amount of sample.amounts) await expect(page.getByText(amount).first()).toBeVisible();
    await expect(page.getByText("Amounts are in TAZ, the testnet coin. It has no value.")).toBeVisible();
    expect(await page.locator("main").innerText()).not.toMatch(/\d ZEC\b/u);

    // One batch, several shielded outputs: "Batches 1", one row in the table or one card.
    const summary = page.locator("dt", { hasText: /^Batches$/u }).locator("xpath=ancestor::div[1]");
    await expect(summary).toContainText("1");
    await expect(summary).toContainText("One Zcash transaction each.");
    const table = page.getByRole("table", { name: "Payout batches" });
    if (await table.isVisible()) {
      await expect(table.getByRole("row")).toHaveCount(2); // header + the one batch
      await expect(table.getByRole("row").nth(1)).toContainText(sample.outputs);
    } else {
      const cards = page.getByRole("list", { name: "Payout batches" }).getByRole("listitem");
      await expect(cards).toHaveCount(1);
      await expect(cards.first()).toContainText(`Shielded outputs${sample.outputs}`.replace(/\s+/gu, ""));
    }

    // Nothing was asked of any server but the page's own; the explorer is a link, not a request.
    const origin = new URL(page.url()).origin;
    expect(requests().filter((u) => !u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:"))).toEqual([]);
    expect(problems()).toEqual([]);
  });
}

test("the top bar's sample receipt is the 8-output batch", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Sample receipt" }).click();
  await expect(page).toHaveURL(/\/r\/demo\?demo=real$/u);
  await expect(page.getByRole("status").filter({ hasText: "Sample receipt: a real batch" })).toBeVisible();
});

test("the home page says what was demonstrated and links to its receipt", async ({ page }) => {
  await page.goto("/");
  const section = page.getByRole("heading", { level: 2, name: "It has run on public testnet" }).locator("xpath=ancestor::section[1]");
  await expect(section).toContainText("A real 8-recipient batch ran on public testnet");
  await expect(section).toContainText("this has not been tried on mainnet");
  await section.getByRole("link", { name: "See the receipt of that batch" }).click();
  await expect(page).toHaveURL(/\/r\/demo\?demo=real$/u);
});

// The funding address row, on the pages that show it, at phone and desktop width.
for (const viewport of [
  { name: "phone 360px", width: 360, height: 740 },
  { name: "desktop 1280px", width: 1280, height: 800 },
]) {
  test.describe(`funding address, ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("a known address is short, copyable, within the screen, and comes with the comparing sentence", async ({
      page,
      context,
    }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto("/r/demo?demo=1");
      const card = page.getByRole("heading", { level: 2, name: "Funding address" }).locator("xpath=ancestor::div[@data-slot='card'][1]");
      await expect(card).toBeVisible();

      const shown = card.getByTestId("funding-address");
      await expect(shown).toHaveText("tFAKEfun…ress0000");
      await expect(card).toContainText(
        "Every batch on this receipt spends from this address; compare it with the address the campaign published.",
      );

      // Nothing in the card is wider than the screen.
      const box = await card.boundingBox();
      expect(box?.width ?? 0).toBeLessThanOrEqual(viewport.width);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);

      // Copy puts the FULL address on the clipboard, not the short form.
      await card.getByRole("button", { name: "Copy funding address" }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("tFAKEfundingAddressNotARealAddress0000");
    });

    test("an address the verifier could not establish says Unknown, not nothing", async ({ page }) => {
      await page.goto("/r/demo?demo=findings");
      const card = page.getByRole("heading", { level: 2, name: "Funding address" }).locator("xpath=ancestor::div[@data-slot='card'][1]");
      await expect(card.getByText("Unknown")).toBeVisible();
      await expect(card).toContainText("could not establish one address that every batch spends from");
      await expect(card.getByRole("button")).toHaveCount(0);
      await expect(card.getByRole("link")).toHaveCount(0);
    });

    test("the real testnet sample shows the real funding address, with a link to its explorer page", async ({ page, context }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto("/r/demo?demo=real");
      const card = page.getByRole("heading", { level: 2, name: "Funding address" }).locator("xpath=ancestor::div[@data-slot='card'][1]");
      await expect(card).toBeVisible();
      await expect(card.getByTestId("funding-address")).toHaveText("tmU6c1aX…B3nkZGkD");
      await expect(card.getByRole("link", { name: /Explorer/u })).toHaveAttribute(
        "href",
        "https://testnet.zecblock.com/address/tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD",
      );
      await card.getByRole("button", { name: "Copy funding address" }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD");
    });
  });
}
