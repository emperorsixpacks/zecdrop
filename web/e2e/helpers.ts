import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

export interface PageUnderTest {
  name: string;
  path: string;
  /** Text of the page's one <h1>. */
  h1: string;
  /** For pages that load data: a heading that appears once it has. */
  ready?: string;
}

export const PAGES: readonly PageUnderTest[] = [
  { name: "home", path: "/", h1: "Pay many people. Keep it private. Prove the total." },
  { name: "make a payout", path: "/start", h1: "Make a payout" },
  { name: "real testnet sample receipt", path: "/r/demo?demo=real", h1: "Payout receipt", ready: "Status" },
  { name: "first real testnet batch", path: "/r/demo?demo=real-smoke", h1: "Payout receipt", ready: "Status" },
  { name: "sample receipt", path: "/r/demo?demo=1", h1: "Payout receipt", ready: "Status" },
  { name: "get paid", path: "/get-paid", h1: "Get paid in ZEC" },
  { name: "check a payslip", path: "/payslip", h1: "Check a payslip" },
  { name: "how privacy works", path: "/privacy", h1: "How privacy works" },
  { name: "incomplete receipt link", path: "/r/not-a-real-link", h1: "Payout receipt", ready: "This receipt link is incomplete" },
  { name: "sample receipt with findings", path: "/r/demo?demo=findings", h1: "Payout receipt", ready: "What the verifier found" },
  { name: "sample receipt with a declared-total mismatch", path: "/r/demo?demo=mismatch", h1: "Payout receipt", ready: "What the verifier found" },
];

/** A page by its name in PAGES, so a test does not depend on the list's order. */
export function pageNamed(name: string): PageUnderTest {
  const found = PAGES.find((p) => p.name === name);
  if (!found) throw new Error(`no page named ${name} in PAGES`);
  return found;
}

export const VIEWPORTS = [
  { name: "phone 360px", width: 360, height: 740 },
  { name: "desktop 1280px", width: 1280, height: 800 },
] as const;

/** The smallest screen a page is asked to fit: 320px, the width WCAG 2.2 (1.4.10 Reflow) names. Not in VIEWPORTS, which every spec
 * walks: `operator/a11y.spec.ts`, which walks all of the operator's pages, asks for it by name (`responsive.spec.ts` has its own widths). */
export const NARROWEST = { name: "phone 320px", width: 320, height: 568 } as const;

export const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

/** Choose the theme before any page script runs, the way a returning visitor
 * who picked it would have it. */
export async function useTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem("zd:theme", value);
    } catch {
      // A page with no storage (about:blank) has nothing to choose a theme for.
    }
  }, theme);
}

/** Choose who payouts are for before any page script runs (src/lib/audience.ts), the way a returning payer who picked it
 * would have it: the organisation view shows the import, the options, the batches and the auditor's tools. */
export async function useAudience(page: Page, audience: "personal" | "organisation"): Promise<void> {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem("zd:audience", value);
    } catch {
      // A page with no storage (about:blank) has nothing to choose a view for.
    }
  }, audience);
}

/** Open a page and wait until it has finished loading its content. */
export async function open(page: Page, target: PageUnderTest): Promise<void> {
  await page.goto(target.path);
  await page.getByRole("heading", { level: 1, name: target.h1 }).waitFor();
  if (target.ready) await page.getByRole("heading", { name: target.ready }).first().waitFor();
}

/** Everything the page writes to the console as an error or warning, plus
 * uncaught exceptions. Call before navigating; read after. */
export function watchProblems(page: Page): () => string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      problems.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    problems.push(`uncaught: ${error.message}`);
  });
  return () => problems;
}

/** Every URL the page requested, so a test can prove nothing left the origin. */
export function watchRequests(page: Page): () => string[] {
  const urls: string[] = [];
  page.on("request", (request) => {
    urls.push(request.url());
  });
  return () => urls;
}

