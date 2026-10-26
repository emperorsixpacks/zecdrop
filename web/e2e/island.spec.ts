import { expect, test, type Page } from "@playwright/test";

import { axeViolations, island, islandPanel, openIsland, overflowReport, THEMES, useTheme, watchProblems } from "./helpers.js";

// The header is one capsule at the top centre (web/DESIGN.md, "Header: one capsule"): a button that opens into a panel with the links and
// the settings. jsdom cannot say what a browser does with `inert`, with a sticky box, with a transition or with forced colours,
// so this is where those are checked, in the browser a visitor has. The operator's own side of it (the status line, the one
// button, a dialog over it) is in e2e/operator/island.spec.ts.

/** What the focus is on, in the words a screen reader would use, roughly. */
async function focused(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const element = document.activeElement;
    if (element === null || element === document.body) return "(nothing)";
    return (element.getAttribute("aria-label") ?? element.textContent ?? element.tagName).trim().replace(/\s+/gu, " ").slice(0, 60);
  });
}

/** How many nodes of this role and name the browser's own accessibility tree has, not counting the ones it ignores. This is
 * what a screen reader is given, not what a test library guesses: `inert` and `visibility` both take a node out of it. (A
 * count, because the page has links of its own with the same names: the footer's "How privacy works".) */
async function inAccessibilityTree(page: Page, role: string, name: string): Promise<number> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Accessibility.enable");
    const { nodes } = await client.send("Accessibility.getFullAXTree");
    return nodes.filter((node) => node.ignored !== true && node.role?.value === role && node.name?.value === name).length;
  } finally {
    await client.detach();
  }
}

const LINKS = ["Home", "Sample receipt", "Get paid", "Check a payslip", "How privacy works"];

/** A receipt link for mainnet: the header names the network the link names, whatever the page was built for. The link is not
 * asked of anyone here (the public copy has no verifier to ask); the header says mainnet from the link alone. */
const MAINNET_RECEIPT = `/r/camp-01?network=mainnet&tx=${"a".repeat(64)}&commitment=${"e".repeat(64)}&declared_total=534500000`;

/** Whether the focus is somewhere in the header capsule. */
const focusInIsland = (page: Page): Promise<boolean> => page.evaluate(() => Boolean(document.activeElement?.closest(".island-header")));

test.describe("the tab order", () => {
  test("is the skip link, the capsule, then the page; the capsule's links only once it is open, then its settings", async ({ page }) => {
    await page.goto("/privacy");
    await page.getByRole("heading", { level: 1, name: "How privacy works" }).waitFor();

    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("Skip to content");
    await page.keyboard.press("Tab");
    await expect(island(page)).toBeFocused();

    // Closed: the next stop is in the page. None of the capsule's links is in the way.
    await page.keyboard.press("Tab");
    expect(await focusInIsland(page), "a link of the closed capsule took the focus").toBe(false);
    await page.keyboard.press("Shift+Tab");
    await expect(island(page)).toBeFocused();

    // Open it from the keyboard: Tab goes through the links in order, then the theme, then the appearance panel.
    await page.keyboard.press("Enter");
    await expect(island(page)).toHaveAttribute("aria-expanded", "true");
    for (const label of LINKS) {
      await page.keyboard.press("Tab");
      expect(await focused(page)).toBe(label);
    }
    await page.keyboard.press("Tab");
    expect(await focused(page)).toMatch(/^Switch to (dark|light) theme$/u);
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("Appearance");
    await expect(island(page)).toHaveAttribute("aria-expanded", "true");

    // The focus leaving the capsule closes it.
    await page.keyboard.press("Tab");
    await expect(island(page)).toHaveAttribute("aria-expanded", "false");
    expect(await focusInIsland(page)).toBe(false);
  });

  test("Escape closes the capsule and puts the focus back on it", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await island(page).focus();
    await page.keyboard.press("Space");
    await expect(island(page)).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("Sample receipt");
    await page.keyboard.press("Escape");
    await expect(island(page)).toHaveAttribute("aria-expanded", "false");
    await expect(island(page)).toBeFocused();
  });

  test("the keyboard ring is drawn around the whole capsule", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(island(page)).toBeFocused();
    const ring = await page.locator(".island").evaluate((el) => {
      const style = getComputedStyle(el);
      return { outline: style.outlineStyle, width: parseFloat(style.outlineWidth), halo: style.boxShadow };
    });
    expect(ring.outline).toBe("solid");
    expect(ring.width).toBeGreaterThanOrEqual(2);
    expect(ring.halo).not.toBe("none");
  });
});

