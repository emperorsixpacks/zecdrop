import { expect, test } from "@playwright/test";

import { operatorOrigin, operatorToken, operatorUrl } from "./env.js";
import { dumpBrowserState, findSentinels, loadSentinels, observe } from "./privacy.js";

// The whole path through the real operator binary on the mock chain, in a real
// browser: create a campaign from a CSV of sentinel recipients, fund it with a
// pretend deposit, send, watch it settle, open the receipt link. Afterwards,
// prove that no recipient data was left behind anywhere.

// covers: REQ-PRIV-002, REQ-OPS-002
test("create, fund, send, settle and share, leaving no recipient data behind", async ({ page }) => {
  test.setTimeout(180_000);
  const sentinels = loadSentinels();
  const seen = await observe(page);
  const campaignName = `E2E payout ${String(Date.now())}`;

  // ---- open the operator link ----------------------------------------------------
  await page.goto(operatorUrl("/campaigns", { token: true }));
  await expect(page.getByRole("heading", { level: 1, name: "Campaigns" })).toBeVisible();
  // The token left the address bar the moment the page loaded.
  expect(page.url()).toBe(operatorUrl("/campaigns"));
  expect(page.url()).not.toContain(operatorToken());

  // The mock chain says so, persistently.
  const banner = page.getByRole("status").filter({ hasText: "Mock chain: nothing is sent to Zcash" });
  await expect(banner).toBeVisible();

  // ---- the wizard ----------------------------------------------------------------
  await page.getByRole("main").getByRole("link", { name: "New campaign" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Basics" })).toBeVisible();
  await page.getByLabel("Campaign name").fill(campaignName);
  await expect(page.getByRole("radio", { name: /Standard: 5,000 zatoshi per action/u })).toBeChecked();
  await expect(page.getByLabel("Payouts per batch")).toHaveValue("50");
  await page.getByLabel("Payouts per batch").fill("3"); // two batches, one with two recipients
  await page.getByRole("button", { name: "Next: Recipients" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Recipients" })).toBeVisible();
  await page.getByLabel("Recipients (CSV)").fill(sentinels.csv);
  await page.getByRole("button", { name: "Check and create campaign" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Auditor" })).toBeVisible();
  await expect(page.getByText(/The mock chain has no real viewing keys/u)).toBeVisible();
  // Nothing of the list is on screen any more (the box is gone with the step).
  expect(findSentinels(await page.locator("body").innerText(), sentinels)).toEqual([]);

  await page.getByRole("link", { name: /^Next: Review/u }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Review" })).toBeVisible();
  await expect(page.getByTestId("manifest-commitment")).toHaveText(/^[0-9a-f]{64}$/u);
  await expect(page.getByRole("heading", { name: /^Privacy warnings \(\d+\)$/u })).toBeVisible();
  await expect(page.getByText("11.625 TAZ").first()).toBeVisible();
  expect(findSentinels(await page.locator("body").innerText(), sentinels)).toEqual([]);

  await page.getByRole("link", { name: /^Next: Fund/u }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Fund & Send" })).toBeVisible();
  await expect(page.getByText("Sending can start once the campaign is funded.")).toBeVisible();

  // ---- fund (mock) and start -------------------------------------------------------
  await page.getByRole("button", { name: "Record mock deposit" }).click();
  await expect(page.getByText(/in deposit/u)).toBeVisible();
  await page.getByRole("button", { name: "Start sending" }).click();

  await expect(page.getByRole("heading", { level: 1, name: campaignName })).toBeVisible();
  await expect(page).toHaveURL(/\/campaign\/c-[0-9a-f]{12}$/u);
  const campaignId = /\/campaign\/(c-[0-9a-f]{12})$/u.exec(page.url())?.[1] ?? "";
  expect(campaignId).not.toBe("");

  // ---- watch it settle -------------------------------------------------------------
  await expect(page.getByText("Complete: all batches confirmed").first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("2 of 2 batches confirmed")).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Batches confirmed" })).toHaveAttribute("aria-valuenow", "100");
  await expect(page.getByRole("log", { name: "Activity log" })).toContainText("All 2 batches are confirmed.");
  await expect(page.getByText("Batch 0: transaction built")).toBeVisible();

  // ---- the receipt link ------------------------------------------------------------
  const link = (await page.getByTestId("receipt-link").textContent()) ?? "";
  expect(link).toMatch(new RegExp(`^/r/${campaignId}\\?network=testnet(&tx=[0-9a-f]{64}){2}&commitment=[0-9a-f]{64}&declared_total=1162500000$`, "u"));
  await expect(page.getByText(/This is the path only/u)).toBeVisible();

  // The public page asks a hosted verifier; the operator does not serve that
  // endpoint. Answer it with the operator's own receipt, so the page checks
  // that the link and the receipt agree.
  const receiptResponse = await page.request.get(operatorUrl(`/api/campaigns/${campaignId}/receipt`), {
    headers: { Authorization: `Bearer ${operatorToken()}` },
  });
  expect(receiptResponse.status()).toBe(200);
  const receipt: unknown = await receiptResponse.json();
  await page.route(/\/api\/v1\/receipt\?/u, (route) => route.fulfill({ json: receipt }));

  await page.goto(`${operatorOrigin()}${link}`);
  await expect(page.getByRole("heading", { level: 1, name: "Payout receipt" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Status" })).toBeVisible();
  await expect(page.getByText("11.625 TAZ").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "What the verifier found" })).toHaveCount(0);

  // ---- nothing was left behind -----------------------------------------------------
  // Browser storage of every kind.
  const state = await dumpBrowserState(page);
  expect(findSentinels(state, sentinels), "browser storage").toEqual([]);
  expect(state).not.toContain(operatorToken());

  // Every URL the page was at or asked for.
  expect(findSentinels(seen.urls().join("\n"), sentinels), "URLs").toEqual([]);
  // (the one URL that does hold the token is the link we opened, which is what the person pasted)
  const entry = operatorUrl("/campaigns", { token: true });
  expect(seen.urls().filter((u) => u !== entry).join("\n")).not.toContain(operatorToken());

  // The console, of every type.
  expect(findSentinels(seen.console().join("\n"), sentinels), "console").toEqual([]);
  expect(seen.problems()).toEqual([]);

  // Only the request that creates the campaign carries the list.
  const carrying = seen.requests().filter((r) => r.body !== null && findSentinels(r.body, sentinels).length > 0);
  expect(carrying.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(["POST /api/campaigns"]);

  // Every protected API call carried the token as a header, never in the URL.
  const api = seen.requests().filter((r) => new URL(r.url).pathname.startsWith("/api/") && !r.url.includes("/api/health") && !r.url.includes("/api/v1/"));
  expect(api.length).toBeGreaterThan(5);
  expect(api.filter((r) => !r.hasToken).map((r) => r.url)).toEqual([]);

  // No response, from the creation to the receipt, repeats the list.
  const responses = seen.responses();
  expect(responses.length).toBeGreaterThan(5);
  expect(responses.filter((r) => findSentinels(r.text, sentinels).length > 0).map((r) => new URL(r.url).pathname)).toEqual([]);

  // Nothing left the origin.
  const origin = operatorOrigin();
  expect(seen.requests().filter((r) => !r.url.startsWith(origin) && !r.url.startsWith("data:") && !r.url.startsWith("blob:"))).toEqual([]);
});