/** Elements wider than the screen, and sideways scrolling of the page itself. */
export async function overflowReport(page: Page): Promise<{ page: number; wide: string[] }> {
  return await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    wide: [...document.body.querySelectorAll("*")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > window.innerWidth + 1;
      })
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`),
  }));
}

/** WCAG 2.2 A and AA violations on the page as it is now, including colour
 * contrast and target size. Empty means none. */
export async function axeViolations(page: Page, scope?: string) {
  // From the top of the page. The header capsule is sticky, so it covers whatever has been scrolled under it, and an earlier click that
  // scrolled a control into view (Playwright does) would leave some other control half behind it: axe's target-size rule then reports
  // a control that is only covered by where the last click happened to leave the page. What keeps a focused control clear of the capsule
  // is `scroll-padding-top` (index.css), which e2e/island.spec.ts checks.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  const builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
  // `scope`: a selector, to check one part of the page (its colours are still measured against what is behind it).
  const results = await (scope === undefined ? builder : builder.include(scope)).analyze();
  return results.violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    help: v.help,
    targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
    // For colour contrast: the colours axe measured, so a failure says what it saw.
    seen: v.nodes.slice(0, 3).map((n) => {
      const data = n.any[0]?.data as { fgColor?: string; bgColor?: string; contrastRatio?: number } | undefined;
      return data?.fgColor === undefined ? "" : `${data.fgColor} on ${data.bgColor ?? "?"} = ${String(data.contrastRatio)}`;
    }),
  }));
}

/** The header capsule: the one button that is all of the closed header ("ZecDrop Home testnet"). */
export function island(page: Page): Locator {
  return page.locator('[data-slot="island"]');
}

/** The panel the capsule opens: the links and the settings. It is in the page whether it is open or not. */
export function islandPanel(page: Page): Locator {
  return page.locator('[data-slot="island-panel"]');
}

/** Open the header capsule, unless it is open already, and give back its navigation, so a spec reaches a link as a visitor
 * must: `(await openIsland(page)).getByRole("link", { name: "Get paid" })`. The links of a closed capsule are out of the
 * tab order and the accessibility tree, so a spec that does not open it cannot find them. */
export async function openIsland(page: Page): Promise<Locator> {
  const button = island(page);
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  const nav = page.getByRole("navigation", { name: "Primary" });
  await nav.waitFor();
  return nav;
}

/** Choose a link of the header: open the capsule, press the link. It closes on the way. */
export async function chooseFromIsland(page: Page, name: string, options: { exact?: boolean } = {}): Promise<void> {
  const nav = await openIsland(page);
  await nav.getByRole("link", { name, exact: options.exact ?? true }).click();
}

/** Record every text the page shows, from the first moment of every page it loads, so that a spec can say afterwards what was
 * on the screen and what never was. Call it before navigating; call what it gives back after.
 *
 * A wording that is on the screen for a step of a run only cannot be waited for: a spec that looks for it looks away for as long
 * as a slow machine takes between two looks (an accessibility check in between takes seconds), and it comes and goes unseen. The
 * page itself looks at its own DOM after every change to it. What it records is, for each element that holds some text of its
 * own, that element's whole text on one line. */
export async function recordTexts(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen = new Set<string>();
    (window as unknown as { __said: Set<string> }).__said = seen;
    const look = () => {
      const root = document.body;
      for (const element of [root, ...root.querySelectorAll("*")]) {
        if (!Array.from(element.childNodes).some((node) => node.nodeType === 3 && (node.textContent ?? "").trim() !== "")) continue;
        const text = (element.textContent ?? "").replace(/\s+/gu, " ").trim();
        if (text !== "") seen.add(text);
      }
    };
    // Watching the document itself: the page's own scripts have not made a body yet.
    new MutationObserver(() => {
      if (document.body) look();
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  return async () => await page.evaluate(() => [...((window as unknown as { __said?: Set<string> }).__said ?? [])]);
}

/** What is wider than the screen, from the width the layout has (not `innerWidth`, which a phone widens to fit a wide page, and so
 * never says a page is too wide). Empty when nothing is. */
export async function widerThanTheScreen(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const found: string[] = [];
    if (document.documentElement.scrollWidth > width) found.push(`the page scrolls sideways: ${String(document.documentElement.scrollWidth)} in ${String(width)}`);
    for (const el of document.body.querySelectorAll("*")) {
      if (el.closest(".screen-frame, .sr-only") !== null) continue;
      const style = getComputedStyle(el);
      if (style.position === "fixed" || style.visibility === "hidden" || style.display === "none") continue;
      const box = el.getBoundingClientRect();
      if (box.width < 1) continue;
      let clipped = false;
      for (let parent = el.parentElement; parent !== null && parent !== document.body; parent = parent.parentElement) {
        const overflow = getComputedStyle(parent).overflowX;
        if (overflow === "hidden" || overflow === "auto" || overflow === "scroll" || overflow === "clip") {
          clipped = true;
          break;
        }
      }
      if (!clipped && box.right > width + 0.5) found.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}" ends at ${String(Math.round(box.right))} in ${String(width)}`);
    }
    return found.slice(0, 4);
  });
}

/** The capsule is whole and inside the screen. */
export async function capsuleInside(page: Page, width: number): Promise<void> {
  const box = await page.locator(".island").boundingBox();
  expect(box, "the capsule is drawn").not.toBeNull();
  const { x, width: w } = box as { x: number; width: number };
  expect(x, "the capsule starts inside the screen").toBeGreaterThanOrEqual(0);
  expect(x + w, "the capsule ends inside the screen").toBeLessThanOrEqual(width + 0.5);
}
