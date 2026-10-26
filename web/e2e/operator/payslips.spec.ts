import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { axeViolations } from "../helpers.js";
import { operatorUrl, seeded } from "./env.js";
import { dumpBrowserState, observe } from "./privacy.js";

// The payslips of a settled campaign on the payer's own page (REQ-PAY-005), in a real browser against the real operator
// binary. On the mock chain there are none, and the page says why without asking. For the real-chain answer the
// operator's golden file is served with secrets made fresh for each run, so nothing else can contain them: ask, list,
// send one person's as a link and a QR code, open the link, hide, and look for the secrets everywhere they must not be.

const GOLDEN = resolve(process.cwd(), "../fixtures/contract/operator/golden");
const golden = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(GOLDEN, name), "utf8")) as Record<string, unknown>;

interface Row {
  number: number;
  address: string;
  amount: string;
  memo: string | null;
  payslip: Record<string, unknown> | null;
}

test("on the mock chain the payslips say why there are none, and the operator is not asked", async ({ page }) => {
  const { settled } = seeded();
  const seen = await observe(page);
  await page.goto(operatorUrl(`/campaign/${settled}`, { token: true }));
  await page.getByRole("button", { name: "Send payslips" }).click();
  await expect(page.getByText(/The fake chain has no real transaction to prove/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Show payslips" })).toHaveCount(0);
  expect(seen.requests().filter((r) => r.url.endsWith("/payslips"))).toEqual([]);
  expect(await axeViolations(page)).toEqual([]);
});

// covers: REQ-PAY-005
test("a settled campaign's payslips: asked for, listed, one sent as a link and a QR code, then hidden and gone", async ({ page }) => {
  test.setTimeout(120_000);
  const { settled } = seeded();
  const answer = golden("payslips.json") as { payslips: Row[] } & Record<string, unknown>;
  // Fresh secrets for this run: a receiver and an rseed nothing else can hold.
  const rows = answer.payslips.map((row) =>
    row.payslip === null
      ? row
      : { ...row, payslip: { ...row.payslip, receiver: randomBytes(43).toString("hex"), rseed: randomBytes(32).toString("hex") } },
  );
  const secrets = rows.flatMap((row) => (row.payslip === null ? [] : [String(row.payslip["receiver"]), String(row.payslip["rseed"])]));
  const hits = (text: string) => secrets.filter((secret) => text.includes(secret)).length;

  const seen = await observe(page);
  await page.route(/\/api\/health$/u, (route) => route.fulfill({ json: golden("health-real.json") }));
  const disclosures: (string | undefined)[] = [];
  await page.route(/\/api\/campaigns\/[^/]+\/payslips$/u, (route) => {
    disclosures.push(route.request().headers()["x-zecdrop-confirm-disclosure"]);
    return route.fulfill({ json: { ...answer, campaign_id: settled, payslips: rows } });
  });

  await page.goto(operatorUrl(`/campaign/${settled}`, { token: true }));
  await page.getByRole("button", { name: "Send payslips" }).click();
  await expect(page.getByText("A payslip shows one payout's address, amount and note to whoever has it", { exact: false })).toBeVisible();
  expect(seen.requests().filter((r) => r.url.endsWith("/payslips"))).toEqual([]);

  await page.getByRole("button", { name: "Show payslips" }).click();
  const list = page.getByRole("list", { name: "Payslips" });
  await expect(list.getByRole("listitem")).toHaveCount(rows.length);
  expect(disclosures).toEqual(["I-UNDERSTAND"]);
  expect(hits(await page.content()), "listed, nothing sent yet").toBe(0);
  expect(await axeViolations(page)).toEqual([]);

  const first = list.getByRole("listitem").first();
  await first.getByRole("button", { name: "Send payslip" }).click();
  await first.getByRole("button", { name: "Make a link" }).click();
  const link = await first.getByRole("textbox").inputValue();
  expect(link).toMatch(/\/payslip#payslip=[A-Za-z0-9_-]+$/u);
  await first.getByRole("button", { name: "Show QR code" }).click();
  await expect(first.getByRole("img", { name: "QR code of the payslip link" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("button", { name: "Hide payslips" }).click();
  await expect(list).toHaveCount(0);
  expect(hits(await page.content()), "after Hide").toBe(0);

  // The link opens the payslip page with the payslip in its box, and the address bar loses it at once.
  await page.goto(link);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(page.url()).not.toContain("payslip=");
  const firstSecret = secrets[1] ?? "no payslip";
  await expect(page.getByRole("textbox").first()).toHaveValue(new RegExp(firstSecret, "u"));

  // Nowhere it could have been kept or sent: no storage, no console line, no request other than the export, whose body
  // is empty.
  expect(hits(await dumpBrowserState(page)), "browser storage").toBe(0);
  expect(hits(seen.console().join("\n")), "console").toBe(0);
  expect(hits(seen.requests().map((r) => `${r.url} ${r.body ?? ""}`).join("\n")), "requests").toBe(0);
  expect(seen.problems()).toEqual([]);
});
