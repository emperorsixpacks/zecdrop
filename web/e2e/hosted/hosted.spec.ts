import { execFile, execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { expect, test, type Page, type Response } from "@playwright/test";

import { TOUR_LOOKS, TOUR_SHOTS, TOUR_WIDTH, tourImageSrc } from "../../src/features/home/tour-steps.js";
import { axeViolations, island, openIsland, overflowReport, THEMES, useTheme, VIEWPORTS } from "../helpers.js";
import { dumpBrowserState } from "../operator/privacy.js";
import { decodeScreenshot } from "../qr.js";

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
// Payslip 3 of the same batch, which the stub verifier knows to be true (e2e/hosted/stub-verifier.mjs).
const payslipText = readFileSync(join(sampleRoot, sampleDir?.name ?? "", "payslips", "payslip-3.json"), "utf8");
const payslip = JSON.parse(payslipText) as { txid: string; receiver: string; rseed: string; value: string; network: string; action: number; version: number };
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

test("the paper's grain is a file of the site's own, served as an image, and the unchanged policy lets the page draw it", async ({ page, request }) => {
  // The grain (public/grain.png) is the one picture the page draws from a file; the policy has no img-src of its own, so it falls to
  // default-src 'self'. A data: address would have been refused, which is why it is a file.
  const seen = await watch(page);
  const grain = page.waitForResponse((response) => response.url() === `${SITE}/grain.png`);
  await page.goto("/");
  const response = await grain;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/png");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await seen.violations(), "a Content-Security-Policy violation").toEqual([]);
  expect(seen.problems()).toEqual([]);
  // It is drawn: the stylesheet's own rule names it, and the browser has it (a blocked image is not complete).
  const drawn = await page.evaluate(async () => {
    const style = getComputedStyle(document.body, "::before");
    const url = /url\("([^"]+)"\)/u.exec(style.backgroundImage)?.[1] ?? "";
    const image = new Image();
    image.src = url;
    await image.decode();
    return { url, width: image.naturalWidth, height: image.naturalHeight };
  });
  expect(drawn).toEqual({ url: `${SITE}/grain.png`, width: 128, height: 128 });
  expect((await request.get("/grain.png")).headers()["cache-control"]).toBe("public, max-age=0, must-revalidate");
});

