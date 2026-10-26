import { expect, test, type Page } from "@playwright/test";

import { axeViolations, island, islandPanel, openIsland, THEMES, useTheme, watchProblems, watchRequests } from "./helpers.js";

// The screen (web/DESIGN.md, "The screen"): the page is paper seen on a device. A fixed frame draws a ring of the bezel colour around a
// window with rounded corners, the header capsule sits in it like a notch, and every shape is cut from one scale of curves. What jsdom
// cannot say, a browser does here: where the corners cut in, that the frame takes no press, what is above what, what a press and a
// touch do, and that every bit of motion is the visitor's own and is gone under "reduce motion".

const WIDTHS = [360, 390, 768, 1280] as const;
const HEIGHT = 800;

/** The bezel and the screen's radius at a width, as index.css sets them: 6px and 26px below 40rem, 8px and 30px from there up. */
const bezelAt = (width: number) => (width < 640 ? 6 : 8);
const radiusAt = (width: number) => (width < 640 ? 26 : 30);

// ---- Where the corners cut in -----------------------------------------------------------------------------------------------------

interface Clipped {
  what: string;
  x: number;
  y: number;
}

/** In the page: every focusable element and every line of text that is whole on the screen and near a corner, whose own corner (the
 * middle of its arc, where it is rounded) falls outside the rounded screen. `band` is which corners to look at: the top two at the top
 * of a page, the bottom two at its end, where the footer is. */
async function clippedByTheCurves(page: Page, band: "top" | "bottom"): Promise<Clipped[]> {
  return await page.evaluate((which) => {
    const frame = document.querySelector<HTMLElement>(".screen-frame");
    if (frame === null) return [{ what: "no .screen-frame in the page", x: 0, y: 0 }];
    const style = getComputedStyle(frame);
    const edge = Number.parseFloat(style.left);
    const radius = Number.parseFloat(style.borderTopLeftRadius);
    const W = window.innerWidth;
    const H = window.innerHeight;

    // Whether a point is inside the screen: inside the ring, and, in a corner's square, inside that corner's circle.
    const inside = (x: number, y: number): boolean => {
      if (x < edge - 0.01 || x > W - edge + 0.01 || y < edge - 0.01 || y > H - edge + 0.01) return false;
      const dx = Math.max(edge + radius - x, x - (W - edge - radius), 0);
      const dy = Math.max(edge + radius - y, y - (H - edge - radius), 0);
      return dx * dx + dy * dy <= radius * radius + 0.5;
    };

    const near = (r: { top: number; bottom: number }) => (which === "top" ? r.top < edge + radius * 1.5 : r.bottom > H - edge - radius * 1.5);
    const whole = (r: DOMRect) => r.width > 1 && r.height > 1 && r.top >= 0 && r.bottom <= H && r.left >= 0 && r.right <= W;

    const bad: Clipped[] = [];
    const check = (what: string, r: DOMRect, radii: [number, number, number, number] = [0, 0, 0, 0]) => {
      if (!whole(r)) return;
      // Anywhere on the screen, a box that is whole in the window must be clear of the ring at its sides: nothing is drawn under the bezel.
      if (r.left < edge - 0.01) bad.push({ what: `${what} (under the left bezel)`, x: Math.round(r.left), y: Math.round(r.top) });
      if (r.right > W - edge + 0.01) bad.push({ what: `${what} (under the right bezel)`, x: Math.round(r.right), y: Math.round(r.top) });
      // Near a corner, the curve cuts in as well.
      if (!near(r)) return;
      // Each corner of the box; where it is rounded, the middle of its arc (the corner of the box itself is not painted).
      const k = 1 - Math.SQRT1_2;
      const corners: [number, number][] = [
        [r.left + radii[0] * k, r.top + radii[0] * k],
        [r.right - radii[1] * k, r.top + radii[1] * k],
        [r.right - radii[2] * k, r.bottom - radii[2] * k],
        [r.left + radii[3] * k, r.bottom - radii[3] * k],
      ];
      for (const [x, y] of corners) if (!inside(x, y)) bad.push({ what, x: Math.round(x), y: Math.round(y) });
    };

    // Focusable things: their boxes, as painted (a pill's corners are its arcs).
    const focusable = document.querySelectorAll<HTMLElement>("a[href], button, input, textarea, select, summary, [tabindex]:not([tabindex='-1'])");
    for (const element of focusable) {
      if (element.closest("[inert]") !== null) continue;
      const cs = getComputedStyle(element);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const px = (value: string) => Number.parseFloat(value) || 0;
      const clamp = (value: number, r: DOMRect) => Math.min(value, r.width / 2, r.height / 2);
      const r = element.getBoundingClientRect();
      check(
        `${element.tagName.toLowerCase()} "${(element.textContent ?? "").trim().slice(0, 24)}"`,
        r,
        [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => clamp(px(v), r)) as [number, number, number, number],
      );
    }

    // Lines of text, as the browser lays them out.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if ((node.textContent ?? "").trim() === "") continue;
      const parent = node.parentElement;
      if (parent === null || parent.closest("[inert], script, style, [aria-hidden='true']") !== null) continue;
      const cs = getComputedStyle(parent);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) check(`text "${(node.textContent ?? "").trim().slice(0, 24)}"`, r);
    }
    return bad;
  }, band);
}

