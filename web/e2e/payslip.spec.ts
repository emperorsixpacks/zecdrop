import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

import { axeViolations, overflowReport, THEMES, useTheme, VIEWPORTS, watchProblems } from "./helpers.js";
import { dumpBrowserState, observe } from "./operator/privacy.js";

// The page that checks a payslip, in a real browser: every state of the result at phone and desktop width in
// both themes (no console problem, no sideways scroll, no accessibility violation), the keyboard path, and that
// the payslip goes nowhere but the one request. The verifier is played by the browser's own routing: the page
// asks /api/v1/payslip, and the test answers. (The hosted build against a stub verifier on another origin,
// under the real Content-Security-Policy, is e2e/hosted/hosted.spec.ts.)

const root = resolve(process.cwd(), "..", "fixtures", "testnet-ironwood-batch-8");
const [dir] = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[0-9a-f]{64}$/u.test(e.name));
const sampleText = readFileSync(join(root, dir?.name ?? "", "payslips", "payslip-3.json"), "utf8");
const sample = JSON.parse(sampleText) as { network: string; txid: string; action: number; receiver: string; value: string; rseed: string };

const NOT_PROVEN = [
  "Who the recipient is, or that whoever presents the payslip controls the receiver. A payslip is a bearer document: anyone who holds it can present it.",
  "The memo. The note commitment does not cover it.",
  "That the transaction is mined or final. That needs the chain: see the confirmations.",
  "That the funds are unspent, or that the transaction belongs to a given campaign. Compare its id with the campaign's public receipt.",
  "Anything about any other output of the transaction.",
];

const answer = (change: Record<string, unknown> = {}) => ({
  network: sample.network,
  txid: sample.txid,
  action: sample.action,
  verdict: "verified",
  reason: null,
  confirmations: 19,
  required_depth: 3,
  ironwood_actions: 8,
  not_proven: NOT_PROVEN,
  ...change,
});

const none = { confirmations: null, ironwood_actions: null };

interface State {
  name: string;
  /** What the verifier says, if the state is one the verifier is asked for. */
  says?: { status: number; body: unknown };
  /** The heading that tells the state is on the page. */
  heading: string;
}

const STATES: State[] = [
  { name: "verified", says: { status: 200, body: answer() }, heading: "Verified" },
  { name: "pending", says: { status: 200, body: answer({ verdict: "pending", confirmations: 1 }) }, heading: "Matches, not final yet" },
  { name: "not found", says: { status: 200, body: answer({ verdict: "not_found", ...none }) }, heading: "Transaction not found" },
  { name: "not verified", says: { status: 200, body: answer({ verdict: "invalid", reason: "does_not_match", ...none }) }, heading: "Not verified" },
  { name: "the verifier is busy", says: { status: 503, body: { error: { code: "overloaded", message: "x" } } }, heading: "The verifier can't be reached right now" },
  { name: "the verifier does not serve the network", says: { status: 400, body: { error: { code: "network_not_configured", message: "x" } } }, heading: "This verifier does not serve testnet" },
];

const fulfil = (route: Route, says: { status: number; body: unknown }) =>
  route.fulfill({ status: says.status, contentType: "application/json", body: JSON.stringify(says.body) });

/** The browser says on its own that a request came back with an error status; that is not the page talking. */
const browserNoteAbout = (status: number | undefined) => (problem: string) =>
  status !== undefined && problem.includes(`Failed to load resource: the server responded with a status of ${String(status)}`);

async function check(page: Page, label: string, problems: () => string[]) {
  expect(problems(), `${label}: console`).toEqual([]);
  const overflow = await overflowReport(page);
  expect(overflow.wide, `${label}: elements wider than the viewport`).toEqual([]);
  expect(overflow.page, `${label}: horizontal scroll`).toBeLessThanOrEqual(0);
  expect(await axeViolations(page), `${label}: accessibility violations`).toEqual([]);
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`${viewport.name}, ${theme} theme`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      for (const state of STATES) {
        test(`the payslip page: ${state.name}`, async ({ page }) => {
          await useTheme(page, theme);
          const problems = watchProblems(page);
          const says = state.says;
          if (says) await page.route("**/api/v1/payslip", (route) => fulfil(route, says));

          await page.goto("/payslip");
          await expect(page.getByRole("heading", { level: 1, name: "Check a payslip" })).toBeVisible();
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await page.getByRole("button", { name: "Load a sample" }).click();
          await page.getByRole("button", { name: "Check payslip" }).click();
          const heading = page.getByRole("heading", { level: 2, name: state.heading, exact: true });
          await expect(heading).toBeVisible();
          // The result takes the focus, and the list of what is not proven is still there under it.
          await expect(heading).toBeFocused();
          await expect(page.getByTestId("not-proven").getByRole("listitem")).toHaveCount(5);
          await check(page, state.name, () => problems().filter((problem) => !browserNoteAbout(says?.status)(problem)));
        });
      }

      test("the payslip page: a paste that is not a payslip", async ({ page }) => {
        await useTheme(page, theme);
        const problems = watchProblems(page);
        let asked = 0;
        await page.route("**/api/v1/payslip", (route) => {
          asked += 1;
          return fulfil(route, { status: 200, body: answer() });
        });
        await page.goto("/payslip");
        await page.getByLabel("Payslip").fill("this is not a payslip");
        await page.getByRole("button", { name: "Check payslip" }).click();
        await expect(page.getByRole("alert")).toHaveText("That is not a payslip: it is not valid JSON. Paste the whole file.");
        await expect(page.getByLabel("Payslip")).toBeFocused();
        expect(asked).toBe(0);
        await check(page, "a bad paste", problems);
      });

      test("the payslip page: while it checks", async ({ page }) => {
        await useTheme(page, theme);
        const problems = watchProblems(page);
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolveHeld) => {
          release = resolveHeld;
        });
        await page.route("**/api/v1/payslip", async (route) => {
          await held;
          await fulfil(route, { status: 200, body: answer() });
        });
        await page.goto("/payslip");
        await page.getByRole("button", { name: "Load a sample" }).click();
        await page.getByRole("button", { name: "Check payslip" }).click();
        await expect(page.getByText("Checking the payslip against the chain…")).toBeVisible();
        await expect(page.getByRole("button", { name: "Checking…" })).toHaveAttribute("aria-disabled", "true");
        await check(page, "checking", problems);
        release();
        await expect(page.getByRole("heading", { level: 2, name: "Verified", exact: true })).toBeFocused();
      });
    });
  }
}