test.describe("what a screen reader is given", () => {
  test("a closed capsule has no links in the accessibility tree, and an open one has all five", async ({ page }) => {
    await page.goto("/privacy");
    await page.getByRole("heading", { level: 1, name: "How privacy works" }).waitFor();

    // The button, named as what it shows, and the panel it opens, set apart.
    await expect(island(page)).toHaveAccessibleName("ZecDrop How privacy works testnet");
    await expect(island(page)).toHaveAttribute("aria-expanded", "false");
    const panelId = await island(page).getAttribute("aria-controls");
    expect(panelId).not.toBeNull();
    await expect(islandPanel(page)).toHaveAttribute("id", panelId ?? "");
    await expect(islandPanel(page)).toHaveAttribute("inert", "");

    expect(await inAccessibilityTree(page, "button", "ZecDrop How privacy works testnet")).toBe(1);
    expect(await inAccessibilityTree(page, "navigation", "Primary")).toBe(0);
    const closed: Record<string, number> = {};
    for (const label of LINKS) closed[label] = await inAccessibilityTree(page, "link", label);
    // Nor can they be reached by the query a test (or a voice control) uses.
    await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
    await expect(islandPanel(page).locator("a:visible")).toHaveCount(0);
    await expect(islandPanel(page).locator("a")).toHaveCount(5);

    const nav = await openIsland(page);
    expect(await inAccessibilityTree(page, "navigation", "Primary")).toBe(1);
    // Each of the five is in the tree once more than it was: the capsule's own, beside the page's (the footer has one too).
    for (const label of LINKS) expect(await inAccessibilityTree(page, "link", label), `${label}, open`).toBe((closed[label] ?? 0) + 1);
    await expect(islandPanel(page)).not.toHaveAttribute("inert");
    // The page you are on is the current one, in the tree as much as on the screen.
    await expect(nav.getByRole("link", { name: "How privacy works" })).toHaveAttribute("aria-current", "page");

    // Closed again, they go out of it again.
    await page.keyboard.press("Escape");
    for (const label of LINKS) expect(await inAccessibilityTree(page, "link", label), `${label}, closed again`).toBe(closed[label]);
  });

  test("the capsule's name holds what it shows, at the width where the word ZecDrop gives way too", async ({ page }) => {
    for (const [width, wordShown] of [
      [360, false],
      [390, true],
      [1280, true],
    ] as const) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/get-paid");
      await page.getByRole("heading", { level: 1 }).waitFor();
      // The name keeps the word (it is read out) whether or not it is drawn: the visible text is part of the name.
      await expect(island(page), `${String(width)}px`).toHaveAccessibleName("ZecDrop Get paid testnet");
      const word = island(page).getByText("ZecDrop", { exact: true });
      const box = await word.boundingBox();
      expect(box !== null && box.width > 8, `the word is drawn at ${String(width)}px`).toBe(wordShown);
      await expect(island(page).getByText("Get paid", { exact: true })).toBeVisible();
      await expect(island(page).getByText("testnet", { exact: true })).toBeVisible();
    }
  });
});

