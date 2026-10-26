import { expect, test, type Response } from "@playwright/test";

import { operatorUrl, seeded } from "./env.js";

// The operator serves the app with a strict Content-Security-Policy. The app
// must run under it without a single violation: no inline script, no eval, no
// inline style the policy forbids. A violation is reported to the page as a
// `securitypolicyviolation` event (and as a console error), so this walks the
// main pages in one load and fails on either.

test("the pages run under the operator's content security policy with no violations", async ({ page }) => {
  const { settled, funded } = seeded();
  const console_: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console_.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => console_.push(`uncaught: ${e.message}`));
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __spv: string[] }).__spv = seen;
    document.addEventListener("securitypolicyviolation", (e) => {
      seen.push(`${e.violatedDirective} blocked ${e.blockedURI || "(inline)"} from ${e.sourceFile || "the page"}`);
    });
  });

  const response = await page.goto(operatorUrl("/campaigns", { token: true }));
  const headers = response?.headers() ?? {};
  const policy = headers["content-security-policy"] ?? "";
  expect(policy, "the operator sends a Content-Security-Policy").toContain("default-src 'self'");
  expect(policy).not.toContain("unsafe-eval");
  expect(policy).not.toContain("unsafe-inline");
  expect(headers["x-content-type-options"]).toBe("nosniff");

  await expect(page.getByRole("heading", { level: 1, name: "Payouts" })).toBeVisible();
  await page.locator(`a[href="/campaign/${settled}"]`).click();
  await expect(page.getByText("Sealed")).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Batches confirmed" })).toBeVisible();
  // The sections behind a click open under the policy too.
  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByRole("log", { name: "Activity log" })).toBeVisible();
  await page.getByRole("button", { name: "Share the receipt" }).click();
  await expect(page.getByTestId("receipt-link")).toBeVisible();

  // The sheet that asks before sending, and a "Why?" popover: both run under the policy.
  await page.getByRole("link", { name: "All payouts" }).click();
  await page.locator(`a[href="/campaign/${funded}"]`).click();
  await page.getByRole("button", { name: /^Send \d+ payouts?$/u }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: /^Why: / }).first().click();
  await expect(page.locator("[data-slot='popover-content']")).toBeVisible();
  await page.keyboard.press("Escape");

  const nav = page.getByRole("navigation", { name: "Primary" });
  await nav.getByRole("link", { name: "Audit" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Audit" })).toBeVisible();
  await page.getByRole("link", { name: "New payout" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Add the payouts" })).toBeVisible();
  // The drop zone and its paste box run under the same policy.
  await page.getByRole("button", { name: "or paste it" }).click();
  await expect(page.getByLabel("Paste your list")).toBeVisible();
  // Switching theme changes a stylesheet's effect, never an inline style.
  const before = await page.locator("html").getAttribute("data-theme");
  await page.getByRole("button", { name: /^Switch to (dark|light) theme$/u }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", before ?? "");

  const violations = await page.evaluate(() => (window as unknown as { __spv: string[] }).__spv);
  expect(violations, "securitypolicyviolation events").toEqual([]);
  expect(console_).toEqual([]);
});

test("a request that names another host is refused by the operator", async ({ request }) => {
  // The operator is reachable only by its own loopback names (a defence against DNS rebinding).
  const response = await request.get(operatorUrl("/api/health"), { headers: { Host: "evil.example" } });
  expect([403, 421]).toContain(response.status());
});

// The home page is served by the operator too (its public routes), with the tour's pictures in /tour. They are
// the page's own files, so the policy ('self' only) lets them in; the operator serves them as images.
test("the home page's tour pictures load under the operator's policy, with no violation", async ({ page }) => {
  const console_: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console_.push(`${m.type()}: ${m.text()}`);
  });
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __spv: string[] }).__spv = seen;
    document.addEventListener("securitypolicyviolation", (e) => {
      seen.push(`${e.violatedDirective} blocked ${e.blockedURI || "(inline)"} from ${e.sourceFile || "the page"}`);
    });
  });

  // Listen before the page loads: a picture near the first screen is asked for at once.
  const answers: Response[] = [];
  page.on("response", (answer) => answers.push(answer));
  await page.goto(operatorUrl("/"));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const first = page.locator("section[aria-labelledby='tour-heading'] img").first();
  await first.scrollIntoViewIfNeeded();
  await expect.poll(() => answers.some((answer) => new URL(answer.url()).pathname.startsWith("/tour/"))).toBe(true);
  const response = answers.find((answer) => new URL(answer.url()).pathname.startsWith("/tour/")) as Response;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/webp");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["content-security-policy"]).toContain("default-src 'self'");
  await expect.poll(() => first.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  expect(await page.evaluate(() => (window as unknown as { __spv: string[] }).__spv), "securitypolicyviolation events").toEqual([]);
  expect(console_).toEqual([]);
});
