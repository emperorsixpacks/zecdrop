import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";

export interface PageUnderTest {
  name: string;
  path: string;
  /** Text of the page's one <h1>. */
  h1: string;
  /** For pages that load data: a heading that appears once it has. */
  ready?: string;
}

export const PAGES: readonly PageUnderTest[] = [
  { name: "home", path: "/", h1: "Pay many people. Keep who got what private. Prove the total." },
  { name: "real testnet sample receipt", path: "/r/demo?demo=real", h1: "Payout receipt", ready: "Status" },
  { name: "first real testnet batch", path: "/r/demo?demo=real-smoke", h1: "Payout receipt", ready: "Status" },
  { name: "sample receipt", path: "/r/demo?demo=1", h1: "Payout receipt", ready: "Status" },
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
export async function axeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
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
