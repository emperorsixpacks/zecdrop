import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { axeViolations, overflowReport, THEMES, useTheme, VIEWPORTS } from "../helpers.js";

// A public copy of the app, built the way a deployment is built and served WITH
// the headers and rewrites of the vercel.json made for it (scripts/hosted-config.mjs,
// scripts/serve-hosted.mjs), talking to a stub verifier on another origin. It
// checks that the Content-Security-Policy breaks nothing, that it is really in
// force, that the operator pages explain themselves, and that the post-deploy
// check passes. Nothing is deployed.

const SITE = "http://127.0.0.1:4174";
const STUB = "http://127.0.0.1:4175";

const sampleRoot = resolve(process.cwd(), "..", "fixtures", "testnet-ironwood-batch-8");
const [sampleDir] = readdirSync(sampleRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[0-9a-f]{64}$/u.test(e.name));
const sample = JSON.parse(readFileSync(join(sampleRoot, sampleDir?.name ?? "", "receipt.json"), "utf8")) as {
  batches: { txid: string }[];
  manifest_commitment: string;
  declared_total: string;
};
const LIVE_PATH =
  `/r/real-8?network=testnet&tx=${sample.batches[0]?.txid ?? ""}` +
  `&commitment=${sample.manifest_commitment}&declared_total=${sample.declared_total}`;

/** Record every Content-Security-Policy violation the page reports, and every console problem. */
async function watch(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problems.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __spv: string[] }).__spv = seen;
    document.addEventListener("securitypolicyviolation", (e) => {
      seen.push(`${e.violatedDirective} blocked ${e.blockedURI || "(inline)"} from ${e.sourceFile || "the page"}`);
    });
  });
  return {
    problems: () => problems,
    violations: () => page.evaluate(() => (window as unknown as { __spv: string[] }).__spv),
  };
}

const stubCalls = async (page: Page): Promise<{ method: string; path: string; search: string; origin: string | null }[]> =>
  (await (await page.request.get(`${STUB}/__calls`)).json()) as never;

