import { expect, test } from "@playwright/test";

import { dumpBrowserState, observe } from "./privacy.js";
import { operatorOrigin, operatorToken, operatorUrl } from "./env.js";

// The bearer token: where it comes from, where it must never be, and what the
// page does without a good one.

const WRONG_TOKEN = "00".repeat(32);

// covers: REQ-OPS-002
test.describe("without a good token", () => {
  test("no token: explains how to get back in, and asks the operator for nothing protected", async ({ page }) => {
    const seen = await observe(page);
    await page.goto(operatorUrl("/campaigns"));

    await expect(page.getByRole("heading", { level: 1, name: "Open the operator link" })).toBeVisible();
    await expect(page.getByText("No operator link was opened")).toBeVisible();
    await expect(page.getByRole("heading", { name: "How to get back in" })).toBeVisible();
    await expect(page.getByLabel("Operator link or token")).toBeVisible();

    const protectedCalls = seen
      .requests()
      .filter((r) => new URL(r.url).pathname.startsWith("/api/") && !r.url.endsWith("/api/health"));
    expect(protectedCalls).toEqual([]);
    expect(seen.problems()).toEqual([]);
  });

  test("a wrong token: the operator says no, the page says what to do, and forgets it", async ({ page }) => {
    const seen = await observe(page);
    await page.goto(operatorUrl("/campaigns", { token: WRONG_TOKEN }));

    await expect(page.getByRole("heading", { level: 1, name: "Open the operator link" })).toBeVisible();
    await expect(page.getByText("The operator did not accept this link")).toBeVisible();

    // The token left the address bar and was never kept anywhere.
    expect(page.url()).toBe(operatorUrl("/campaigns"));
    expect(await dumpBrowserState(page)).not.toContain(WRONG_TOKEN);
    // Every URL after the one we opened (which has the token in it, because we put it there).
    const entry = operatorUrl("/campaigns", { token: WRONG_TOKEN });
    expect(seen.urls().filter((u) => u !== entry).join("\n")).not.toContain(WRONG_TOKEN);
    // The refused token travelled as a header, and the operator's answer was a 401.
    const attempt = seen.requests().find((r) => new URL(r.url).pathname === "/api/campaigns");
    expect(attempt?.hasToken).toBe(true);
  });

  test("a malformed token is stripped from the address bar and refused without asking the operator", async ({ page }) => {
    const seen = await observe(page);
    await page.goto(`${operatorOrigin()}/campaigns#token=not-a-token`);

    await expect(page.getByRole("heading", { level: 1, name: "Open the operator link" })).toBeVisible();
    expect(page.url()).toBe(operatorUrl("/campaigns"));
    expect(
      seen.requests().filter((r) => new URL(r.url).pathname === "/api/campaigns"),
      "a malformed token is never sent",
    ).toEqual([]);
  });

  test("a token in the query string is not a token", async ({ page }) => {
    const seen = await observe(page);
    await page.goto(`${operatorOrigin()}/campaigns?token=${operatorToken()}`);
    await expect(page.getByRole("heading", { level: 1, name: "Open the operator link" })).toBeVisible();
    expect(seen.requests().filter((r) => r.hasToken)).toEqual([]);
  });
});

test.describe("with the real token", () => {
  test("pasting the link from the terminal signs in; a reload signs out; nothing is stored", async ({ page }) => {
    await page.goto(operatorUrl("/campaigns"));
    await expect(page.getByRole("heading", { level: 1, name: "Open the operator link" })).toBeVisible();

    // Garbage is refused with a sentence, not a crash.
    const field = page.getByLabel("Operator link or token");
    await field.fill("hello");
    await page.getByRole("button", { name: "Use this link" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "does not contain an operator token" })).toBeVisible();

    await field.fill(`open:    ${operatorUrl("/", { token: true })}`);
    await page.getByRole("button", { name: "Use this link" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Campaigns" })).toBeVisible();
    expect(page.url()).toBe(operatorUrl("/campaigns"));

    const state = await dumpBrowserState(page);
    expect(state).not.toContain(operatorToken());

    // The token lives in memory: a reload loses it, on purpose.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Open the operator link" })).toBeVisible();
  });

  test("opening the link signs in, and the token is in no URL, storage or later request URL", async ({ page }) => {
    const seen = await observe(page);
    await page.goto(operatorUrl("/campaigns", { token: true }));
    await expect(page.getByRole("heading", { level: 1, name: "Campaigns" })).toBeVisible();

    expect(page.url()).not.toContain(operatorToken());
    expect(await dumpBrowserState(page)).not.toContain(operatorToken());
    for (const request of seen.requests()) {
      // The document request is the link we opened; every request after it must be token-free.
      if (request.url === operatorUrl("/campaigns", { token: true })) continue;
      expect(request.url, "request URL").not.toContain(operatorToken());
    }
    expect(seen.console().join("\n")).not.toContain(operatorToken());
    expect(seen.problems()).toEqual([]);
  });
});

test.describe("the operator itself", () => {
  test("refuses the API without the token, and with a wrong one", async ({ request }) => {
    const none = await request.get(operatorUrl("/api/campaigns"));
    expect(none.status()).toBe(401);
    const wrong = await request.get(operatorUrl("/api/campaigns"), { headers: { Authorization: `Bearer ${WRONG_TOKEN}` } });
    expect(wrong.status()).toBe(401);
    const good = await request.get(operatorUrl("/api/campaigns"), { headers: { Authorization: `Bearer ${operatorToken()}` } });
    expect(good.status()).toBe(200);
  });

  test("serves the page without a token (it is only the code, not the data)", async ({ request }) => {
    const page = await request.get(operatorUrl("/campaigns"));
    expect(page.status()).toBe(200);
    expect(await page.text()).toContain("<div id=\"root\">");
  });
});
