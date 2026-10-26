import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { axeViolations, overflowReport, THEMES, useTheme, VIEWPORTS, watchProblems } from "./helpers.js";
import { dumpBrowserState } from "./operator/privacy.js";
import { decodeScreenshot } from "./qr.js";

// A payslip as a link and a QR code, and a page opened from one (openspec REQ-PAY-004), in a real browser. The page is served by
// a server of this test's own that writes down every request exactly as it arrives, so what a server is told is what is checked:
// the address, the headers and the body. The payslip must be in none of them, until the person asks for a check, and then in the
// body of that one request and nowhere else.

const root = resolve(process.cwd(), "..", "fixtures", "testnet-ironwood-batch-8");
const [dir] = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[0-9a-f]{64}$/u.test(e.name));
const sampleText = readFileSync(join(root, dir?.name ?? "", "payslips", "payslip-3.json"), "utf8");
const sample = JSON.parse(sampleText) as { version: number; network: string; txid: string; action: number; receiver: string; value: string; rseed: string };
// The body the page sends: the seven fields, compact, in the verifier's order.
const body = JSON.stringify({ version: sample.version, network: sample.network, txid: sample.txid, action: sample.action, receiver: sample.receiver, value: sample.value, rseed: sample.rseed });
const FRAGMENT_VALUE = Buffer.from(body).toString("base64url");

const NOT_PROVEN = [
  "Who the recipient is, or that whoever presents the payslip controls the receiver. A payslip is a bearer document: anyone who holds it can present it.",
  "The memo. The note commitment does not cover it.",
  "That the transaction is mined or final. That needs the chain: see the confirmations.",
  "That the funds are unspent, or that the transaction belongs to a given campaign. Compare its id with the campaign's public receipt.",
  "Anything about any other output of the transaction.",
];
const VERIFIED = {
  network: sample.network,
  txid: sample.txid,
  action: sample.action,
  verdict: "verified",
  reason: null,
  confirmations: 19,
  required_depth: 3,
  ironwood_actions: 8,
  not_proven: NOT_PROVEN,
};

const LINK_NOTICE = "This payslip came from a link. Whoever has that link has the payslip: its receiver, its amount and the key to its memo.";
const LINK_WARNING =
  "This link holds the whole payslip. Anyone who gets it can read its amount, its receiver and the key to its memo, and can present it as their own. Send it only to the person you want to prove the payment to.";

interface Wire {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

/** The built app, served the way a host serves it (every client route is the page), by a server that writes down each request
 * as it arrives, and answers a payslip check as the hosted verifier does for the sample. */
async function serveBuild(): Promise<{ origin: string; wire: Wire[]; close: () => Promise<void> }> {
  const dist = resolve(process.cwd(), "dist");
  const wire: Wire[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = request.url ?? "/";
      wire.push({ method: request.method ?? "GET", url, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      const path = new URL(url, "http://x").pathname;
      if (path === "/api/v1/payslip" && request.method === "POST") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(VERIFIED));
        return;
      }
      const target = normalize(join(dist, decodeURIComponent(path)));
      let file = join(dist, "index.html");
      try {
        if ((target === dist || target.startsWith(dist + sep)) && statSync(target).isFile()) file = target;
      } catch {
        /* a client route: the page */
      }
      response.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
      response.end(readFileSync(file));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    wire,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      }),
  };
}

/** Everything a server was told by these requests, as one text: addresses, headers, bodies. */
const told = (wire: Wire[]) => wire.map((w) => `${w.method} ${w.url}\n${JSON.stringify(w.headers)}\n${w.body}`).join("\n");

/** The pieces of the payslip, any of which in a request would be the payslip leaking. */
const PIECES = [sample.receiver, sample.rseed, sample.txid, FRAGMENT_VALUE.slice(0, 40), FRAGMENT_VALUE.slice(-40), body];
/** Whether the text holds any piece of the payslip. */
const holdsAny = (text: string) => PIECES.some((piece) => text.includes(piece.slice(0, 30)));

async function withShare(page: Page) {
  await page.addInitScript(() => {
    const shared: unknown[] = [];
    (window as unknown as { __shared: unknown[] }).__shared = shared;
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: (data: unknown) => {
        shared.push(data);
        return Promise.resolve();
      },
    });
  });
}

