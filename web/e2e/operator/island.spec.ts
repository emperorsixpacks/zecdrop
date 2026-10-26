import { expect, test, type Page } from "@playwright/test";

import { axeViolations, island, openIsland, overflowReport, THEMES, useTheme } from "../helpers.js";
import { operatorUrl, seeded } from "./env.js";

// The header capsule on the operator's own pages, against the real operator on the mock chain: what it says of the chain
// without being opened, the one button that is always one press away, and the dialog that goes over it. The capsule as such
// (tab order, accessibility tree, motion, forced colours) is in e2e/island.spec.ts.

const PRACTICE_LINE = "Practice mode: nothing is sent to Zcash";
const UNKNOWN_LINE = "Chain mode unknown: practice controls hidden";

/** Have the operator answer /api/health as another chain would: one it cannot name (a health answer without the `mock` flag, so
 * `{ mock: undefined }`), or the real mainnet one. The rest of what it says is the real answer. */
async function chain(page: Page, change: Record<string, unknown>): Promise<void> {
  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, ...change } });
  });
}

async function load(page: Page, path: string, heading: string): Promise<void> {
  await page.goto(operatorUrl(path, { token: true }));
  await page.getByRole("heading", { level: 1, name: heading }).waitFor();
  await island(page).waitFor();
}

const capsuleBox = async (page: Page) => {
  const box = await page.locator(".island").boundingBox();
  if (box === null) throw new Error("the capsule is not drawn");
  return box;
};

test.describe("the chain, said with nothing opened", () => {
  for (const width of [360, 1280]) {
    test(`${String(width)}px: the capsule names the network, and a line directly under it says the chain is a practice one`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await load(page, "/campaigns", "Payouts");
      await expect(island(page)).toHaveAccessibleName("ZecDrop Payouts testnet");
      await expect(island(page)).toHaveAttribute("aria-expanded", "false");

      const line = page.getByRole("status").filter({ hasText: PRACTICE_LINE });
      await expect(line).toBeVisible();
      const capsule = await capsuleBox(page);
      const under = await line.boundingBox();
      if (under === null) throw new Error("the line is not drawn");
      expect(under.y, "under the capsule").toBeGreaterThanOrEqual(capsule.y + capsule.height);
      expect(under.y - (capsule.y + capsule.height), "directly under it").toBeLessThanOrEqual(16);
      expect(Math.abs(under.x + under.width / 2 - width / 2), "centred under it").toBeLessThanOrEqual(2);
      // The first heading is below both.
      const h1 = await page.getByRole("heading", { level: 1 }).first().boundingBox();
      expect(h1?.y ?? 0).toBeGreaterThanOrEqual(under.y + under.height);
    });
  }

  test("a chain the operator cannot name is said in the same line, and the practice line is not", async ({ page }) => {
    await chain(page, { mock: undefined });
    await load(page, "/campaigns", "Payouts");
    await expect(page.getByRole("status").filter({ hasText: UNKNOWN_LINE })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: PRACTICE_LINE })).toHaveCount(0);
    // And it is not in the panel, which is closed: it is on the page.
    await expect(island(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("a real mainnet operator: a highlighter-yellow chip on the capsule, no practice line, the network in full in the panel", async ({ page }) => {
    await chain(page, { mock: false, network: "mainnet" });
    await load(page, "/campaigns", "Payouts");
    await expect(island(page)).toHaveAccessibleName("ZecDrop Payouts Mainnet");
    const chip = island(page).locator('[data-network="mainnet"]');
    await expect(chip).toBeVisible();
    expect(await chip.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 214, 10)");
    await expect(page.getByRole("status")).toHaveCount(0);
    await openIsland(page);
    await expect(page.getByText("Zcash mainnet", { exact: true })).toBeVisible();
  });
});

test.describe("starting a payout stays one press away", () => {
  test("it is on the capsule while the capsule is closed: a round button on a phone, with its name, and a pill with its words on a desktop", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await load(page, "/audit", "Audit");
    const link = page.getByRole("link", { name: "New payout", exact: true });
    await expect(island(page)).toHaveAttribute("aria-expanded", "false");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/new");
    const round = await link.boundingBox();
    expect(round?.width, "round").toBe(round?.height);
    expect(round?.height).toBeGreaterThanOrEqual(36);
    // Inside the capsule, at its end.
    const capsule = await capsuleBox(page);
    expect((round?.x ?? 0) + (round?.width ?? 0)).toBeLessThanOrEqual(capsule.x + capsule.width);
    expect(round?.x ?? 0).toBeGreaterThan(capsule.x + capsule.width / 2);

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(link).toBeVisible();
    expect((await link.boundingBox())?.width, "with its words").toBeGreaterThan(90);
    await expect(link).toHaveText("New payout");
  });

  test("a press starts one, with the capsule closed; and while paying it is not offered", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await load(page, "/campaigns", "Payouts");
    await page.getByRole("link", { name: "New payout", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Add the payouts" })).toBeVisible();
    await expect(island(page)).toHaveAccessibleName("ZecDrop New payout testnet");
    await expect(page.getByRole("link", { name: "New payout", exact: true })).toHaveCount(0);
    await expect(island(page)).toHaveAttribute("aria-expanded", "false");
  });

  for (const theme of THEMES) {
    test(`${theme}: it is the highlighted button on the payouts page, where starting one is the point, and a quiet outline elsewhere`, async ({ page }) => {
      await useTheme(page, theme);
      await load(page, "/campaigns", "Payouts");
      const link = page.getByRole("link", { name: "New payout", exact: true });
      const fill = () => link.evaluate((el) => getComputedStyle(el).backgroundColor);
      // The ink of the capsule: light on the black bar, dark on the light one.
      expect(await fill()).toBe(theme === "light" ? "rgb(242, 242, 238)" : "rgb(20, 20, 20)");
      await page.goto(operatorUrl("/audit", { token: true }));
      await page.getByRole("heading", { level: 1, name: "Audit" }).waitFor();
      expect(await fill()).toBe("rgba(0, 0, 0, 0)");
    });
  }

  test("it is the capsule's next stop in the tab order, and the capsule's links are not", async ({ page }) => {
    await load(page, "/campaigns", "Payouts");
    await page.locator("body").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(island(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "New payout", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".island-header")))).toBe(false);
  });
});

