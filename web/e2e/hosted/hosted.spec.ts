import { execFile, execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

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
const sampleText = readFileSync(join(sampleRoot, sampleDir?.name ?? "", "receipt.json"), "utf8");
const sample = JSON.parse(sampleText) as {
  batches: { txid: string }[];
  manifest_commitment: string;
  declared_total: string;
};
const LIVE_PATH =
  `/r/real-8?network=testnet&tx=${sample.batches[0]?.txid ?? ""}` +
  `&commitment=${sample.manifest_commitment}&declared_total=${sample.declared_total}`;

// The stub answers the same link as a mainnet receipt when it says network=mainnet (e2e/hosted/stub-verifier.mjs),
// with a funding address in mainnet form. The page was built for testnet, as a hosted copy is by default.
const TXID = sample.batches[0]?.txid ?? "";
const MAINNET_PATH =
  `/r/mainnet-8?network=mainnet&tx=${TXID}` +
  `&commitment=${sample.manifest_commitment}&declared_total=${sample.declared_total}`;
const MAINNET_FUNDING_ADDRESS = "t1cFrgk2qsbNHgNSmV8DNauWTCe6EKRLW9L";
// The mainnet explorer's host and paths: DEFAULT_EXPLORER_TX_URL.mainnet and DEFAULT_EXPLORER_ADDRESS_URL.mainnet in src/lib/config.ts.
const MAINNET_EXPLORER = "https://mainnet.zcashexplorer.app";

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

/** The top bar: the header around the primary navigation (a receipt page has a header of its own). */
const topBar = (page: Page) => page.getByRole("navigation", { name: "Primary" }).locator("xpath=ancestor::header");

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

  for (const path of ["/r/demo?demo=real", "/privacy", "/campaigns", "/new/check", "/campaign/c-1", "/audit", "/r/anything/else"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(await response.text(), path).toContain('<div id="root">');
  }
  // Something that is neither a file nor a client route is a 404, not the page.
  expect((await request.get("/nope")).status()).toBe(404);
});

