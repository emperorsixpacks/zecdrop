import { expect, test } from "@playwright/test";

import { chooseFromIsland, watchProblems, watchRequests } from "./helpers.js";

// The default sample receipt is a REAL 8-output batch from the full operator path
// on public testnet, bundled with the page; ?demo=real-smoke is the first, smaller
// real batch. Each must say what it is, link to its real transaction, read as ONE
// batch with several shielded outputs, and call the coins what they are.

const SAMPLES = [
  {
    name: "the 8-output batch",
    path: "/r/demo?demo=real",
    txid: "6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955",
    line: "Real batch on public testnet, captured at height 4,533,356",
    details: ["Mined on public testnet at height 4,478,289", "captured at height 4,533,356"],
    verdict: "Settled: 8 payouts, 0.005 TAZ, fee 0.00045 TAZ",
    outputs: "8",
  },
  {
    name: "the first, smaller batch",
    path: "/r/demo?demo=real-smoke",
    txid: "50fb88e02e7f4b0f3b3b658f50b09b12ea973d8c3697f8bad4c59e41075ea3e3",
    line: "The first real batch on public testnet, captured at height 4,533,356",
    details: ["Mined on public testnet at height 4,478,065", "captured at height 4,533,356"],
    verdict: "Settled: 3 payouts, 0.0006 TAZ, fee 0.0002 TAZ",
    outputs: "3",
  },
] as const;

for (const sample of SAMPLES) {
  test(`${sample.name}: says what it is, links the real transaction, reads as one batch`, async ({ page }) => {
    const problems = watchProblems(page);
    const requests = watchRequests(page);
    await page.goto(sample.path);
    await expect(page.getByRole("heading", { level: 2, name: "Status" })).toBeAttached();

    // It says what it is, in one line, and the rest of the provenance is one click away.
    await expect(page.getByText(sample.line)).toBeVisible();
    await page.getByRole("button", { name: "Details" }).click();
    for (const text of sample.details) await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
    await expect(page.getByText("confirmations are shown as of the capture, not live", { exact: false })).toBeVisible();

    // The verdict comes first, in TAZ (never ZEC), and the page says the coins are worth nothing.
    await expect(page.getByTestId("verdict")).toHaveText(sample.verdict);
    await expect(page.getByText("Amounts are in TAZ, the testnet coin. It has no value.")).toBeVisible();
    expect(await page.locator("main").innerText()).not.toMatch(/\d ZEC\b/u);

    // The explorer link is to the real transaction on the default testnet explorer.
    await page.getByRole("button", { name: "Transaction", exact: true }).click();
    const explorer = page.locator(`a[href="https://testnet.zecblock.com/tx/${sample.txid}"]`).first();
    await expect(explorer).toBeVisible();
    await expect(explorer).toHaveAttribute("target", "_blank");
    await expect(explorer).toHaveAttribute("rel", /noopener/u);

    // One batch, several shielded outputs: one row in the table or one card, and the verdict names no batches.
    expect(await page.getByTestId("verdict").innerText()).not.toMatch(/batch/u);
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

test("the header's sample receipt is the 8-output batch", async ({ page }) => {
  await page.goto("/");
  await chooseFromIsland(page, "Sample receipt");
  await expect(page).toHaveURL(/\/r\/demo\?demo=real$/u);
  await expect(page.getByText("Real batch on public testnet, captured at height 4,533,356")).toBeVisible();
});

test("the home page says what was demonstrated and links to its receipt", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 2, name: "It ran on public testnet" })).toBeVisible();
  await expect(page.getByTestId("run-receipt").getByText("No mainnet payout yet.")).toBeVisible();
  await page.getByRole("link", { name: "See a real receipt" }).click();
  await expect(page).toHaveURL(/\/r\/demo\?demo=real$/u);
});

test("the sample switcher goes between the five samples", async ({ page }) => {
  await page.goto("/r/demo?demo=real");
  await page.getByLabel("Sample").selectOption({ label: "With findings" });
  await expect(page).toHaveURL(/\/r\/demo\?demo=findings$/u);
  await expect(page.getByRole("heading", { level: 2, name: "What the verifier found" })).toBeVisible();
  await page.getByLabel("Sample").selectOption({ label: "Real batch" });
  await expect(page).toHaveURL(/\/r\/demo\?demo=real$/u);
});

// The funding address, on the pages that show it, at phone and desktop width.
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
      await page.getByRole("button", { name: "Funding address" }).click();
      const card = page.getByTestId("funding-section");
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
      await page.getByRole("button", { name: "Funding address" }).click();
      const card = page.getByTestId("funding-section");
      await expect(card.getByText("Unknown")).toBeVisible();
      await expect(card).toContainText("could not establish one address that every batch spends from");
      await expect(card.getByRole("button")).toHaveCount(0);
      await expect(card.getByRole("link")).toHaveCount(0);
    });

    test("the real testnet sample shows the real funding address, with a link to its explorer page", async ({ page, context }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto("/r/demo?demo=real");
      await page.getByRole("button", { name: "Funding address" }).click();
      const card = page.getByTestId("funding-section");
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