test.describe("accessibility, both states, both themes, at phone and desktop width", () => {
  for (const theme of THEMES) {
    for (const width of [360, 1280]) {
      test(`${theme}, ${String(width)}px: closed and open have no violation and no sideways scroll`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await useTheme(page, theme);
        const problems = watchProblems(page);
        await page.goto("/privacy");
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await page.getByRole("heading", { level: 1, name: "How privacy works" }).waitFor();

        expect(await axeViolations(page), "closed").toEqual([]);
        await openIsland(page);
        expect(await axeViolations(page), "open").toEqual([]);
        const overflow = await overflowReport(page);
        expect(overflow.wide, "open: elements wider than the viewport").toEqual([]);
        expect(overflow.page, "open: horizontal scroll").toBeLessThanOrEqual(0);
        await page.getByRole("button", { name: "Appearance" }).click();
        await page.getByRole("dialog").waitFor();
        expect(await axeViolations(page), "the appearance panel over it").toEqual([]);
        expect(problems()).toEqual([]);
      });
    }
  }

  for (const theme of THEMES) {
    test(`${theme}: the mainnet chip and the practice chip pass too`, async ({ page }) => {
      await useTheme(page, theme);
      await page.goto(MAINNET_RECEIPT);
      await island(page).waitFor();
      // The capsule alone: the receipt behind it has no verifier to ask on this copy, and is not what is checked here.
      expect(await axeViolations(page, ".island-header"), "mainnet, closed").toEqual([]);
      await openIsland(page);
      expect(await axeViolations(page, ".island-header"), "mainnet, open").toEqual([]);
      await page.goto("/");
      await page.getByRole("button", { name: "Try it yourself in practice mode" }).click();
      await page.getByRole("heading", { level: 1, name: "Add the payouts" }).waitFor();
      expect(await axeViolations(page, ".island-header"), "practice, closed").toEqual([]);
      await openIsland(page);
      expect(await axeViolations(page, ".island-header"), "practice, open").toEqual([]);
    });
  }
});

test.describe("closing it", () => {
  test("a press anywhere else on the page closes it, and a press inside it does not", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/privacy");
    await page.getByRole("heading", { level: 1, name: "How privacy works" }).waitFor();
    await openIsland(page);
    // Inside: on its label, then on the theme button.
    await page.getByText("Zcash testnet", { exact: true }).click();
    await expect(island(page)).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("button", { name: /^Switch to (dark|light) theme$/u }).click();
    await expect(island(page)).toHaveAttribute("aria-expanded", "true");
    // Outside: on the page's own text.
    await page.getByRole("heading", { level: 1, name: "How privacy works" }).click();
    await expect(island(page)).toHaveAttribute("aria-expanded", "false");
    await expect(islandPanel(page)).toHaveAttribute("inert", "");
  });

  test("a press on words that take no focus, outside the page's content, closes it: the press itself says so", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/privacy");
    await page.getByRole("heading", { level: 1, name: "How privacy works" }).waitFor();
    await openIsland(page);
    // The footer is outside <main> (which takes the focus when anything in it is pressed, and so closes the capsule by that road
    // too), and its words are no control: the focus goes nowhere, so only the press can close the capsule. That is also how it
    // is in Safari, where a press moves the focus nowhere at all.
    await page.getByText("Private amounts, public accountability.").click();
    await expect(island(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("a route change closes it: choosing a link, and the back button, which presses nothing", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();

    const nav = await openIsland(page);
    await nav.getByRole("link", { name: "Get paid", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Get paid in ZEC" })).toBeVisible();
    await expect(island(page)).toHaveAttribute("aria-expanded", "false");
    await expect(island(page)).toHaveAccessibleName("ZecDrop Get paid testnet");
    // The focus waits on the capsule: the next Tab goes on into the page, as it would after the old header's link.
    await expect(island(page)).toBeFocused();

    await openIsland(page);
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: /Pay many people/u })).toBeVisible();
    await expect(island(page)).toHaveAttribute("aria-expanded", "false");
    await expect(island(page)).toHaveAccessibleName("ZecDrop Home testnet");
  });

  test("the appearance panel keeps its own Escape: the first closes it, the second closes the capsule", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await openIsland(page);
    await page.getByRole("button", { name: "Appearance" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // Using the panel (it is drawn outside the capsule) does not close the capsule.
    await page.getByRole("radio", { name: "Calm" }).click();
    await expect(island(page)).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(island(page)).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(island(page)).toHaveAttribute("aria-expanded", "false");
  });
});

test.describe("hovering", () => {
  test("gives the capsule a state and does not open it: a phone has no hover, so nothing may depend on one", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const widthBefore = (await page.locator(".island").boundingBox())?.width;
    const tint = () => island(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await tint()).toBe("rgba(0, 0, 0, 0)");
    await island(page).hover();
    await expect.poll(tint, "the hover tint").not.toBe("rgba(0, 0, 0, 0)");
    // Longer than the morph takes: if hovering opened it, it would have by now.
    await page.waitForTimeout(600);
    await expect(island(page)).toHaveAttribute("aria-expanded", "false");
    expect((await page.locator(".island").boundingBox())?.width).toBe(widthBefore);
    await expect(islandPanel(page)).toHaveAttribute("inert", "");
  });
});