const PUBLIC_PAGES = ["/", "/get-paid", "/payslip", "/privacy", "/r/demo?demo=real", "/nope"] as const;

for (const width of WIDTHS) {
  test.describe(`nothing is clipped by the screen's curves, at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: HEIGHT } });

    for (const path of PUBLIC_PAGES) {
      test(`${path}: the top corners at the top of the page, the bottom corners at its end`, async ({ page }) => {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        expect(await clippedByTheCurves(page, "top"), `${path} at the top`).toEqual([]);
        await page.evaluate(() => {
          window.scrollTo(0, document.documentElement.scrollHeight);
        });
        expect(await clippedByTheCurves(page, "bottom"), `${path} at its end`).toEqual([]);
      });
    }

    test("the skip link, when it takes the focus", async ({ page }) => {
      await page.goto("/get-paid");
      // Drawn first: a Tab before the page has been put on the screen goes to the browser's own controls.
      await expect(page.getByRole("heading", { level: 1, name: "Get paid in ZEC" })).toBeVisible();
      await page.keyboard.press("Tab");
      const skip = page.getByRole("link", { name: "Skip to content" });
      await expect(skip).toBeFocused();
      await expect(skip).toBeVisible();
      expect(await clippedByTheCurves(page, "top")).toEqual([]);
    });

    test("the practice banner, its sentence and its button, on a page in practice mode", async ({ page }) => {
      await page.addInitScript(() => {
        sessionStorage.setItem("zecdrop.practice", "1");
      });
      await page.goto("/new");
      await expect(page.getByRole("region", { name: "Practice mode", exact: true })).toBeVisible();
      expect(await clippedByTheCurves(page, "top")).toEqual([]);
    });

    test("the capsule, closed and open, is inside the screen: its corners are arcs, and they stay in", async ({ page }) => {
      await page.goto("/get-paid");
      for (const open of [false, true]) {
        if (open) await openIsland(page);
        const box = await page.locator(".island").boundingBox();
        expect(box).not.toBeNull();
        const edge = bezelAt(width);
        const radius = radiusAt(width);
        const r = Number.parseFloat(await page.locator(".island").evaluate((el) => getComputedStyle(el).borderTopLeftRadius));
        const k = 1 - Math.SQRT1_2;
        const { x, y, width: w } = box as { x: number; y: number; width: number };
        for (const [px, py] of [
          [x + r * k, y + r * k],
          [x + w - r * k, y + r * k],
        ] as const) {
          const dx = Math.max(edge + radius - px, px - (width - edge - radius), 0);
          const dy = Math.max(edge + radius - py, 0);
          expect(dx * dx + dy * dy, `a corner of the capsule (open: ${String(open)}) is outside the screen's curve`).toBeLessThanOrEqual(radius * radius);
        }
      }
    });
  });
}

// ---- The frame itself ---------------------------------------------------------------------------------------------------------------