test.describe("what the page does with a payslip", () => {
  test("sends it once, as the body of one POST, and keeps it nowhere else", async ({ page }) => {
    const seen = await observe(page);
    await page.route("**/api/v1/payslip", (route) => fulfil(route, { status: 200, body: answer() }));
    await page.goto("/payslip");
    await page.getByRole("button", { name: "Load a sample" }).click();
    await page.getByRole("button", { name: "Check payslip" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Verified", exact: true })).toBeVisible();

    const secrets = [sample.receiver, sample.rseed];
    const holds = (text: string) => secrets.filter((secret) => text.includes(secret));

    // One request carried it, a POST of JSON to the one address, with no query and no token.
    const requests = seen.requests();
    const carrying = requests.filter((r) => holds(`${r.url} ${r.body ?? ""}`).length > 0);
    expect(carrying).toHaveLength(1);
    const [request] = carrying;
    expect(request?.method).toBe("POST");
    expect(new URL(request?.url ?? "").pathname).toBe("/api/v1/payslip");
    expect(new URL(request?.url ?? "").search).toBe("");
    expect(request?.hasToken).toBe(false);
    expect(JSON.parse(request?.body ?? "null")).toEqual(JSON.parse(sampleText));

    // No address the page was at or asked for held it; neither did the console.
    expect(seen.urls().flatMap(holds)).toEqual([]);
    expect(seen.console().flatMap(holds)).toEqual([]);
    expect(seen.console()).toEqual([]);
    // And nothing the browser keeps: storage, IndexedDB, caches, cookies, the history entry.
    expect(holds(await dumpBrowserState(page))).toEqual([]);
    // The result shows the amount and a short receiver as what the payslip states, never the receiver whole or the secret.
    const shown = await page.getByTestId("payslip-result").innerText();
    expect(holds(shown)).toEqual([]);
    expect(shown).toContain("0.0009 TAZ");
    expect(seen.problems()).toEqual([]);

    // Leaving for another page of the app and coming back finds an empty box.
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "How privacy works" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "How privacy works" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "Check a payslip" })).toBeVisible();
    await expect(page.getByLabel("Payslip")).toHaveValue("");
  });

  test("a changed copy is refused by the verifier and never shown as verified", async ({ page }) => {
    // The test plays a verifier that knows the one true payslip.
    await page.route("**/api/v1/payslip", (route) => {
      const slip = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      const same = JSON.stringify(slip) === JSON.stringify(JSON.parse(sampleText));
      return fulfil(route, { status: 200, body: same ? answer() : answer({ verdict: "invalid", reason: "does_not_match", ...none }) });
    });
    await page.goto("/payslip");
    await page.getByRole("button", { name: "Load a sample" }).click();
    await page.getByRole("button", { name: "Check payslip" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Verified", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Load a changed copy" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Verified", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Check payslip" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Not verified", exact: true })).toBeFocused();
    await expect(page.getByRole("heading", { level: 2, name: "Verified", exact: true })).toHaveCount(0);
  });

  test("works from the keyboard alone, and the result is where the focus lands", async ({ page }) => {
    await page.route("**/api/v1/payslip", (route) => fulfil(route, { status: 200, body: answer() }));
    await page.goto("/payslip");
    await page.getByRole("button", { name: "Load a sample" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Payslip")).toHaveValue(sampleText);
    // From the box, Tab reaches the button to check, with nothing to stop at in between.
    await page.getByLabel("Payslip").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Check payslip" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 2, name: "Verified", exact: true })).toBeFocused();
    // The order carries on from the result: backwards, it is the link to the sample's receipt, then the helpers.
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("link", { name: "receipt", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Load a changed copy" })).toBeFocused();
    await page.getByRole("button", { name: "Clear" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Payslip")).toHaveValue("");
    await expect(page.getByLabel("Payslip")).toBeFocused();
    await expect(page.getByRole("heading", { level: 2, name: "Verified", exact: true })).toHaveCount(0);
  });
});