test.describe("the network on the capsule, with nothing opened", () => {
  // At the phone's width too: that is where the capsule is tightest, and where a chip would be the first thing to go.
  for (const width of [360, 1280]) {
    test.describe(`${String(width)}px`, () => {
      test.use({ viewport: { width, height: 800 } });

      test("testnet is quiet text", async ({ page }) => {
        await page.goto("/");
        const chip = island(page).locator('[data-network="testnet"]');
        await expect(chip).toBeVisible();
        await expect(chip).toHaveText("testnet");
        // Quiet: no fill of its own.
        expect(await chip.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
      });

      test("mainnet is a highlighter-yellow chip, from a receipt link for mainnet, on a page built for testnet", async ({ page }) => {
        await page.goto(MAINNET_RECEIPT);
        const chip = island(page).locator('[data-network="mainnet"]');
        await expect(chip).toBeVisible();
        await expect(chip).toHaveText("Mainnet");
        await expect(island(page)).toHaveAccessibleName("ZecDrop Receipt Mainnet");
        expect(await chip.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 214, 10)");
        await expect(island(page).getByText("testnet")).toHaveCount(0);
        // And once opened, in full.
        await openIsland(page);
        await expect(page.getByText("Zcash mainnet", { exact: true })).toBeVisible();
      });

      test("practice is a hatched chip, and names no network", async ({ page }) => {
        await page.goto("/");
        await page.getByRole("button", { name: "Try it yourself in practice mode" }).click();
        await page.getByRole("heading", { level: 1, name: "Add the payouts" }).waitFor();
        const chip = island(page).locator('[data-network="practice"]');
        await expect(chip).toBeVisible();
        await expect(chip).toHaveText("Practice");
        expect(await chip.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("repeating-linear-gradient");
        await expect(island(page).getByText("testnet")).toHaveCount(0);
        await expect(island(page).getByText("Mainnet")).toHaveCount(0);
        // Practice mode shows the operator's own screens, so the first screen of a practice payout is "New payout".
        await expect(island(page)).toHaveAccessibleName("ZecDrop New payout Practice");
      });
    });
  }
});

test.describe("where it sits", () => {
  for (const width of [360, 390, 768, 1280]) {
    test(`at ${String(width)}px the capsule is centred, 44px tall, inside the screen, and clear of the first heading at load`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      for (const path of ["/", "/get-paid", "/payslip", "/privacy", "/r/demo?demo=real", "/nope"]) {
        await page.goto(path);
        const heading = page.getByRole("heading", { level: 1 }).first();
        await heading.waitFor();
        const capsule = await island(page).boundingBox();
        const h1 = await heading.boundingBox();
        expect(capsule, `${path}: the capsule is drawn`).not.toBeNull();
        expect(h1, `${path}: the heading is drawn`).not.toBeNull();
        if (capsule === null || h1 === null) continue;
        expect(capsule.height, `${path}: 44px, the size of a touch target`).toBe(44);
        expect(capsule.x, `${path}: inside the screen`).toBeGreaterThanOrEqual(12 - 0.5);
        expect(capsule.x + capsule.width, `${path}: inside the screen`).toBeLessThanOrEqual(width - 12 + 0.5);
        expect(Math.abs(capsule.x + capsule.width / 2 - width / 2), `${path}: centred`).toBeLessThanOrEqual(1.5);
        expect(capsule.y, `${path}: 12px from the top`).toBe(12);
        // The first heading starts below the capsule, with room.
        expect(h1.y, `${path}: the first heading is clear of the capsule`).toBeGreaterThanOrEqual(capsule.y + capsule.height + 8);
        const overflow = await overflowReport(page);
        expect(overflow.page, `${path}: horizontal scroll`).toBeLessThanOrEqual(0);
      }
    });
  }

  for (const width of [320, 360, 390]) {
    test(`at ${String(width)}px nothing of the capsule, its panel included, is laid out past the screen, closed or open, in practice mode`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.addInitScript(() => {
        sessionStorage.setItem("zecdrop.practice", "1");
      });
      // Practice mode has the widest words in the panel ("Practice, nothing is real") and the longest page name is one a click away.
      await page.goto("/privacy");
      await page.getByRole("heading", { level: 1, name: "How privacy works" }).waitFor();
      const outside = () =>
        page.evaluate(
          () =>
            [...document.querySelectorAll(".island-header *")]
              .filter((el) => {
                const box = el.getBoundingClientRect();
                return box.width > 0 && (box.right > window.innerWidth + 1 || box.left < -1);
              })
              .slice(0, 5)
              .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`),
        );
      expect(await outside(), "closed").toEqual([]);
      await openIsland(page);
      expect(await outside(), "open").toEqual([]);
      // Open, the panel is as wide as the screen allows and holds its words on one line each.
      const panel = await page.locator(".island-panel-inner").boundingBox();
      expect(panel?.width).toBeLessThanOrEqual(width - 24 + 0.5);
      expect(await page.locator(".island-footer").evaluate((el) => el.getBoundingClientRect().height), "the footer is one row").toBeLessThan(70);
    });
  }

  test("the tour's sticky column sticks below the capsule, not under it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    const heading = page.getByRole("heading", { level: 2, name: "A payout, screen by screen" });
    await heading.waitFor();
    await page.evaluate(async () => {
      document.querySelector("#tour-heading")?.scrollIntoView();
      window.scrollBy(0, 700);
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    const stuck = await page.evaluate(() => {
      const capsule = document.querySelector(".island")?.getBoundingClientRect();
      const columns = [...document.querySelectorAll('section[aria-labelledby="tour-heading"] li > div')].filter((el) => getComputedStyle(el).position === "sticky");
      const top = columns.map((el) => el.getBoundingClientRect()).find((box) => box.top > 0 && box.top < 300 && box.bottom > 0);
      return { capsuleBottom: capsule?.bottom ?? 0, columnTop: top?.top ?? null };
    });
    expect(stuck.columnTop, "a sticky column is stuck near the top").not.toBeNull();
    expect(stuck.columnTop ?? 0).toBeGreaterThanOrEqual(stuck.capsuleBottom);
  });

  test("with the practice banner above it, it sits just below the banner, and the banner scrolls away while it stays", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      sessionStorage.setItem("zecdrop.practice", "1");
    });
    await page.goto("/new");
    const banner = page.getByRole("region", { name: "Practice mode", exact: true });
    await banner.waitFor();
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    const bannerBox = await banner.boundingBox();
    const capsule = await island(page).boundingBox();
    const h1 = await page.getByRole("heading", { level: 1 }).first().boundingBox();
    if (bannerBox === null || capsule === null || h1 === null) throw new Error("the banner, the capsule and the heading are all drawn");
    expect(capsule.y).toBeGreaterThanOrEqual(bannerBox.y + bannerBox.height);
    expect(h1.y).toBeGreaterThanOrEqual(capsule.y + capsule.height + 8);

    await page.evaluate(() => {
      window.scrollTo(0, 600);
    });
    await expect.poll(async () => (await banner.boundingBox())?.y ?? 0).toBeLessThan(0);
    expect((await island(page).boundingBox())?.y).toBe(12);
  });

  test("it stays at the top, opaque, while the page scrolls under it, and the page is not pushed by it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    const mainTop = (await page.locator("main").boundingBox())?.y ?? 0;

    // Opening it lays over the page: nothing below it moves.
    await openIsland(page);
    expect((await page.locator("main").boundingBox())?.y).toBe(mainTop);
    await page.keyboard.press("Escape");

    await page.evaluate(() => {
      window.scrollTo(0, 1500);
    });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
    expect((await island(page).boundingBox())?.y).toBe(12);
    const opaque = await page.locator(".island").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(opaque, "no transparency: nothing shows through").toMatch(/^rgb\(\d+, \d+, \d+\)$/u);
    // What is under the capsule's centre is the capsule, not the text scrolling past.
    const hit = await page.evaluate(() => {
      const box = document.querySelector(".island")?.getBoundingClientRect();
      if (!box) return "";
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest(".island") ? "the capsule" : "something else";
    });
    expect(hit).toBe("the capsule");
    // And the strip around it lets presses through to the page: it is the capsule that takes them, not a bar across the page.
    const side = await page.evaluate(() => Boolean(document.elementFromPoint(100, 30)?.closest(".island-header")));
    expect(side, "the strip beside the capsule takes no presses").toBe(false);
    // It opens from there.
    await openIsland(page);
    await expect(page.getByRole("link", { name: "Get paid", exact: true })).toBeVisible();
  });

  test("a link or a control that is scrolled to does not end up under it: the skip link brings the page's start below it", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/privacy");
    const heading = page.getByRole("heading", { level: 1, name: "How privacy works" });
    await heading.waitFor();
    await page.evaluate(() => {
      window.scrollTo(0, 2500);
    });
    await page.locator('a[href="#main"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
    await expect.poll(async () => (await heading.boundingBox())?.y ?? 0).toBeGreaterThanOrEqual(56);
  });

  test("it is not printed", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.emulateMedia({ media: "print" });
    await expect(island(page)).toBeHidden();
    await page.emulateMedia({ media: "screen" });
    await expect(island(page)).toBeVisible();
  });
});

test.describe("when the system forces its colours (Windows high contrast)", () => {
  test("it is a bordered box, the mark and the chips are drawn, and the page you are on is underlined", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto(MAINNET_RECEIPT);
    await island(page).waitFor();
    const capsule = await page.locator(".island").evaluate((el) => {
      const style = getComputedStyle(el);
      return { outline: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(capsule.outline).toBe("solid");
    expect(capsule.width).toBeGreaterThanOrEqual(1);
    // The mark keeps a colour (the system's text colour), so it is not lost against the page.
    const mark = await island(page).locator(".island-mark").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(mark).not.toBe("rgba(0, 0, 0, 0)");
    // The network is said in words, so there is nothing a colour was the only way of telling.
    await expect(island(page)).toHaveAccessibleName("ZecDrop Receipt Mainnet");
    await expect(island(page).getByText("Mainnet", { exact: true })).toBeVisible();

    await page.goto("/privacy");
    const nav = await openIsland(page);
    const current = nav.getByRole("link", { name: "How privacy works" });
    await expect(current).toBeVisible();
    expect(await current.locator(".island-label").evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain("underline");
    const other = nav.getByRole("link", { name: "Get paid", exact: true });
    expect(await other.locator(".island-label").evaluate((el) => getComputedStyle(el).textDecorationLine)).not.toContain("underline");
  });
});

test.describe("motion", () => {
  test("under reduced motion nothing animates: no transition on any part, and it is open at once", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    const transitions = () =>
      page.evaluate(() =>
        [".island", ".island-panel", ".island-item", ".island-chevron"].map((selector) => {
          const style = getComputedStyle(document.querySelector(selector) as Element);
          return `${selector} ${style.transitionProperty} ${style.transitionDuration}`;
        }),
      );
    const none = [".island none 0s", ".island-panel none 0s", ".island-item none 0s", ".island-chevron none 0s"];
    expect(await transitions()).toEqual(none);

    await island(page).click();
    // At once: no frame in between. The width is the open width on the first look, and nothing is running.
    expect((await page.locator(".island").boundingBox())?.width).toBe(544);
    expect(await page.evaluate(() => document.querySelector(".island")?.getAnimations({ subtree: true }).length)).toBe(0);
    expect(await transitions()).toEqual(none);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await page.keyboard.press("Escape");
    expect((await page.locator(".island").boundingBox())?.width).toBeLessThan(300);
    await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
  });

  test.describe("with motion", () => {
    test.use({ reducedMotion: "no-preference" });

    /** Press the capsule and take hold of its transitions in the same turn of the page, before a frame is drawn; then step them
     * to each of `times` (in ms from the press) and say what the capsule's width and radius, and the first and the last row's
     * opacity, were there. The clock is ours: how fast the machine draws frames, or how late it gets to look, does not enter into
     * it. (Watching frames go by instead sees as many as the machine draws, and fewer than three of them in the middle of a 350ms
     * morph is a machine that is slow, not a morph that is wrong.) */
    const stepMorph = async (page: Page, times: number[]) =>
      await page.evaluate(async (steps) => {
        const capsule = document.querySelector(".island") as HTMLElement;
        const items = [...document.querySelectorAll(".island-item")] as HTMLElement[];
        (document.querySelector('[data-slot="island"]') as HTMLElement).click();
        // React draws the new state in the microtask after the press; reading a style then makes the browser start the transitions.
        await Promise.resolve();
        await Promise.resolve();
        capsule.getBoundingClientRect();
        const animations = document.getAnimations().filter((animation) => capsule.contains((animation.effect as KeyframeEffect | null)?.target ?? null));
        const timing = animations.map((animation) => {
          const t = animation.effect?.getTiming();
          return { property: (animation as CSSTransition).transitionProperty, duration: Number(t?.duration), delay: Number(t?.delay), easing: t?.easing ?? "" };
        });
        for (const animation of animations) animation.pause();
        const frames = steps.map((time) => {
          for (const animation of animations) animation.currentTime = time;
          const style = getComputedStyle(capsule);
          return {
            time,
            width: capsule.getBoundingClientRect().width,
            radius: style.borderTopLeftRadius,
            first: Number(getComputedStyle(items[0] as HTMLElement).opacity),
            last: Number(getComputedStyle(items.at(-1) as HTMLElement).opacity),
          };
        });
        for (const animation of animations) animation.finish();
        return { timing, frames };
      }, times);

    test("the only motion is the morph, 350ms, from the capsule's width to the panel's and back", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto("/");
      await page.getByRole("heading", { level: 1 }).waitFor();
      await page.evaluate(async () => {
        await document.fonts.ready;
      });

      // At rest nothing about the capsule is animated, and nothing is running: no load-in, no idle motion.
      const rest = () =>
        page.evaluate(() => {
          const capsule = document.querySelector(".island") as HTMLElement;
          return { duration: getComputedStyle(capsule).transitionDuration, running: capsule.getAnimations({ subtree: true }).length, morph: capsule.dataset["morph"] };
        });
      expect(await rest()).toEqual({ duration: "0s", running: 0, morph: "false" });

      const TIMES = [0, 40, 100, 200, 350];
      const opening = await stepMorph(page, TIMES);
      // What runs is the morph: the width, the height (the panel's row), the corners and the chevron, each 350ms with the one curve ...
      const morph = opening.timing.filter((t) => ["width", "grid-template-rows", "border-top-left-radius", "border-bottom-right-radius", "transform"].includes(t.property));
      expect(morph.map((t) => t.property).sort()).toEqual(["border-bottom-right-radius", "border-top-left-radius", "grid-template-rows", "transform", "width"]);
      for (const t of morph) expect([t.property, t.duration, t.delay, t.easing]).toEqual([t.property, 350, 0, "cubic-bezier(0.32, 0.72, 0, 1)"]);
      // ... and the rows fading in, and nothing else.
      expect([...new Set(opening.timing.map((t) => t.property))].sort()).toEqual(["border-bottom-left-radius", "border-bottom-right-radius", "border-top-left-radius", "border-top-right-radius", "grid-template-rows", "opacity", "transform", "width"]);
      const widths = opening.frames.map((f) => f.width);
      const [collapsed, open] = [widths[0] ?? 0, widths.at(-1) ?? 0];
      expect(collapsed, "it starts as the capsule").toBeLessThan(300);
      expect(open, "it ends as wide as the panel").toBe(544);
      expect(widths, "it only grows while opening").toEqual([...widths].sort((a, b) => a - b));
      for (const frame of opening.frames.filter((f) => f.time === 40 || f.time === 100)) {
        expect(frame.width, `in the middle of it at ${String(frame.time)}ms`).toBeGreaterThan(collapsed + 20);
        expect(frame.width, `in the middle of it at ${String(frame.time)}ms`).toBeLessThan(open - 4);
      }
      expect([opening.frames[0]?.radius, opening.frames.at(-1)?.radius], "from a pill to a panel's corner").toEqual(["22px", "28px"]);

      // Then it is at rest again: the transitions go off, nothing runs.
      await expect.poll(rest).toEqual({ duration: "0s", running: 0, morph: "false" });

      const closing = await stepMorph(page, TIMES);
      const shrinking = closing.frames.map((f) => f.width);
      expect(shrinking[0], "it starts as the panel").toBe(544);
      expect(shrinking.at(-1) ?? 999, "back to the capsule's own width").toBeLessThan(300);
      expect(shrinking, "it only shrinks while closing").toEqual([...shrinking].sort((a, b) => b - a));
      for (const frame of closing.frames.filter((f) => f.time === 40 || f.time === 100)) {
        expect(frame.width, `in the middle of it at ${String(frame.time)}ms`).toBeGreaterThan((shrinking.at(-1) ?? 0) + 4);
        expect(frame.width, `in the middle of it at ${String(frame.time)}ms`).toBeLessThan(544 - 20);
      }
      await expect.poll(rest).toEqual({ duration: "0s", running: 0, morph: "false" });
    });

    test("its contents fade in one after the other, and the links are readable once it has finished", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto("/");
      await page.getByRole("heading", { level: 1 }).waitFor();
      const { frames } = await stepMorph(page, [0, 90, 150, 250, 500]);
      const at = (time: number) => frames.find((f) => f.time === time) ?? { first: -1, last: -1 };
      expect(at(0), "nothing is drawn of them at first").toEqual(expect.objectContaining({ first: 0, last: 0 }));
      // The first row is on its way while the last has not begun: they are staggered, and the later never runs ahead of the first.
      expect(at(150).first, "the first is on its way").toBeGreaterThan(0.2);
      expect(at(150).last, "the last has not begun").toBe(0);
      for (const frame of frames) expect(frame.first, `at ${String(frame.time)}ms`).toBeGreaterThanOrEqual(frame.last - 0.001);
      // And once it is over they are all there.
      expect(at(500)).toEqual(expect.objectContaining({ first: 1, last: 1 }));
      await expect(page.getByRole("link", { name: "Get paid", exact: true })).toBeVisible();
    });

    test("it does not move when the page it names changes: the width follows the name at once, outside the morph", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto("/");
      await page.getByRole("heading", { level: 1 }).waitFor();
      // The capsule's width follows its text, so the fonts must be in: a late one is a change of width this is not about.
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      const before = Math.round((await page.locator(".island").boundingBox())?.width ?? 0);
      // Every frame's width, from before the link is pressed (a link in the page, not in the capsule).
      await page.evaluate(() => {
        const seen: number[] = [];
        (window as unknown as { __widths: number[] }).__widths = seen;
        const sample = () => {
          seen.push(Math.round(document.querySelector(".island")?.getBoundingClientRect().width ?? 0));
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await page.getByRole("main").getByRole("link", { name: "How privacy works" }).first().click();
      await page.getByRole("heading", { level: 1, name: "How privacy works" }).waitFor();
      await page.waitForTimeout(700);
      const widths = await page.evaluate(() => (window as unknown as { __widths: number[] }).__widths);
      const after = widths.at(-1) ?? 0;
      expect(after, "the longer name makes it wider").toBeGreaterThan(before);
      // Every frame is the one width or the other: never a tween between them.
      expect([...new Set(widths)].sort((a, b) => a - b), `widths: ${[...new Set(widths)].join(" ")}`).toEqual([before, after]);
    });
  });
});

test.describe("what is over what", () => {
  test("the toaster and the dialogs are above the capsule", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    const order = await page.evaluate(() => {
      const z = (element: Element | null) => Number.parseInt(element ? getComputedStyle(element).zIndex : "0", 10);
      return { capsule: z(document.querySelector(".island-header")), toaster: z(document.querySelector('[data-testid="toast"]')?.parentElement ?? null) };
    });
    expect(order.toaster).toBeGreaterThan(order.capsule);
    expect(order.capsule).toBeGreaterThan(10); // over the page's own raised parts (the tour's pictures, the timeline)
  });
});
