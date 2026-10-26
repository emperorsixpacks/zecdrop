import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { operatorUrl, seeded } from "./env.js";
import { dumpBrowserState, observe } from "./privacy.js";

// The viewing key discloses every payout, for good. The mock chain has none, so
// this serves the real-chain answers from the operator's golden files (with a
// key made fresh for each run, so nothing else can contain it) and carries it
// through a real browser: ask, show, copy, hide, leave, come back. It may be on
// screen while shown and on the clipboard when copied, and nowhere else.

const GOLDEN = resolve(process.cwd(), "../fixtures/contract/operator/golden");
const golden = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(GOLDEN, name), "utf8")) as Record<string, unknown>;

/** Overlapping pieces of the key, so a truncated or re-wrapped copy is caught too. */
function fragments(key: string, size = 14): string[] {
  const out = new Set<string>();
  for (let i = 0; i + size <= key.length; i += 7) out.add(key.slice(i, i + size));
  out.add(key.slice(-size));
  return [...out];
}

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

// covers: REQ-PRIV-002
test("the viewing key is on screen only while shown, and nowhere else", async ({ page }) => {
  const key = `uview1${randomBytes(48).toString("hex")}`;
  const pieces = fragments(key);
  const hits = (text: string): number => pieces.filter((p) => text.includes(p)).length;
  const { funded } = seeded();

  const seen = await observe(page);
  await page.route(/\/api\/health$/u, (route) => route.fulfill({ json: golden("health-real.json") }));
  await page.route(new RegExp(`/api/campaigns/${funded}$`, "u"), (route) =>
    route.fulfill({ json: { ...golden("campaign-real-awaiting-deposit.json"), id: funded } }),
  );
  await page.route(/\/api\/campaigns\/[^/]+\/audit-ufvk-export$/u, (route) =>
    route.fulfill({ json: { ...golden("audit-ufvk-export.json"), campaign_id: funded, ufvk: key } }),
  );

  await page.goto(operatorUrl(`/campaign/${funded}`, { token: true }));
  const heading = page.getByRole("heading", { name: "Give an auditor the viewing key" });
  await expect(heading).toBeVisible();

  // Not before the person has agreed.
  const reveal = page.getByRole("button", { name: "Show the viewing key" });
  await expect(reveal).toBeDisabled();
  expect(hits(await page.content())).toBe(0);

  await page.getByRole("checkbox", { name: /I understand that whoever receives this key/u }).check();
  await reveal.click();
  const box = page.getByLabel(/Viewing key for testnet/u);
  await expect(box).toHaveValue(key);

  // The operator's warning is on screen beside the key.
  await expect(page.getByText(/Giving it away cannot be undone/u).first()).toBeVisible();

  // Copying puts it on the clipboard, which is what the button is for.
  await page.getByRole("button", { name: "Copy viewing key" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Copied to clipboard" })).toHaveCount(1);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);

  // While it is shown it is in the box and nowhere else in the page's markup.
  const elsewhere = await page.evaluate(() => {
    const copy = document.body.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("textarea").forEach((t) => {
      t.remove();
    });
    return copy.innerHTML;
  });
  expect(hits(elsewhere), "elsewhere on the page").toBe(0);

  // Hide it: gone from the page. Show it again (a fresh tick is required), then leave.
  await page.getByRole("button", { name: "Hide key" }).click();
  await expect(box).toHaveCount(0);
  expect(hits(await page.content()), "after Hide").toBe(0);
  await expect(page.getByRole("checkbox", { name: /I understand/u })).not.toBeChecked();

  await page.getByRole("checkbox", { name: /I understand/u }).check();
  await reveal.click();
  await expect(box).toHaveValue(key);
  await page.getByRole("link", { name: "All campaigns" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Campaigns" })).toBeVisible();
  expect(hits(await page.content()), "after leaving the page").toBe(0);

  // Come back: it does not.
  await page.locator(`a[href="/campaign/${funded}"]`).click();
  await expect(heading).toBeVisible();
  await expect(page.getByLabel(/Viewing key for testnet/u)).toHaveCount(0);
  expect(hits(await page.content()), "after coming back").toBe(0);

  // Nowhere it could have been kept or sent.
  expect(hits(await dumpBrowserState(page)), "browser storage").toBe(0);
  expect(hits(seen.urls().join("\n")), "URLs").toBe(0);
  expect(hits(seen.console().join("\n")), "console").toBe(0);
  expect(seen.problems()).toEqual([]);
  expect(
    hits(seen.requests().map((r) => `${r.url} ${r.body ?? ""}`).join("\n")),
    "requests",
  ).toBe(0);
  expect(page.url()).not.toContain("uview");
});