test.describe("the operator's links", () => {
  test("Payouts and Audit are in the panel, the page you are on marked, and the capsule follows the choice", async ({ page }) => {
    await load(page, "/campaigns", "Payouts");
    const nav = await openIsland(page);
    await expect(nav.getByRole("link")).toHaveText(["Payouts", "Audit"]);
    await expect(nav.getByRole("link", { name: "Payouts" })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "Audit" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Audit" })).toBeVisible();
    await expect(island(page)).toHaveAccessibleName("ZecDrop Audit testnet");
    await expect(island(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("a campaign is a Payout, and the panel names no page as the current one there", async ({ page }) => {
    await load(page, `/campaign/${seeded().settled}`, "Seed: settled");
    await expect(island(page)).toHaveAccessibleName("ZecDrop Payout testnet");
    const nav = await openIsland(page);
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(0);
  });
});

test.describe("where it sits, on the operator's pages", () => {
  for (const width of [360, 390, 768, 1280]) {
    test(`at ${String(width)}px the capsule and the line under it are clear of the first heading at load`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const { settled } = seeded();
      for (const [path, heading] of [
        ["/campaigns", "Payouts"],
        ["/audit", "Audit"],
        ["/new", "Add the payouts"],
        [`/campaign/${settled}`, "Seed: settled"],
      ] as const) {
        await page.goto("about:blank");
        await load(page, path, heading);
        const capsule = await capsuleBox(page);
        const h1 = await page.getByRole("heading", { level: 1 }).first().boundingBox();
        expect(capsule.height, `${path}: 44px`).toBe(44);
        expect(capsule.x, `${path}: inside the screen`).toBeGreaterThanOrEqual(11.5);
        expect(capsule.x + capsule.width, `${path}: inside the screen`).toBeLessThanOrEqual(width - 11.5);
        expect(h1?.y ?? 0, `${path}: the first heading is clear of the capsule`).toBeGreaterThanOrEqual(capsule.y + capsule.height + 8);
        const line = await page.getByRole("status").filter({ hasText: PRACTICE_LINE }).boundingBox();
        if (line !== null) expect(h1?.y ?? 0, `${path}: and of the line`).toBeGreaterThanOrEqual(line.y + line.height);
        const overflow = await overflowReport(page);
        expect(overflow.page, `${path}: horizontal scroll`).toBeLessThanOrEqual(0);
      }
    });
  }
});

test.describe("what is over what", () => {
  test("the sheet that asks before sending is above the capsule, and the capsule cannot be reached under it", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(operatorUrl(`/campaign/${seeded().funded}`, { token: true }));
    await page.getByRole("button", { name: /^Send \d+ payouts?$/u }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const over = await page.evaluate(() => {
      const box = document.querySelector(".island")?.getBoundingClientRect();
      if (!box) return "no capsule";
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return top?.closest(".island") ? "the capsule" : top?.closest("dialog") ? "the sheet" : (top?.tagName ?? "nothing");
    });
    // Over it: the sheet's own backdrop (a <dialog> is in the top layer), not the capsule.
    expect(over).not.toBe("the capsule");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await island(page).click();
    await expect(island(page)).toHaveAttribute("aria-expanded", "true");
  });
});

test.describe("accessibility, closed and open, both themes, phone and desktop", () => {
  for (const theme of THEMES) {
    for (const width of [360, 1280]) {
      test(`${theme}, ${String(width)}px: the operator's capsule, with its line and its button`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await useTheme(page, theme);
        await load(page, "/campaigns", "Payouts");
        await page.getByRole("list", { name: "Payouts" }).waitFor();
        expect(await axeViolations(page), "closed").toEqual([]);
        await openIsland(page);
        expect(await axeViolations(page), "open").toEqual([]);
        const overflow = await overflowReport(page);
        expect(overflow.wide, "open: elements wider than the viewport").toEqual([]);
        expect(overflow.page, "open: horizontal scroll").toBeLessThanOrEqual(0);
      });
    }
  }

  test("an operator that cannot name its chain, closed and open", async ({ page }) => {
    await chain(page, { mock: undefined });
    await load(page, "/campaigns", "Payouts");
    await expect(page.getByRole("status").filter({ hasText: UNKNOWN_LINE })).toBeVisible();
    expect(await axeViolations(page), "closed").toEqual([]);
    await openIsland(page);
    expect(await axeViolations(page), "open").toEqual([]);
  });
});
