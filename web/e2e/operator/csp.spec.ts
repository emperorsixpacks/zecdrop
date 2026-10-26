import { expect, test } from "@playwright/test";

import { operatorUrl, seeded } from "./env.js";

// The operator serves the app with a strict Content-Security-Policy. The app
// must run under it without a single violation: no inline script, no eval, no
// inline style the policy forbids. A violation is reported to the page as a
// `securitypolicyviolation` event (and as a console error), so this walks the
// main pages in one load and fails on either.

test("the pages run under the operator's content security policy with no violations", async ({ page }) => {
  const { settled } = seeded();
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

  await expect(page.getByRole("heading", { level: 1, name: "Campaigns" })).toBeVisible();
  await page.locator(`a[href="/campaign/${settled}"]`).click();
  await expect(page.getByTestId("receipt-link")).toBeVisible();
  await expect(page.getByRole("log", { name: "Activity log" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Batches confirmed" })).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Primary" });
  await nav.getByRole("link", { name: "Audit" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Audit" })).toBeVisible();
  await nav.getByRole("link", { name: "New campaign" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Basics" })).toBeVisible();
  // Switching theme changes a stylesheet's effect, never an inline style.
  const before = await page.locator("html").getAttribute("data-theme");
  await page.getByRole("button", { name: "Light theme" }).click();
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