test("the page is served with the security headers and the policy names the stub verifier", async ({ request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  const headers = response.headers();
  const csp = headers["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain(`connect-src 'self' ${STUB}`);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).not.toMatch(/unsafe-|\*/u);
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
});

test("a built asset is cached as immutable, and client routes are rewritten to the page", async ({ request }) => {
  const html = await (await request.get("/")).text();
  const asset = /\/assets\/[^"']+\.js/u.exec(html)?.[0] ?? "";
  expect(asset).not.toBe("");
  const file = await request.get(asset);
  expect(file.status()).toBe(200);
  expect(file.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");

  for (const path of ["/r/demo?demo=real", "/privacy", "/campaigns", "/new/basics", "/campaign/c-1", "/audit", "/r/anything/else"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(await response.text(), path).toContain('<div id="root">');
  }
  // Something that is neither a file nor a client route is a 404, not the page.
  expect((await request.get("/nope")).status()).toBe(404);
});

test.describe("the policy breaks nothing", () => {
  const PAGES: [string, string, RegExp][] = [
    ["the home page", "/", /Private amounts\. Public accountability\./u],
    ["the real sample receipt", "/r/demo?demo=real", /Payout receipt/u],
    ["the first real batch", "/r/demo?demo=real-smoke", /Payout receipt/u],
    ["the findings sample", "/r/demo?demo=findings", /Payout receipt/u],
    ["the privacy page", "/privacy", /What is public, what is private/u],
  ];

  for (const [name, path, heading] of PAGES) {
    test(`${name}: no violation, no console problem`, async ({ page }) => {
      const seen = await watch(page);
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      if (path.startsWith("/r/")) await expect(page.getByRole("heading", { level: 2, name: "Status" })).toBeVisible();
      // Exercise what a page does with scripts and styles: theme switch, copy button.
      await page.getByRole("button", { name: "Light theme" }).click();
      expect(await seen.violations(), "securitypolicyviolation events").toEqual([]);
      expect(seen.problems()).toEqual([]);
    });
  }

  test("a live receipt link calls the verifier on its own origin, and the policy lets it", async ({ page }) => {
    const seen = await watch(page);
    await page.goto(LIVE_PATH);
    await expect(page.getByRole("heading", { level: 2, name: "Status" })).toBeVisible();
    await expect(page.getByText("Complete: all batches confirmed")).toBeVisible();
    await expect(page.getByRole("heading", { name: "What the verifier found" })).toHaveCount(0);
    await expect(page.getByTestId("funding-address")).toHaveText("tmU6c1aX…B3nkZGkD");

    const calls = await stubCalls(page);
    const receiptCalls = calls.filter((c) => c.path === "/v1/receipt");
    expect(receiptCalls.length).toBeGreaterThanOrEqual(1);
    expect(receiptCalls[0]?.origin).toBe(SITE);
    expect(receiptCalls[0]?.search).toContain(`tx=${sample.batches[0]?.txid ?? ""}`);
    // And it asked for nothing but the receipt: no operator route.
    expect(calls.filter((c) => !["/v1/receipt", "/v1/health"].includes(c.path))).toEqual([]);

    expect(await seen.violations(), "securitypolicyviolation events").toEqual([]);
    expect(seen.problems()).toEqual([]);
  });

  test("(control) the policy is really in force: a request to any other origin is blocked and reported", async ({ page }) => {
    const seen = await watch(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const outcome = await page.evaluate(async () => {
      try {
        await fetch("http://127.0.0.1:4176/elsewhere");
        return "allowed";
      } catch {
        return "blocked";
      }
    });
    expect(outcome).toBe("blocked");
    const violations = await seen.violations();
    expect(violations.some((v) => v.startsWith("connect-src blocked http://127.0.0.1:4176"))).toBe(true);
  });
});

test.describe("the operator pages on a public copy", () => {
  for (const path of ["/campaigns", "/new", "/new/basics", "/campaign/c-000000000001", "/audit"]) {
    test(`${path} explains that the operator runs on your own machine, and calls nothing`, async ({ page }) => {
      const seen = await watch(page);
      const requested: string[] = [];
      page.on("request", (r) => requested.push(r.url()));
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: "Run the operator on your own machine" })).toBeVisible();
      await expect(page.getByText("Nothing on this hosted page can create, fund or send a payout.")).toBeVisible();
      // No operator screens, no menu of them, no call to any API.
      await expect(page.getByRole("heading", { name: "Open the operator link" })).toHaveCount(0);
      const nav = page.getByRole("navigation", { name: "Primary" });
      await expect(nav.getByRole("link", { name: "New campaign" })).toHaveCount(0);
      expect(requested.filter((u) => u.includes("/api/") || u.startsWith(STUB))).toEqual([]);
      expect(await seen.violations()).toEqual([]);
      expect(seen.problems()).toEqual([]);
    });
  }

  test("it links to the sample receipt and the privacy boundary", async ({ page }) => {
    await page.goto("/audit");
    await page.getByRole("link", { name: "See a sample receipt" }).click();
    await expect(page).toHaveURL(/\/r\/demo\?demo=real$/u);
    await expect(page.getByRole("heading", { level: 2, name: "Status" })).toBeVisible();
  });
});

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`explainer, ${viewport.name}, ${theme} theme`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      test("fits the screen and has no accessibility violations", async ({ page }) => {
        await useTheme(page, theme);
        await page.goto("/campaigns");
        await expect(page.getByRole("heading", { level: 1, name: "Run the operator on your own machine" })).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const overflow = await overflowReport(page);
        expect(overflow.wide).toEqual([]);
        expect(overflow.page).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
      });
    });
  }
}

test("the post-deploy check passes against this deployment and its verifier", () => {
  const output = execFileSync("node", ["scripts/check-hosted.mjs", "--site", SITE, "--verifier", STUB], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  expect(output).not.toMatch(/^FAIL/mu);
  expect(output).toContain("ok   the verifier answers the real batch's receipt");
  expect(output).toContain(`shareable link: ${SITE}/r/real-8?network=testnet&tx=${sample.batches[0]?.txid ?? ""}`);
});