test.describe("a payslip as a link and a QR code", () => {
  // The density of a phone's screen: a code on it is drawn with more than one pixel to a CSS pixel.
  test.use({ permissions: ["clipboard-read", "clipboard-write"], deviceScaleFactor: 2 });

  // covers: REQ-PAY-004
  test("the link holds the payslip after the #, the QR code holds the link, and a page opened from either is told nothing", async ({ page, context }) => {
    const site = await serveBuild();
    try {
      const problems = watchProblems(page);
      await page.goto(`${site.origin}/payslip`);
      await page.getByRole("button", { name: "Load a sample" }).click();

      // Offered, with the warning where it is made, and not made until asked for.
      await expect(page.getByText(LINK_WARNING)).toBeVisible();
      expect(await page.content()).not.toContain("#payslip=");
      await page.getByRole("button", { name: "Make a link" }).click();
      const link = await page.getByLabel("Payslip link", { exact: true }).inputValue();
      expect(link).toBe(`${site.origin}/payslip#payslip=${FRAGMENT_VALUE}`);
      expect(holdsAny(link.split("#")[0] ?? "")).toBe(false);

      // The QR code of that link, read from the pixels by a decoder that did not draw it.
      await page.getByRole("button", { name: "Show QR code" }).click();
      const qr = page.getByRole("img", { name: "QR code of the payslip link" });
      await expect(qr).toBeVisible();
      expect(decodeScreenshot(await qr.screenshot())).toBe(link);
      expect(problems()).toEqual([]);

      // Nothing of the payslip has gone to the server: making a link and a code is the page's own work.
      for (const piece of PIECES) expect(told(site.wire), piece.slice(0, 20)).not.toContain(piece);
      expect(site.wire.filter((w) => w.method !== "GET")).toEqual([]);

      // A page opened from the link, as a person would open it: the payslip is in the box, with what a link means.
      site.wire.length = 0;
      const opened = await context.newPage();
      await opened.goto(link);
      await expect(opened.getByLabel("Payslip", { exact: true })).toHaveValue(sampleText);
      await expect(opened.getByText(LINK_NOTICE)).toBeVisible();
      // The fragment is gone from the address bar before anything else, and nothing is checked until asked.
      expect(opened.url()).toBe(`${site.origin}/payslip`);
      await expect(opened.getByTestId("payslip-result")).toHaveCount(0);
      expect(site.wire.filter((w) => w.method === "POST")).toEqual([]);

      // What the server was told by opening it: the page and its files, with nothing of the payslip, not even in a header.
      for (const piece of PIECES) expect(told(site.wire), piece.slice(0, 20)).not.toContain(piece);
      expect(site.wire[0]?.url).toBe("/payslip");

      // Asked, it is checked: one request, with the payslip as its body, at an address that holds none of it.
      await opened.getByRole("button", { name: "Check payslip" }).click();
      await expect(opened.getByRole("heading", { level: 2, name: "Verified", exact: true })).toBeFocused();
      const posts = site.wire.filter((w) => w.method === "POST");
      expect(posts).toHaveLength(1);
      expect(posts[0]?.url).toBe("/api/v1/payslip");
      expect(posts[0]?.body).toBe(body);
      expect(holdsAny(JSON.stringify(posts[0]?.headers))).toBe(false);
      expect(site.wire.filter((w) => w !== posts[0] && told([w]).includes(sample.receiver))).toEqual([]);

      // Kept nowhere in either page.
      for (const p of [page, opened]) {
        const kept = await dumpBrowserState(p);
        for (const piece of PIECES) expect(kept).not.toContain(piece);
      }
      expect(opened.url()).toBe(`${site.origin}/payslip`);
    } finally {
      await site.close();
    }
  });

  test("a link that holds no payslip says so, loads nothing, and leaves the address bar bare too", async ({ page }) => {
    const site = await serveBuild();
    try {
      for (const hash of ["#payslip=%%%", "#payslip=", "#payslip=eyJ2ZXJzaW9uIjoxfQ", `#payslip=${FRAGMENT_VALUE.slice(0, 100)}`]) {
        // A full load each time: from "/payslip" to "/payslip#payslip=" is only a change of the fragment (which has its own test below).
        await page.goto("about:blank");
        await page.goto(`${site.origin}/payslip${hash}`);
        await expect(page.getByRole("alert")).toHaveText("This link does not hold a payslip this page can read. Nothing was loaded.");
        await expect(page.getByLabel("Payslip", { exact: true })).toHaveValue("");
        expect(page.url(), hash).toBe(`${site.origin}/payslip`);
      }
      expect(site.wire.filter((w) => w.method === "POST")).toEqual([]);
    } finally {
      await site.close();
    }
  });

  test("a link pasted into the address bar of the tab the page is open in (a change of the fragment alone) loads the same way", async ({ page }) => {
    const site = await serveBuild();
    try {
      await page.goto(`${site.origin}/payslip`);
      await expect(page.getByLabel("Payslip", { exact: true })).toHaveValue("");
      const loads = site.wire.length;
      // What the address bar does: the address changes by its fragment alone, so the page is not loaded again.
      await page.evaluate((value) => {
        location.hash = `payslip=${value}`;
      }, FRAGMENT_VALUE);
      await expect(page.getByLabel("Payslip", { exact: true })).toHaveValue(sampleText);
      await expect(page.getByText(LINK_NOTICE)).toBeVisible();
      await expect.poll(() => page.url()).toBe(`${site.origin}/payslip`);
      // Not one request for it, and the history has the bare entry only: going back does not bring the payslip back.
      expect(site.wire.slice(loads).filter((w) => w.method === "POST")).toEqual([]);
      for (const piece of PIECES) expect(told(site.wire), piece.slice(0, 20)).not.toContain(piece);
      expect(await page.evaluate(() => JSON.stringify(history.state))).not.toContain(sample.receiver);
    } finally {
      await site.close();
    }
  });

  test("an address that is not a payslip link is left as it is", async ({ page }) => {
    const site = await serveBuild();
    try {
      await page.goto(`${site.origin}/payslip#main`);
      await expect(page.getByRole("heading", { level: 1, name: "Check a payslip" })).toBeVisible();
      expect(page.url()).toBe(`${site.origin}/payslip#main`);
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByText(LINK_NOTICE)).toHaveCount(0);
    } finally {
      await site.close();
    }
  });

  test("Share hands the share sheet the link and one line, and copying it puts the link on the clipboard", async ({ page }) => {
    await withShare(page);
    await page.goto("/payslip");
    await page.getByRole("button", { name: "Load a sample" }).click();
    await page.getByRole("button", { name: "Share" }).click();
    const link = `${new URL(page.url()).origin}/payslip#payslip=${FRAGMENT_VALUE}`;
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared)).toEqual([{ text: "A Zcash payslip to check:", url: link }]);

    await page.getByRole("button", { name: "Make a link" }).click();
    await page.getByRole("button", { name: "Copy payslip link" }).click();
    await expect(page.getByText("Copied to clipboard")).toBeAttached();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
    // And the address bar of this page was never the payslip's.
    expect(page.url()).toBe(`${new URL(page.url()).origin}/payslip`);
  });
});

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`${viewport.name}, ${theme} theme`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 2 });

      test("the payslip page: with its link and QR code shown", async ({ page }) => {
        await useTheme(page, theme);
        const problems = watchProblems(page);
        await page.goto("/payslip");
        await page.getByRole("button", { name: "Load a sample" }).click();
        await page.getByRole("button", { name: "Make a link" }).click();
        await page.getByRole("button", { name: "Show QR code" }).click();
        const qr = page.getByRole("img", { name: "QR code of the payslip link" });
        await expect(qr).toBeVisible();
        // Dark on light in both themes, and as wide as the screen lets it be (up to 26rem): that is what a phone camera needs.
        await expect(qr.locator("rect")).toHaveCSS("fill", "rgb(255, 255, 255)");
        await expect(qr.locator("path")).toHaveCSS("fill", "rgb(0, 0, 0)");
        const modules = Number((await qr.getAttribute("viewBox"))?.split(" ")[2]);
        const width = (await qr.boundingBox())?.width ?? 0;
        if (viewport.width < 768) {
          // A phone: the whole width of the page.
          expect(width).toBeGreaterThanOrEqual(viewport.width - 40 - 2);
        } else {
          // From md up: four pixels to a module, exactly, so that every module is as wide as every other.
          expect(width).toBe(modules * 4);
          expect(width).toBeLessThanOrEqual(416);
        }
        const link = await page.getByLabel("Payslip link", { exact: true }).inputValue();
        expect(decodeScreenshot(await qr.screenshot())).toBe(link);

        expect(problems(), "console").toEqual([]);
        const overflow = await overflowReport(page);
        expect(overflow.wide, "elements wider than the viewport").toEqual([]);
        expect(overflow.page, "horizontal scroll").toBeLessThanOrEqual(0);
        expect(await axeViolations(page), "accessibility violations").toEqual([]);
      });

      test("the payslip page: opened from a link", async ({ page }) => {
        await useTheme(page, theme);
        const problems = watchProblems(page);
        await page.goto(`/payslip#payslip=${FRAGMENT_VALUE}`);
        await expect(page.getByLabel("Payslip", { exact: true })).toHaveValue(sampleText);
        await expect(page.getByText(LINK_NOTICE)).toBeVisible();
        expect(problems(), "console").toEqual([]);
        const overflow = await overflowReport(page);
        expect(overflow.wide, "elements wider than the viewport").toEqual([]);
        expect(overflow.page, "horizontal scroll").toBeLessThanOrEqual(0);
        expect(await axeViolations(page), "accessibility violations").toEqual([]);
      });

      test("the payslip page: a link that holds no payslip", async ({ page }) => {
        await useTheme(page, theme);
        const problems = watchProblems(page);
        await page.goto("/payslip#payslip=%%%");
        await expect(page.getByRole("alert")).toBeVisible();
        expect(problems(), "console").toEqual([]);
        const overflow = await overflowReport(page);
        expect(overflow.wide, "elements wider than the viewport").toEqual([]);
        expect(overflow.page, "horizontal scroll").toBeLessThanOrEqual(0);
        expect(await axeViolations(page), "accessibility violations").toEqual([]);
      });
    });
  }
}