test.describe("the policy breaks nothing", () => {
  const PAGES: [string, string, RegExp][] = [
    ["the home page", "/", /Pay many people\. Keep who got what private\. Prove the total\./u],
    ["the real sample receipt", "/r/demo?demo=real", /Payout receipt/u],
    ["the first real batch", "/r/demo?demo=real-smoke", /Payout receipt/u],
    ["the findings sample", "/r/demo?demo=findings", /Payout receipt/u],
    ["the privacy page", "/privacy", /How privacy works/u],
  ];

  for (const [name, path, heading] of PAGES) {
    test(`${name}: no violation, no console problem`, async ({ page }) => {
      const seen = await watch(page);
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      if (path.startsWith("/r/")) await expect(page.getByRole("heading", { level: 2, name: "Status" })).toBeVisible();
      // Exercise what a page does with scripts and styles: theme switch, copy button.
      await page.getByRole("button", { name: /^Switch to (dark|light) theme$/u }).click();
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
    // A testnet receipt keeps the quiet testnet label.
    await expect(topBar(page).getByText("Zcash testnet", { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(topBar(page).getByText("Zcash mainnet")).toHaveCount(0);
    await page.getByRole("button", { name: "Funding address" }).click();
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

  test("a mainnet receipt link: the loud mainnet label, amounts in ZEC, and links to the mainnet explorer", async ({ page }) => {
    const seen = await watch(page);
    await page.goto(MAINNET_PATH);
    await expect(page.getByRole("heading", { level: 2, name: "Status" })).toBeVisible();
    await expect(page.getByText("Complete: all batches confirmed")).toBeVisible();

    // The header says mainnet, though this copy was built for testnet.
    await expect(topBar(page).getByText("Zcash mainnet", { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(topBar(page).getByText("Zcash testnet")).toHaveCount(0);

    // Amounts are in ZEC, and nothing explains a testnet coin.
    await expect(page.getByTestId("verdict")).toHaveText("Settled: 8 payouts, 0.005 ZEC, fee 0.00045 ZEC");
    expect(await page.locator("main").innerText()).not.toMatch(/TAZ|testnet coin/u);

    // The transaction and the funding address go to the mainnet explorer, and nothing on the page to a testnet one.
    await page.getByRole("button", { name: "Transaction", exact: true }).click();
    const tx = page.locator(`a[href="${MAINNET_EXPLORER}/transactions/${TXID}"]`).first();
    await expect(tx).toBeVisible();
    await expect(tx).toHaveAttribute("target", "_blank");
    await page.getByRole("button", { name: "Funding address" }).click();
    await expect(page.getByTestId("funding-address")).toHaveText("t1cFrgk2…6EKRLW9L");
    await expect(page.getByTestId("funding-section").getByRole("link", { name: /Explorer/u })).toHaveAttribute(
      "href",
      `${MAINNET_EXPLORER}/address/${MAINNET_FUNDING_ADDRESS}`,
    );
    const hrefs = await page.locator("a[href]").evaluateAll((links) => links.map((a) => a.getAttribute("href") ?? ""));
    expect(hrefs.filter((href) => /testnet/u.test(href))).toEqual([]);

    // It asked the stub about mainnet, from the page's own origin, and the answer was accepted as it is.
    const asked = (await stubCalls(page)).filter((c) => c.path === "/v1/receipt" && c.search.includes("network=mainnet"));
    expect(asked.length).toBeGreaterThanOrEqual(1);
    expect(asked[0]?.origin).toBe(SITE);
    await expect(page.getByRole("heading", { name: "The chain and this link don't agree" })).toHaveCount(0);

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
  for (const path of ["/campaigns", "/new", "/new/check", "/campaign/c-000000000001", "/audit"]) {
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
      await expect(nav.getByRole("link", { name: "Payouts" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "New payout" })).toHaveCount(0);
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
  // Without --mainnet-tx it asks nothing about mainnet.
  expect(output).not.toContain("serves mainnet");
});

test.describe("the post-deploy check with --mainnet-tx", () => {
  const run = promisify(execFile);

  /** The check against `verifier`, as its output and exit code (a failing check exits 1, which `execFile` calls an error). */
  async function check(verifier: string, ...extra: string[]) {
    try {
      const { stdout } = await run("node", ["scripts/check-hosted.mjs", "--site", SITE, "--verifier", verifier, ...extra], { cwd: process.cwd(), encoding: "utf8" });
      return { output: stdout, code: 0 };
    } catch (error) {
      const failed = error as { stdout?: string; code?: number };
      return { output: failed.stdout ?? "", code: failed.code ?? -1 };
    }
  }

  /** A verifier of the test's own: the stub's testnet receipt, and whatever the test says to a mainnet request
   * (text is sent as it is, anything else as JSON). Its address is not in the page's policy, so the checks about
   * the policy fail beside the one under test. */
  async function verifierSaying(mainnet: { status: number; body: unknown }) {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://verifier.test");
      const send = (status: number, body: string) => {
        response.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": SITE });
        response.end(body);
      };
      if (url.pathname === "/v1/health") send(200, '{"ok":true}');
      else if (url.pathname !== "/v1/receipt") send(404, "{}");
      else if (url.searchParams.get("network") === "mainnet") {
        send(mainnet.status, typeof mainnet.body === "string" ? mainnet.body : JSON.stringify(mainnet.body));
      } else send(200, sampleText);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    return {
      origin: `http://127.0.0.1:${String(port)}`,
      close: () =>
        new Promise<void>((done) => {
          server.close(() => {
            done();
          });
        }),
    };
  }

  test("a verifier that serves mainnet: one ok line, and every other check still passes", async () => {
    const { output, code } = await check(STUB, "--mainnet-tx", TXID);
    expect(output).not.toMatch(/^FAIL/mu);
    expect(output).toMatch(/^ok {3}the verifier serves mainnet: HTTP 200, phase settled$/mu);
    expect(output.match(/serves mainnet/gu)).toHaveLength(1);
    expect(code).toBe(0);
  });

  test("a verifier that is not set up for mainnet is called that", async () => {
    const verifier = await verifierSaying({
      status: 400,
      body: { error: { code: "network_not_configured", message: "this verifier is not configured for that network" } },
    });
    try {
      const { output, code } = await check(verifier.origin, "--mainnet-tx", TXID);
      expect(output).toMatch(/^FAIL the verifier serves mainnet: verifier is not serving mainnet \(HTTP 400 network_not_configured\)$/mu);
      expect(code).toBe(1);
    } finally {
      await verifier.close();
    }
  });

  test("any other refusal names the status and the code", async () => {
    const verifier = await verifierSaying({ status: 503, body: { error: { code: "chain_unavailable", message: "the chain data source is unavailable" } } });
    try {
      const { output, code } = await check(verifier.origin, "--mainnet-tx", TXID);
      expect(output).toMatch(/^FAIL the verifier serves mainnet: HTTP 503 chain_unavailable$/mu);
      expect(output).not.toContain("not serving mainnet");
      expect(code).toBe(1);
    } finally {
      await verifier.close();
    }
  });

  test("an answer with no code names the status alone, and a 200 without a phase is not an answer", async () => {
    const bare = await verifierSaying({ status: 502, body: "not json" });
    const empty = await verifierSaying({ status: 200, body: { hello: "there" } });
    try {
      expect((await check(bare.origin, "--mainnet-tx", TXID)).output).toMatch(/^FAIL the verifier serves mainnet: HTTP 502$/mu);
      expect((await check(empty.origin, "--mainnet-tx", TXID)).output).toMatch(/^FAIL the verifier serves mainnet: HTTP 200, the answer has no phase$/mu);
    } finally {
      await bare.close();
      await empty.close();
    }
  });

  test("the transaction id must be given, and must be one", () => {
    for (const extra of [["--mainnet-tx"], ["--mainnet-tx", "nope"], ["--mainnet-tx", TXID.toUpperCase()]]) {
      const result = spawnSync("node", ["scripts/check-hosted.mjs", "--site", SITE, "--verifier", STUB, ...extra], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status, extra.join(" ")).toBe(2);
      expect(result.stderr, extra.join(" ")).toContain("--mainnet-tx needs a transaction id");
      expect(result.stdout, extra.join(" ")).toBe("");
    }
  });
});