for (const width of WIDTHS) {
  test.describe(`the frame, at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: HEIGHT } });

    test("is a fixed ring of the bezel colour, with the screen's own radius, in the window's corners", async ({ page }) => {
      await page.goto("/");
      const frame = page.getByTestId("screen-frame");
      await expect(frame).toHaveAttribute("aria-hidden", "true");
      const css = await frame.evaluate((el) => {
        const s = getComputedStyle(el);
        return { position: s.position, events: s.pointerEvents, radius: s.borderTopLeftRadius, left: s.left, top: s.top, right: s.right, bottom: s.bottom, z: s.zIndex };
      });
      expect(css.position).toBe("fixed");
      expect(css.events).toBe("none");
      expect(css.radius).toBe(`${String(radiusAt(width))}px`);
      for (const side of [css.left, css.top, css.right, css.bottom]) expect(side).toBe(`${String(bezelAt(width))}px`);
      // Above the page and the banner, below the capsule (z 40), the popovers (50) and the toast (60).
      expect(Number(css.z)).toBeLessThan(40);
      expect(Number(css.z)).toBeGreaterThan(10);
    });

    test("takes no press: the page under the ring, and under the curves, answers", async ({ page }) => {
      await page.goto("/");
      const hits = await page.evaluate(
        ({ w, h }) => {
          const points: [number, number][] = [
            [1, 1], // the very corner
            [w / 2, 1], // the top edge
            [1, h / 2], // the left edge
            [w - 2, h / 2], // the right edge
            [w / 2, h - 2], // the bottom edge
            [10, 10], // the curve that cuts the corner off
            [w - 10, 10],
            [10, h - 10],
            [w - 10, h - 10],
            [w / 2, h / 2],
          ];
          return points.map(([x, y]) => {
            const element = document.elementFromPoint(x, y);
            return { x, y, frame: element?.closest(".screen-frame") !== null && element !== null, tag: element?.tagName ?? "none" };
          });
        },
        { w: width, h: HEIGHT },
      );
      for (const hit of hits) expect(hit.frame, `a press at (${String(hit.x)}, ${String(hit.y)}) landed on the frame`).toBe(false);
      for (const hit of hits) expect(hit.tag, `nothing at (${String(hit.x)}, ${String(hit.y)})`).not.toBe("none");
    });

    test("does not stop a press on a control that sits under the curve's edge from reaching it", async ({ page }) => {
      await page.goto("/get-paid");
      // The footer's links are at the bottom of the page; scroll to them and press one: the ring is over the page's last pixels.
      await page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      const link = page.getByRole("contentinfo").getByRole("link", { name: "How privacy works" });
      const box = await link.boundingBox();
      expect(box).not.toBeNull();
      const { x, y, width: w, height: h } = box as { x: number; y: number; width: number; height: number };
      await page.mouse.click(x + w / 2, y + h - 1);
      await expect(page.getByRole("heading", { level: 1, name: "How privacy works" })).toBeVisible();
    });

    test("the capsule sits like a notch: half a rem under the bezel, and it keeps its place while the page scrolls", async ({ page }) => {
      await page.goto("/get-paid");
      const top = bezelAt(width) + 8;
      expect((await island(page).boundingBox())?.y).toBe(top);
      await page.evaluate(() => {
        window.scrollTo(0, 500);
      });
      expect((await island(page).boundingBox())?.y).toBe(top);
    });

    test("is above the page and below the capsule: the capsule is drawn over a page that scrolls under it, the ring over both", async ({ page }) => {
      await page.goto("/");
      const order = await page.evaluate(() => {
        const z = (selector: string) => Number(getComputedStyle(document.querySelector(selector) as Element).zIndex);
        const toast = Number(getComputedStyle(document.querySelector('[data-testid="toast"]')?.parentElement as Element).zIndex);
        return { frame: z(".screen-frame"), capsule: z(".island-header"), toast };
      });
      expect(order.frame).toBeLessThan(order.capsule);
      expect(order.frame).toBeLessThan(order.toast);
    });
  });
}

test.describe("popovers and dialogs are above the frame", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("the appearance panel (a popover) is above it", async ({ page }) => {
    await page.goto("/get-paid");
    await openIsland(page);
    await islandPanel(page).getByRole("button", { name: /appearance/iu }).click();
    const popover = page.locator('[data-slot="popover-content"]');
    await expect(popover).toBeVisible();
    const [frame, over] = await page.evaluate(() => [
      Number(getComputedStyle(document.querySelector(".screen-frame") as Element).zIndex),
      Number(getComputedStyle(document.querySelector('[data-slot="popover-content"]') as Element).zIndex),
    ]);
    expect(over).toBeGreaterThan(frame);
  });

  test("the confirm sheet (a modal dialog, in the browser's top layer) is above it, and sits inside the curve on a phone", async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem("zecdrop.practice", "1");
    });
    await page.goto("/new");
    await page.getByRole("button", { name: "Use the example list" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("link", { name: "Looks right, continue" }).click();
    await page.getByRole("button", { name: "Record mock deposit" }).click();
    await page.getByRole("button", { name: "Send 8 payouts" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    expect(await sheet.evaluate((el) => el.matches(":modal"))).toBe(true);
    const box = (await sheet.boundingBox()) as { x: number; y: number; width: number; height: number };
    // The sheet's corners: its bottom ones follow the screen's own, and it is a bezel's width in from the edges.
    expect(box.x).toBe(6);
    expect(box.x + box.width).toBe(390 - 6);
    expect(box.y + box.height).toBe(800 - 6);
    const radii = await sheet.evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.borderTopLeftRadius, s.borderBottomLeftRadius];
    });
    expect(radii).toEqual(["20px", "26px"]);
    expect(await axeViolations(page), "the sheet over the frame").toEqual([]);
  });
});

// ---- The scale of curves -----------------------------------------------------------------------------------------------------------

test.describe("one scale of curves", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the tokens, the slips, the pills and the fields", async ({ page }) => {
    await page.goto("/");
    // The numbers and their units, so that the minifier writing ".875rem" for "0.875rem" is no difference.
    const tokens = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return ["--r-island", "--r-island-open", "--r-card", "--r-control", "--r-chip", "--screen-r", "--bezel-w"].map((name) => {
        const value = root.getPropertyValue(name).trim();
        return [name, `${String(Number.parseFloat(value))}${value.replace(/^[\d.]+/u, "")}`];
      });
    });
    expect(Object.fromEntries(tokens)).toEqual({
      "--r-island": "1.375rem",
      "--r-island-open": "1.75rem",
      "--r-card": "1.25rem",
      "--r-control": "0.875rem",
      "--r-chip": "999px",
      "--screen-r": "30px",
      "--bezel-w": "8px",
    });
    // A slip of paper is a card of 20px; a button is a pill; the segmented control and its thumb are pills.
    expect(await page.locator(".slip").first().evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("20px");
    const pill = await page.getByRole("link", { name: "See a real receipt" }).evaluate((el) => Number.parseFloat(getComputedStyle(el).borderTopLeftRadius));
    expect(pill).toBeGreaterThan(100);
    // The segmented control is the thumb's parent.
    const control = page.locator('[data-slot="segmented-thumb"]').first().locator("xpath=..");
    expect(await control.evaluate((el) => Number.parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThan(100);
    expect(await page.locator('[data-slot="segmented-thumb"]').evaluate((el) => Number.parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThan(100);
    // A field is 14px.
    await page.goto("/get-paid");
    expect(await page.getByLabel("Your address").evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("14px");
  });

  for (const theme of THEMES) {
    test(`a slip has ink-tinted layered shadows in the light set, and a lighter edge instead in the dark set (${theme})`, async ({ page }) => {
      await useTheme(page, theme);
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const shadow = await page.locator(".slip").first().evaluate((el) => getComputedStyle(el).boxShadow);
      if (theme === "light") expect(shadow, "layered shadows").toMatch(/ 0px 14px 24px -18px/u);
      else expect(shadow, "one hairline edge, no drop shadow").not.toMatch(/ 14px 24px/u);
    });
  }
});

// ---- The grain ---------------------------------------------------------------------------------------------------------------------

test.describe("the paper's grain", () => {
  test("is a static file of the site's own: one fixed layer behind the content, from a file and not from a data: address", async ({ page }) => {
    const requests = watchRequests(page);
    const problems = watchProblems(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const grain = await page.evaluate(() => {
      const s = getComputedStyle(document.body, "::before");
      return { image: s.backgroundImage, position: s.position, z: s.zIndex, opacity: s.opacity, events: s.pointerEvents };
    });
    expect(grain.image).toMatch(/^url\("http:\/\/127\.0\.0\.1:\d+\/grain\.png"\)$/u);
    expect(grain.position).toBe("fixed");
    expect(Number(grain.z)).toBeLessThan(0);
    // 3 to 4 percent: seen if one looks for it, not otherwise.
    expect(Number(grain.opacity)).toBeGreaterThanOrEqual(0.03);
    expect(Number(grain.opacity)).toBeLessThanOrEqual(0.04);
    expect(grain.events).toBe("none");
    expect(requests().filter((url) => url.endsWith("/grain.png"))).toHaveLength(1);
    // No picture is drawn from a data: address anywhere in the page's own stylesheets (the hosted policy forbids it).
    const sheets = await page.evaluate(async () => {
      const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((l) => l.href);
      return await Promise.all(links.map(async (href) => await (await fetch(href)).text()));
    });
    for (const css of sheets) expect(css).not.toMatch(/url\(\s*["']?data:image/iu);
    expect(problems()).toEqual([]);
    const response = await page.request.get("/grain.png");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
    expect((await response.body()).length).toBeLessThan(8 * 1024);
  });

  test("is behind the cards, so a slip stays clean, and costs the page nothing it can feel: no layout, and it never takes a press", async ({ page }) => {
    await page.goto("/");
    const behind = await page.evaluate(() => {
      const slip = document.querySelector(".slip") as HTMLElement;
      const rect = slip.getBoundingClientRect();
      // The element on top at the middle of a slip is the slip's own, never the grain.
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 4);
      return top !== null && slip.contains(top);
    });
    expect(behind).toBe(true);
  });
});

// ---- A press and a touch ------------------------------------------------------------------------------------------------------------

test.describe("what a press does, when the visitor has not asked for less motion", () => {
  test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference" });

  test("a button gives under a press within 100ms, springs back, and lifts a pixel under a pointer", async ({ page }) => {
    await page.goto("/get-paid");
    const button = page.getByRole("link", { name: "Zodl at zodl.com" });
    await button.scrollIntoViewIfNeeded();
    const box = (await button.boundingBox()) as { x: number; y: number; width: number; height: number };
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // Under the pointer: lifted a pixel (Lively is the default).
    await expect.poll(async () => await button.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).f)).toBeCloseTo(-1, 0);
    await page.mouse.down();
    // Pressed: a hair smaller and a pixel down, and it gets there inside 100ms (the transition is 90ms).
    await page.waitForTimeout(110);
    const pressed = await button.evaluate((el) => {
      const m = new DOMMatrix(getComputedStyle(el).transform);
      return { scale: Number(m.a.toFixed(2)), down: Number(m.f.toFixed(1)) };
    });
    expect(pressed).toEqual({ scale: 0.98, down: 1 });
    await page.mouse.up({ button: "left" });
  });

  test("a button that lifts under the pointer keeps the pointer on its lowest pixel: it does not drop and lift again (no flicker)", async ({ page }) => {
    await page.goto("/get-paid");
    const button = page.getByRole("link", { name: "Zodl at zodl.com" });
    await button.scrollIntoViewIfNeeded();
    const box = (await button.boundingBox()) as { x: number; y: number; width: number; height: number };
    // The very bottom row of the button's own box, where a lift of a pixel would take the button from under the pointer.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 0.5);
    const states: boolean[] = [];
    for (let i = 0; i < 16; i += 1) {
      states.push(await button.evaluate((el) => el.matches(":hover")));
      await page.waitForTimeout(60);
    }
    expect(states, "the pointer was on the button the whole time").toEqual(states.map(() => true));
    // And it is lifted, so this tested a button that moves.
    expect(await button.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).f)).toBeCloseTo(-1, 0);
  });

  test("a button the keyboard has focused keeps its ring (the highlighter) while the pointer is over it", async ({ page }) => {
    await page.goto("/get-paid");
    await expect(page.getByRole("heading", { level: 1, name: "Get paid in ZEC" })).toBeVisible();
    const link = page.getByRole("link", { name: "Zodl at zodl.com" });
    // The skip link, the capsule, then the first thing in the page.
    for (let i = 0; i < 3; i += 1) await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    const ring = async () => await link.evaluate((el) => getComputedStyle(el).boxShadow);
    // The ring comes in with the press response's own timing (200ms), so it is waited for, whole: the highlighter, at full strength.
    await expect.poll(ring, { message: "focused" }).toContain("rgb(255, 214, 10)");
    await link.hover();
    await expect.poll(ring, { message: "focused and hovered", timeout: 3000 }).toContain("rgb(255, 214, 10)");
    // And it stays: a moment later it is still the ring, not the hover's soft shadow.
    await page.waitForTimeout(400);
    expect(await ring(), "focused and hovered, settled").toContain("rgb(255, 214, 10)");
  });

  test("a bar shows its label when it is touched, and only its label, and puts it away when the pointer leaves", async ({ page }) => {
    await page.goto("/");
    const bar = page.getByRole("img", { name: "hidden" }).first();
    await expect(bar).toBeVisible();
    // How far below the bar the label sits, in pixels: 0 when it is shown.
    const below = async () => await bar.evaluate((el) => new DOMMatrix(getComputedStyle(el, "::after").transform).f);
    const label = async () => await bar.evaluate((el) => getComputedStyle(el, "::after").content);
    // Away: the label sits below the bar's edge, cut off by it.
    expect(await below()).toBeGreaterThan(0);
    expect(await label()).toContain("hidden");
    await bar.hover();
    await expect.poll(below).toBe(0);
    await page.mouse.move(2, 400);
    await expect.poll(below).toBeGreaterThan(0);
    // The bar is still one thing named "hidden", and its text is empty: the label is drawn, not written.
    await expect(bar).toHaveAccessibleName("hidden");
    expect((await bar.innerText()).trim()).toBe("");
  });

  test("the lens's choice is one pill that slides to the option, in about 220ms, and does not switch a background", async ({ page }) => {
    await page.goto("/");
    const thumb = page.locator('[data-slot="segmented-thumb"]').first();
    await expect(thumb).toBeVisible();
    const before = await thumb.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).e);
    await page.getByRole("radio", { name: "One person" }).click();
    const timing = await thumb.evaluate((el) => el.getAnimations().map((a) => ({ property: (a as CSSTransition).transitionProperty, duration: Number(a.effect?.getComputedTiming().duration) })));
    expect(timing.find((t) => t.property === "transform")?.duration).toBeGreaterThanOrEqual(150);
    expect(timing.find((t) => t.property === "transform")?.duration).toBeLessThanOrEqual(260);
    await expect.poll(async () => await thumb.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).e)).toBeGreaterThan(before);
    // The chosen option's text is on the pill (ink on the fill); the options themselves (the home page's four views) have no
    // fill of their own.
    const radios = await thumb.locator("xpath=..").getByRole("radio").all();
    expect(radios).toHaveLength(4);
    for (const radio of radios) expect(await radio.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  });
});

test.describe("under 'reduce motion', none of it moves", () => {
  test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });

  test("a pressed button does not shrink, and no hover lifts", async ({ page }) => {
    await page.goto("/get-paid");
    const button = page.getByRole("link", { name: "Zodl at zodl.com" });
    const box = (await button.boundingBox()) as { x: number; y: number; width: number; height: number };
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(150);
    expect(await button.evaluate((el) => getComputedStyle(el).transform)).toBe("none");
    expect(await button.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
    await page.mouse.up({ button: "left" });
  });

  test("the pill and the bar's label arrive at once, with no transition", async ({ page }) => {
    await page.goto("/");
    const thumb = page.locator('[data-slot="segmented-thumb"]').first();
    await page.getByRole("radio", { name: "One person" }).click();
    expect(await thumb.evaluate((el) => el.getAnimations().length)).toBe(0);
    expect(await thumb.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
    const bar = page.getByRole("img", { name: "hidden" }).first();
    expect(await bar.evaluate((el) => getComputedStyle(el, "::after").transitionDuration)).toBe("0s");
  });

  test("a new page is not a view transition", async ({ page }) => {
    await page.addInitScript(() => {
      const calls: number[] = [];
      (window as unknown as { __transitions: number[] }).__transitions = calls;
      const original = document.startViewTransition.bind(document);
      document.startViewTransition = (...args: Parameters<typeof original>) => {
        calls.push(Date.now());
        return original(...args);
      };
    });
    await page.goto("/");
    await (await openIsland(page)).getByRole("link", { name: "Get paid" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Get paid in ZEC" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __transitions: number[] }).__transitions.length)).toBe(0);
  });
});

// ---- A new page ---------------------------------------------------------------------------------------------------------------------

test.describe("a new page cross-fades where the browser can", () => {
  test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference" });

  test("the page is changed inside a view transition, the capsule carries a name of its own, and the page arrives", async ({ page }) => {
    await page.addInitScript(() => {
      const seen: { at: number; finished?: number }[] = [];
      (window as unknown as { __transitions: typeof seen }).__transitions = seen;
      const original = document.startViewTransition.bind(document);
      document.startViewTransition = (...args: Parameters<typeof original>) => {
        const entry: { at: number; finished?: number } = { at: performance.now() };
        seen.push(entry);
        const transition = original(...args);
        void transition.finished.then(() => {
          entry.finished = performance.now();
        });
        return transition;
      };
    });
    const problems = watchProblems(page);
    await page.goto("/");
    expect(await page.locator(".island-header").evaluate((el) => getComputedStyle(el).viewTransitionName)).toBe("island");
    await (await openIsland(page)).getByRole("link", { name: "Get paid" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Get paid in ZEC" })).toBeVisible();
    await expect(island(page)).toHaveAccessibleName("ZecDrop Get paid testnet");
    const seen = await page.evaluate(() => (window as unknown as { __transitions: { at: number; finished?: number }[] }).__transitions);
    expect(seen).toHaveLength(1);
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __transitions: { finished?: number }[] }).__transitions))[0]?.finished).toBeDefined();
    const entry = (await page.evaluate(() => (window as unknown as { __transitions: { at: number; finished?: number }[] }).__transitions))[0] as { at: number; finished: number };
    // About 180ms of cross-fade, and the page was not held longer than a transition needs.
    expect(entry.finished - entry.at).toBeLessThan(900);
    expect(problems()).toEqual([]);
    // Back is the browser's own, and works as it always did.
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: /Pay many people/u })).toBeVisible();
  });

  test("a browser that has no view transitions changes the page as it always did", async ({ page }) => {
    await page.addInitScript(() => {
      Reflect.deleteProperty(document, "startViewTransition");
      Object.defineProperty(Document.prototype, "startViewTransition", { value: undefined, configurable: true });
    });
    const problems = watchProblems(page);
    await page.goto("/");
    await (await openIsland(page)).getByRole("link", { name: "Check a payslip" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Check a payslip" })).toBeVisible();
    expect(problems()).toEqual([]);
  });

  test("the cross-fade is 180ms, and reads the same --motion as every other animation (whole when Lively, shorter when Calm)", async ({ page }) => {
    await page.goto("/");
    const css = await page.evaluate(async () => {
      const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')];
      return (await Promise.all(links.map(async (l) => await (await fetch(l.href)).text()))).join("\n");
    });
    // (The build writes 180ms as .18s.)
    const rule = (name: string) => new RegExp(`::view-transition-${name}\\(root\\)\\s*\\{[^}]*animation-duration:\\s*calc\\((?:180ms|\\.18s)\\s*\\*\\s*var\\(--motion`, "u");
    for (const name of ["group", "old", "new"]) expect(css, name).toMatch(rule(name));
    expect(css).toMatch(/::view-transition-group\(island\)\s*\{[^}]*animation-duration:\s*calc\((?:180ms|\.18s)\s*\*\s*var\(--motion/u);
  });
});

// ---- Forced colours and print --------------------------------------------------------------------------------------------------------

test.describe("forced colours, and print", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("forced colours: no frame and no grain are drawn, and a slip still has an edge", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto("/");
    expect(await page.getByTestId("screen-frame").evaluate((el) => getComputedStyle(el).display)).toBe("none");
    expect(await page.evaluate(() => getComputedStyle(document.body, "::before").display)).toBe("none");
    expect(await page.locator(".slip").first().evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
    expect(await page.locator(".island").evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
  });

  test("print: no frame, no grain, no capsule", async ({ page }) => {
    await page.goto("/get-paid");
    await page.emulateMedia({ media: "print" });
    expect(await page.getByTestId("screen-frame").evaluate((el) => getComputedStyle(el).display)).toBe("none");
    expect(await page.evaluate(() => getComputedStyle(document.body, "::before").display)).toBe("none");
    expect(await page.locator(".island-header").evaluate((el) => getComputedStyle(el).display)).toBe("none");
  });
});

// ---- Both themes, axe, the frame in each --------------------------------------------------------------------------------------------

for (const theme of THEMES) {
  test(`the frame's colour is ink in the light set and pure black after hours (${theme})`, async ({ page }) => {
    await useTheme(page, theme);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const frame = await page.getByTestId("screen-frame").evaluate((el) => {
      const s = getComputedStyle(el);
      return s.boxShadow;
    });
    // The first shadow is the ring: a huge spread in the bezel colour.
    expect(frame).toMatch(theme === "light" ? /^rgb\(11, 11, 11\) 0px 0px 0px /u : /^rgb\(0, 0, 0\) 0px 0px 0px /u);
    if (theme === "dark") expect(frame, "a hairline on the curve").toMatch(/inset/u);
    expect(await axeViolations(page), `axe, ${theme}`).toEqual([]);
  });
}