test("a built asset is cached as immutable, and client routes are rewritten to the page", async ({ request }) => {
  const html = await (await request.get("/")).text();
  const asset = /\/assets\/[^"']+\.js/u.exec(html)?.[0] ?? "";
  expect(asset).not.toBe("");
  const file = await request.get(asset);
  expect(file.status()).toBe(200);
  expect(file.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");

  for (const path of ["/r/demo?demo=real", "/privacy", "/payslip", "/get-paid", "/campaigns", "/new/check", "/campaign/c-1", "/audit", "/r/anything/else"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(await response.text(), path).toContain('<div id="root">');
  }
  // Something that is neither a file nor a client route is a 404, not the page.
  expect((await request.get("/nope")).status()).toBe(404);
});

test("every picture of the home page tour is served as an image, not rewritten to the page", async ({ request }) => {
  for (const shot of TOUR_SHOTS) {
    for (const look of TOUR_LOOKS) {
      const path = tourImageSrc(shot, look);
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      expect(response.headers()["content-type"], path).toBe("image/webp");
      expect(response.headers()["x-content-type-options"], path).toBe("nosniff");
      expect(response.headers()["cache-control"], path).toBe("public, max-age=0, must-revalidate");
      expect((await response.body()).subarray(0, 4).toString("ascii"), path).toBe("RIFF");
    }
  }
});

test.describe("the policy breaks nothing", () => {
  const PAGES: [string, string, RegExp][] = [
    ["the home page", "/", /Pay many people\. Keep who got what private\. Prove the total\./u],
    ["the real sample receipt", "/r/demo?demo=real", /Payout receipt/u],
    ["the first real batch", "/r/demo?demo=real-smoke", /Payout receipt/u],
    ["the findings sample", "/r/demo?demo=findings", /Payout receipt/u],
    ["the privacy page", "/privacy", /How privacy works/u],
    ["the payslip page", "/payslip", /Check a payslip/u],
    ["the get-paid page", "/get-paid", /Get paid in ZEC/u],
  ];

  for (const [name, path, heading] of PAGES) {
    test(`${name}: no violation, no console problem`, async ({ page }) => {
      const seen = await watch(page);
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      if (path.startsWith("/r/")) await expect(page.getByRole("heading", { level: 2, name: "Status" })).toBeVisible();
      // Exercise what a page does with scripts and styles: the header capsule opening, the theme switch in it.
      await openIsland(page);
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
    // A testnet receipt keeps the quiet testnet label on the capsule, and says it in full in the open panel.
    await expect(island(page).getByText("testnet", { exact: true })).toBeVisible();
    await expect(island(page).getByText("Mainnet")).toHaveCount(0);
    await openIsland(page);
    await expect(page.getByText("Zcash testnet", { exact: true })).toBeVisible();
    await expect(page.getByText("Zcash mainnet")).toHaveCount(0);
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

    // The header says mainnet, though this copy was built for testnet: on the capsule, without opening anything, and in full in the panel.
    await expect(island(page).getByText("Mainnet", { exact: true })).toBeVisible();
    await expect(island(page).getByText("testnet")).toHaveCount(0);
    await openIsland(page);
    await expect(page.getByText("Zcash mainnet", { exact: true })).toBeVisible();
    await expect(page.getByText("Zcash testnet")).toHaveCount(0);

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

  test("the home page's tour pictures load under the policy, with no violation", async ({ page }) => {
    const seen = await watch(page);
    // Listen before the page loads: a picture near the first screen is asked for at once.
    const answers: Response[] = [];
    page.on("response", (answer) => answers.push(answer));
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const first = page.locator("section[aria-labelledby='tour-heading'] img").first();
    const expected = tourImageSrc(TOUR_SHOTS[0] ?? { id: "never" }, "light");
    await first.scrollIntoViewIfNeeded();
    await expect.poll(() => answers.some((answer) => new URL(answer.url()).pathname === expected)).toBe(true);
    const response = answers.find((answer) => new URL(answer.url()).pathname === expected) as Response;
    // From the page's own origin, as an image, under a policy that names no img-src (default-src 'self' rules).
    expect(new URL(response.url()).origin).toBe(SITE);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/webp");
    const csp = response.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("img-src");
    await expect.poll(() => first.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth)).toBe(TOUR_WIDTH);
    expect(await seen.violations(), "securitypolicyviolation events").toEqual([]);
    expect(seen.problems()).toEqual([]);
  });

  test("(control) the policy covers pictures too: one from any other origin is blocked and reported", async ({ page }) => {
    const seen = await watch(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.evaluate(() => {
      const image = new Image();
      image.src = "http://127.0.0.1:4176/elsewhere.webp";
      document.body.append(image);
    });
    await expect.poll(async () => (await seen.violations()).some((v) => v.startsWith("img-src blocked http://127.0.0.1:4176"))).toBe(true);
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

test.describe("the payslip page on a public copy", () => {
  // The density of a phone's screen, which is what a code on it is drawn at.
  test.use({ deviceScaleFactor: 2 });

  /** Every request to the verifier, as the browser made it. */
  function watchVerifier(page: Page) {
    const sent: { method: string; url: string; type: string | undefined; body: string | null; cookie: boolean }[] = [];
    page.on("request", (r) => {
      if (r.url().startsWith(STUB)) {
        sent.push({ method: r.method(), url: r.url(), type: r.headers()["content-type"], body: r.postData(), cookie: "cookie" in r.headers() });
      }
    });
    return sent;
  }

  test("checks the sample against the verifier on its own origin and sees Verified, then the changed copy fails, and the policy reports nothing", async ({ page }) => {
    const seen = await watch(page);
    const sent = watchVerifier(page);
    await page.goto("/payslip");
    await expect(page.getByRole("heading", { level: 1, name: "Check a payslip" })).toBeVisible();
    const before = await page.getByTestId("not-proven").getByRole("listitem").allInnerTexts();
    expect(before).toHaveLength(5);

    await page.getByRole("button", { name: "Load a sample" }).click();
    await expect(page.getByLabel("Payslip", { exact: true })).toHaveValue(payslipText);
    await page.getByRole("button", { name: "Check payslip" }).click();
    const verified = page.getByRole("heading", { level: 2, name: "Verified", exact: true });
    await expect(verified).toBeVisible();
    await expect(verified).toBeFocused();
    const result = page.getByTestId("payslip-result");
    await expect(result).toContainText("Action 5 of this transaction pays the receiver and amount this payslip states.");
    await expect(result).toContainText("0.0009 TAZ");
    await expect(result).toContainText("19 (final at 3)");
    await expect(result.getByRole("link", { name: /Open in the explorer/u })).toHaveAttribute("href", `https://testnet.zecblock.com/tx/${payslip.txid}`);
    // What is not proven is the verifier's own list now, and it is the list the page showed before.
    expect(await page.getByTestId("not-proven").getByRole("listitem").allInnerTexts()).toEqual(before);

    await page.getByRole("button", { name: "Load a changed copy" }).click();
    await page.getByRole("button", { name: "Check payslip" }).click();
    const failed = page.getByRole("heading", { level: 2, name: "Not verified", exact: true });
    await expect(failed).toBeVisible();
    await expect(failed).toBeFocused();
    await expect(page.getByText("This payslip does not match what that output of the transaction holds.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Verified", exact: true })).toHaveCount(0);

    // The browser sent two POSTs of JSON to the verifier and nothing else: the payslip is the body, whole,
    // and the second is the first with the amount one zatoshi higher.
    const posts = sent.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      expect(new URL(post.url).origin).toBe(STUB);
      expect(new URL(post.url).pathname).toBe("/v1/payslip");
      expect(new URL(post.url).search).toBe("");
      expect(post.type).toBe("application/json");
      expect(post.cookie).toBe(false);
    }
    expect(JSON.parse(posts[0]?.body ?? "null")).toEqual(payslip);
    expect(JSON.parse(posts[1]?.body ?? "null")).toEqual({ ...payslip, value: String(BigInt(payslip.value) + 1n) });
    expect(sent.filter((r) => r.method !== "POST" && r.method !== "OPTIONS")).toEqual([]);

    // The page asked the verifier about nothing but the payslip.
    expect([...new Set(sent.map((r) => new URL(r.url).pathname))]).toEqual(["/v1/payslip"]);

    // The stub saw the preflight a browser sends before a JSON POST, from the page's origin, and the POSTs; no call
    // carried a query. (The stub serves every test of this project at once, so this is only what is true of any call.)
    const asked = (await stubCalls(page)).filter((c) => c.path === "/v1/payslip");
    expect(asked.filter((c) => c.method === "POST").length).toBeGreaterThanOrEqual(2);
    expect(asked.some((c) => c.method === "OPTIONS" && c.origin === SITE)).toBe(true);
    expect(asked.every((c) => c.origin === SITE && c.search === "")).toBe(true);

    expect(await seen.violations(), "securitypolicyviolation events").toEqual([]);
    expect(seen.problems()).toEqual([]);
  });

  test("opens from a link under the policy: the payslip is in the box, the fragment is gone, nothing is asked until it is, and the stub answers the check", async ({ page }) => {
    const seen = await watch(page);
    const sent = watchVerifier(page);
    const value = Buffer.from(
      JSON.stringify({ version: payslip.version, network: payslip.network, txid: payslip.txid, action: payslip.action, receiver: payslip.receiver, value: payslip.value, rseed: payslip.rseed }),
    ).toString("base64url");
    await page.goto(`/payslip#payslip=${value}`);
    await expect(page.getByLabel("Payslip", { exact: true })).toHaveValue(payslipText);
    await expect(page.getByText("This payslip came from a link. Whoever has that link has the payslip: its receiver, its amount and the key to its memo.")).toBeVisible();
    // The fragment left the address bar, and the verifier has not been asked a thing.
    expect(page.url()).toBe(`${SITE}/payslip`);
    expect(sent).toEqual([]);

    // The link and a QR code of it are made in the page, under the policy: the code is drawn inline, and the library comes from this origin.
    await page.getByRole("button", { name: "Make a link" }).click();
    const link = await page.getByLabel("Payslip link", { exact: true }).inputValue();
    expect(link).toBe(`${SITE}/payslip#payslip=${value}`);
    await page.getByRole("button", { name: "Show QR code" }).click();
    const qr = page.getByRole("img", { name: "QR code of the payslip link" });
    await expect(qr).toBeVisible();
    expect(decodeScreenshot(await qr.screenshot())).toBe(link);
    expect(sent).toEqual([]);

    // Asked, the stub verifier answers: one POST, with the payslip as its body.
    await page.getByRole("button", { name: "Check payslip" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Verified", exact: true })).toBeFocused();
    const posts = sent.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]?.body ?? "null")).toEqual(payslip);
    expect(new URL(posts[0]?.url ?? "").search).toBe("");
    expect(page.url()).toBe(`${SITE}/payslip`);

    expect(await seen.violations(), "securitypolicyviolation events").toEqual([]);
    expect(seen.problems()).toEqual([]);
  });

  test("a link that holds no payslip loads nothing and leaves the address bar bare, under the policy", async ({ page }) => {
    const seen = await watch(page);
    const sent = watchVerifier(page);
    await page.goto("/payslip#payslip=%%%");
    await expect(page.getByRole("alert")).toHaveText("This link does not hold a payslip this page can read. Nothing was loaded.");
    await expect(page.getByLabel("Payslip", { exact: true })).toHaveValue("");
    expect(page.url()).toBe(`${SITE}/payslip`);
    expect(sent).toEqual([]);
    expect(await seen.violations(), "securitypolicyviolation events").toEqual([]);
  });

  test("keeps the payslip nowhere in the browser", async ({ page }) => {
    await page.goto("/payslip");
    await page.getByRole("button", { name: "Load a sample" }).click();
    await page.getByRole("button", { name: "Check payslip" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Verified", exact: true })).toBeVisible();
    const kept = await dumpBrowserState(page);
    for (const secret of [payslip.receiver, payslip.rseed]) {
      expect(kept).not.toContain(secret);
      expect(page.url()).not.toContain(secret);
    }
    expect(page.url()).toBe(`${SITE}/payslip`);
  });

  test("(control) a payslip cannot be posted to any other origin: the policy blocks it and reports it", async ({ page }) => {
    const seen = await watch(page);
    await page.goto("/payslip");
    await page.getByRole("button", { name: "Load a sample" }).click();
    // A page built for another verifier would ask one the policy does not name.
    const outcome = await page.evaluate(async (body) => {
      try {
        await fetch("http://127.0.0.1:4176/v1/payslip", { method: "POST", headers: { "Content-Type": "application/json" }, body });
        return "allowed";
      } catch {
        return "blocked";
      }
    }, JSON.stringify(payslip));
    expect(outcome).toBe("blocked");
    // The browser reports the violation a moment after the request fails.
    await expect.poll(async () => (await seen.violations()).some((v) => v.startsWith("connect-src blocked http://127.0.0.1:4176"))).toBe(true);
  });

  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      test(`the result fits the screen and has no accessibility violation (${viewport.name}, ${theme} theme)`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await useTheme(page, theme);
        await page.goto("/payslip");
        await page.getByRole("button", { name: "Load a sample" }).click();
        await page.getByRole("button", { name: "Check payslip" }).click();
        await expect(page.getByRole("heading", { level: 2, name: "Verified", exact: true })).toBeVisible();
        const overflow = await overflowReport(page);
        expect(overflow.wide).toEqual([]);
        expect(overflow.page).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
      });
    }
  }
});

test.describe("the get-paid page on a public copy", () => {
  // A unified address of the right shape (it is not anyone's), and a share sheet that takes whatever it is given.
  const ADDRESS = `u1${"qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(4).slice(0, 104)}`;

  test("loads under the policy, takes an address, shares and copies it, and asks no one for anything", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const seen = await watch(page);
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "share", { configurable: true, value: () => Promise.resolve() });
    });
    await page.goto("/get-paid");
    await expect(page.getByRole("heading", { level: 1, name: "Get paid in ZEC" })).toBeVisible();
    // A font is fetched the first time a letter of it is drawn, so draw the box's once before counting.
    await page.getByLabel("Your address").fill(ADDRESS);
    await page.getByLabel("Your address").fill("");
    await page.waitForLoadState("networkidle");
    const loaded = requests.length;

    await page.getByLabel("Your address").fill(ADDRESS);
    await expect(page.getByTestId("shape")).toHaveAttribute("data-kind", "mainnet_unified");
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(page.getByTestId("share-feedback")).toHaveText("Address copied.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ADDRESS);
    await page.waitForLoadState("networkidle");

    // Every request was to the page's own origin, none after it had loaded, and none to the verifier.
    expect(requests.filter((url) => !url.startsWith(SITE) && !url.startsWith("data:"))).toEqual([]);
    expect(requests.slice(loaded)).toEqual([]);
    expect(requests.filter((url) => url.startsWith(STUB))).toEqual([]);
    expect(requests.join(" ")).not.toContain(ADDRESS);
    expect(page.url()).toBe(`${SITE}/get-paid`);
    expect(await dumpBrowserState(page)).not.toContain(ADDRESS);

    expect(await seen.violations(), "securitypolicyviolation events").toEqual([]);
    expect(seen.problems()).toEqual([]);
  });

  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      test(`fits the screen and has no accessibility violation, with an address pasted (${viewport.name}, ${theme} theme)`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await useTheme(page, theme);
        await page.goto("/get-paid");
        await page.getByLabel("Your address").fill(ADDRESS);
        await expect(page.getByTestId("shape")).toHaveAttribute("data-kind", "mainnet_unified");
        const overflow = await overflowReport(page);
        expect(overflow.wide).toEqual([]);
        expect(overflow.page).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
      });
    }
  }
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
      // No operator screens, no menu of them, no call to any API. The capsule does not call the notice "Payouts" either.
      await expect(page.getByRole("heading", { name: "Open the operator link" })).toHaveCount(0);
      await expect(island(page)).toHaveAccessibleName("ZecDrop testnet");
      const nav = await openIsland(page);
      await expect(nav.getByRole("link", { name: "How privacy works" })).toBeVisible();
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

// Practice mode on a public copy (openspec REQ-DEMO-001): the operator's screens against a simulation inside the page. It makes
// no request, so it needs no allowance: the policy a public copy is served with is the one it always had, and a whole practice
// payout runs under it with no violation, with nothing asked of the stub verifier or of anyone, and with only the app's own
// static files fetched (the simulation's own chunk is one of them, fetched when practice mode is asked for).
test.describe("practice mode on a public copy", () => {
  /** The policy as `scripts/hosted-config.mjs` writes it for this build, word for word: if practice mode ever needed it loosened,
   * this is where that would be seen. */
  const POLICY = `default-src 'self'; connect-src 'self' ${STUB}; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`;
  const FLAG = "zecdrop.practice";
  const staticFile = (href: string): boolean => {
    const url = new URL(href);
    // The site's own static files: the page, its code and fonts, the tour's pictures, the icon, and the paper's grain (public/grain.png).
    return url.origin === SITE && (url.pathname === "/" || /^\/(assets|tour)\//u.test(url.pathname) || /^\/favicon\./u.test(url.pathname) || url.pathname === "/grain.png");
  };

  test("a whole practice payout runs under the unchanged policy: no violation, and nothing asked of the verifier or of anyone", async ({ page }) => {
    test.setTimeout(90_000);
    const seen = await watch(page);
    const requested: string[] = [];
    page.on("request", (r) => requested.push(r.url()));

    const response = await page.goto("/");
    expect(response?.headers()["content-security-policy"]).toBe(POLICY);
    await expect(page.getByRole("heading", { level: 1, name: /Pay many people/u })).toBeVisible();
    // Before it is asked for, practice mode is not fetched.
    expect(requested.some((url) => /\/assets\/simulation-/u.test(url))).toBe(false);

    await page.getByRole("button", { name: "Try a practice payout" }).click();
    // On a public copy the operator's screens open, instead of the explanation they show without practice mode.
    await expect(page.getByRole("heading", { level: 1, name: "Add the payouts" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Run the operator on your own machine" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Practice mode", exact: true })).toBeVisible();
    expect(requested.some((url) => /\/assets\/simulation-/u.test(url))).toBe(true);

    await page.getByRole("button", { name: "Use the example list" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Check the payouts" })).toBeVisible();
    await page.getByRole("link", { name: "Looks right, continue" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Fund and send" })).toBeVisible();
    await page.getByRole("button", { name: "Record mock deposit" }).click();
    await expect(page.getByText("Funded.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Send 8 payouts" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Send 8 payouts" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "All 1 batch is confirmed" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("link", { name: "Open public receipt" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Payout receipt" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Status" })).toBeAttached();
    await expect(page.getByText("A practice receipt")).toBeVisible();

    // The policy was never broken, nothing was reported, and the stub verifier was not called, nor was anything else but
    // the app's own files.
    expect(await seen.violations()).toEqual([]);
    expect(seen.problems()).toEqual([]);
    expect(requested.filter((url) => url.startsWith(STUB))).toEqual([]);
    expect(requested.filter((url) => !staticFile(url))).toEqual([]);
    expect((await page.evaluate(() => Object.keys(sessionStorage)))).toEqual([FLAG]);
  });

  test("a tab that was in practice mode opens the operator pages, and a tab that was not still gets the explanation", async ({ page, browser }) => {
    await page.addInitScript((flag) => {
      sessionStorage.setItem(flag, "1");
    }, FLAG);
    await page.goto("/campaigns");
    await expect(page.getByRole("heading", { level: 1, name: "Payouts" })).toBeVisible();
    await expect(page.getByTestId("payouts-empty")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Run the operator on your own machine" })).toHaveCount(0);

    // A tab of its own has no flag: the same address is the explanation.
    const other = await browser.newPage();
    try {
      await other.goto(`${SITE}/campaigns`);
      await expect(other.getByRole("heading", { level: 1, name: "Run the operator on your own machine" })).toBeVisible();
    } finally {
      await other.close();
    }
  });

  test("leaving it puts the explanation back", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Try it yourself in practice mode" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Add the payouts" })).toBeVisible();
    await page.getByRole("region", { name: "Practice mode", exact: true }).getByRole("button", { name: "Leave practice mode" }).click();
    await expect(page.getByRole("heading", { level: 1, name: /Pay many people/u })).toBeVisible();
    await expect(page.getByRole("region", { name: "Practice mode", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Running a payout? Open the operator app" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Run the operator on your own machine" })).toBeVisible();
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
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
  expect(output).toContain("ok   /tour/receipt-light.webp is served as an image: 200 image/webp");
  expect(output).toContain(`shareable link: ${SITE}/r/real-8?network=testnet&tx=${sample.batches[0]?.txid ?? ""}`);
  // Without --mainnet-tx it asks nothing about mainnet.
  expect(output).not.toContain("serves mainnet");
});

test.describe("the post-deploy check with --payslip", () => {
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

  interface Behaviour {
    /** Whether the payslip route exists. */
    route?: boolean;
    /** Whether the preflight lets this site POST a content-type. */
    cors?: boolean;
    /** What it answers a payslip with: its status and body. */
    says: (slip: Record<string, unknown>) => { status: number; body: unknown };
  }

  /** The answer the real verifier gives for a payslip that checks out. */
  const answered = (slip: Record<string, unknown>, change: Record<string, unknown> = {}) => ({
    network: slip["network"],
    txid: slip["txid"],
    action: slip["action"],
    verdict: "verified",
    reason: null,
    confirmations: 19,
    required_depth: 3,
    ironwood_actions: 8,
    not_proven: ["The memo. The note commitment does not cover it."],
    ...change,
  });

  /** A verifier of the test's own: the stub's testnet receipt, and a payslip route that behaves as the test says.
   * Its address is not in the page's policy, so the checks about the policy fail beside the one under test. */
  async function verifierWith(behaviour: Behaviour) {
    const { route = true, cors = true, says } = behaviour;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://verifier.test");
      const send = (status: number, body: string, headers: Record<string, string> = {}) => {
        response.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": SITE, ...headers });
        response.end(body);
      };
      if (url.pathname === "/v1/health") send(200, '{"ok":true}');
      else if (url.pathname === "/v1/receipt") send(200, sampleText);
      else if (url.pathname === "/v1/payslip" && route && request.method === "OPTIONS") {
        response.writeHead(cors ? 204 : 200, cors ? { "Access-Control-Allow-Origin": SITE, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "content-type" } : {});
        response.end();
      } else if (url.pathname === "/v1/payslip" && route) {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const reply = says(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
          send(reply.status, JSON.stringify(reply.body));
        });
      } else send(404, "{}");
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

  /** The check against a verifier that behaves as said, then the verifier is closed. */
  async function against(behaviour: Behaviour) {
    const verifier = await verifierWith(behaviour);
    try {
      return await check(verifier.origin, "--payslip");
    } finally {
      await verifier.close();
    }
  }

  const truth = (slip: Record<string, unknown>) => slip["value"] === payslip.value;
  const honest = (slip: Record<string, unknown>) =>
    truth(slip)
      ? { status: 200, body: answered(slip) }
      : { status: 200, body: answered(slip, { verdict: "invalid", reason: "does_not_match", confirmations: null, ironwood_actions: null }) };

  test("a verifier that checks payslips: three ok lines, no secret printed, and every other check still passes", async () => {
    const { output, code } = await check(STUB, "--payslip");
    expect(output).not.toMatch(/^FAIL/mu);
    expect(output).toMatch(/^ok {3}the verifier lets this site POST a payslip \(CORS preflight\): 204$/mu);
    expect(output).toMatch(/^ok {3}the verifier checks the real batch's payslip: verified, 19 confirmation\(s\), final at 3$/mu);
    expect(output).toMatch(/^ok {3}the verifier refuses the same payslip with the amount changed: invalid, does_not_match$/mu);
    for (const secret of [payslip.receiver, payslip.rseed]) expect(output).not.toContain(secret);
    expect(output).toContain("ok   client route /payslip: 200");
    expect(code).toBe(0);
  });

  test("without --payslip it asks nothing about payslips", async () => {
    const { output } = await check(STUB);
    expect(output).not.toContain("POST a payslip");
    expect(output).not.toContain("the real batch's payslip");
  });

  test("a payslip that is not final yet is pending, and that is an ok line too", async () => {
    const { output } = await against({ says: (slip) => (truth(slip) ? { status: 200, body: answered(slip, { verdict: "pending", confirmations: 1 }) } : honest(slip)) });
    expect(output).toMatch(/^ok {3}the verifier checks the real batch's payslip: pending, 1 confirmation\(s\), final at 3$/mu);
  });

  test("a verifier without the payslip route fails the preflight and the check, and says the status", async () => {
    const { output, code } = await against({ route: false, says: honest });
    expect(output).toMatch(/^FAIL the verifier lets this site POST a payslip \(CORS preflight\): HTTP 404, .*allow-methods none, allow-headers none$/mu);
    expect(output).toMatch(/^FAIL the verifier checks the real batch's payslip: HTTP 404$/mu);
    expect(output).not.toContain("refuses the same payslip");
    expect(code).toBe(1);
  });

  test("a verifier whose preflight does not let this site POST fails that line only", async () => {
    const { output } = await against({ cors: false, says: honest });
    expect(output).toMatch(/^FAIL the verifier lets this site POST a payslip \(CORS preflight\): HTTP 200, allow-origin none/mu);
    expect(output).toMatch(/^ok {3}the verifier checks the real batch's payslip: verified/mu);
  });

  test("a verifier that is not set up for the payslip's network is called that", async () => {
    const { output } = await against({ says: () => ({ status: 400, body: { error: { code: "network_not_configured", message: "x" } } }) });
    expect(output).toMatch(/^FAIL the verifier checks the real batch's payslip: verifier is not serving testnet \(HTTP 400 network_not_configured\)$/mu);
  });

  test("a verifier that cannot read the chain names the status and the code", async () => {
    const { output } = await against({ says: () => ({ status: 503, body: { error: { code: "chain_unavailable", message: "x" } } }) });
    expect(output).toMatch(/^FAIL the verifier checks the real batch's payslip: HTTP 503 chain_unavailable$/mu);
  });

  test("a verifier that does not find the transaction, or says verified to everything, fails", async () => {
    const missing = await against({ says: (slip) => ({ status: 200, body: answered(slip, { verdict: "not_found", confirmations: null, ironwood_actions: null }) }) });
    expect(missing.output).toMatch(/^FAIL the verifier checks the real batch's payslip: verdict not_found$/mu);
    const rubberStamp = await against({ says: (slip) => ({ status: 200, body: answered(slip) }) });
    expect(rubberStamp.output).toMatch(/^ok {3}the verifier checks the real batch's payslip: verified/mu);
    expect(rubberStamp.output).toMatch(/^FAIL the verifier refuses the same payslip with the amount changed: verdict verified$/mu);
  });

  test("a verifier that gives back what the payslip names fails, and the output does not repeat it", async () => {
    const { output } = await against({ says: (slip) => ({ status: 200, body: answered(slip, { receiver: slip["receiver"] }) }) });
    expect(output).toMatch(/^FAIL the verifier checks the real batch's payslip: the answer repeats something the payslip names$/mu);
    for (const secret of [payslip.receiver, payslip.rseed]) expect(output).not.toContain(secret);
  });
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
