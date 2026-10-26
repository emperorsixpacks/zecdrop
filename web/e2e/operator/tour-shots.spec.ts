import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { TOUR_LOOKS, TOUR_SHOTS, TOUR_WIDTH, type TourLook } from "../../src/features/home/tour-steps.js";
import { useTheme } from "../helpers.js";
import { operatorUrl } from "./env.js";
import { loadDemoCsv } from "./privacy.js";

// The pictures for the home page tour (src/features/home/tour-steps.ts): the operator's screens from a
// practice run on the mock chain, with the demo payouts, and the bundled real testnet receipt. Not
// part of the normal run: it does nothing unless TOUR_SHOTS_DIR names a folder, and it needs `cwebp`
// (libwebp: `brew install webp`, or `apt install webp`) to write the files.
//
//   ZECDROP_E2E_POLL_MS=2500 ZECDROP_E2E_CONFIRM_POLLS=2 \
//   TOUR_SHOTS_DIR=public/tour npx playwright test --project=operator tour-shots
//
// The slower operator is so the sending timeline stays on "Confirming 1" long enough to be taken. Run
// `npm run build` first: the operator serves web/dist. Each look (light, dark) is a run of its own,
// from an empty form to the audit page, so nothing is a copy of another. Every picture is exactly the
// size tour-steps.ts says (a picture of another size fails here, so the page never declares a wrong one),
// is written as a lossless WebP (text stays sharp, and it is smaller than the PNG), and is checked first
// for anything that must not be on a screen that is published: a 64-digit hex string (the operator's link
// token, a seed, a key), anything shaped like a viewing key, and any address that is not one of the
// public demo list's (or the real sample receipt's funding address).

const DIR = process.env["TOUR_SHOTS_DIR"];

test.skip(DIR === undefined, "set TOUR_SHOTS_DIR to take the tour's pictures");

const outputDir = (): string => {
  const dir = resolve(process.cwd(), DIR ?? "");
  mkdirSync(dir, { recursive: true });
  return dir;
};

// ---- what may be on a screen ------------------------------------------------------------

const demoAddresses = loadDemoCsv()
  .trim()
  .split("\n")
  .slice(1)
  .map((line) => line.split(",")[0] ?? "");

/** The funding address of the real sample receipt: public chain data, already on the site. */
function realFundingAddress(): string {
  const root = resolve(process.cwd(), "..", "fixtures", "testnet-ironwood-batch-8");
  const [dir] = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[0-9a-f]{64}$/u.test(e.name));
  const receipt = JSON.parse(readFileSync(join(root, dir?.name ?? "", "receipt.json"), "utf8")) as { funding_address: string };
  return receipt.funding_address;
}

const knownAddresses = [...demoAddresses, realFundingAddress()];

/** The part of the viewing-key markers the verifier refuses (crates/drop-verifier/src/query.rs), then bech32 text. */
const KEY_SHAPED = /\b(?:uview|uivk|ufvk|zxview|zviews|zivk)[a-z0-9]*1[a-z0-9]{10,}/iu;
const HEX_64 = /\b[0-9a-fA-F]{64}\b/u;
const ADDRESS_PREFIX = "(?:utest1|u1|ztestsapling1|zs1|t[123m])";
/** An address as the pages show it: shortened ("utest1…vxy8vp") or whole. */
const ADDRESS_SHAPED = new RegExp(`\\b${ADDRESS_PREFIX}[A-Za-z0-9]*…[A-Za-z0-9]+|\\b${ADDRESS_PREFIX}[A-Za-z0-9]{20,}`, "gu");

/** A shown address is fine if it is one of the known ones, or a shortened form of one ("head…tail"). */
function isKnownAddress(shown: string): boolean {
  if (knownAddresses.includes(shown)) return true;
  const [head, tail] = shown.split("…");
  return tail !== undefined && knownAddresses.some((address) => address.startsWith(head ?? "\0") && address.endsWith(tail));
}

/** What a person can read on the page now: refuse to go on if any of it must not be published. */
async function expectNothingSecret(page: Page, id: string): Promise<void> {
  const text = await page.evaluate(() => document.body.innerText);
  expect(HEX_64.test(text), `${id}: a 64-digit hex string is on the screen`).toBe(false);
  expect(KEY_SHAPED.test(text), `${id}: something shaped like a viewing key is on the screen`).toBe(false);
  const strangers = (text.match(ADDRESS_SHAPED) ?? []).filter((shown) => !isKnownAddress(shown));
  expect(strangers.length, `${id}: addresses that are not the demo list's: ${String(strangers.length)}`).toBe(0);
}

// ---- taking a picture -------------------------------------------------------------------

/** The size an image's own header gives (a PNG: the 4 bytes at 16 and at 20). */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function writeWebp(png: Buffer, file: string): void {
  const done = spawnSync("cwebp", ["-quiet", "-lossless", "-z", "9", "-o", file, "--", "-"], { input: png });
  if (done.error !== undefined || done.status !== 0) {
    throw new Error(`cwebp could not write ${file}. Is libwebp installed (brew install webp, or apt install webp)?\n${String(done.stderr)}`);
  }
}

/** One picture of the tour, from the top of the page. `viewport` takes the window as it is (for the sheet, which sits
 * over the window); otherwise the page is taken whole and cut to the height tour-steps.ts gives. */
async function shoot(page: Page, id: string, look: TourLook, options: { viewport?: boolean } = {}): Promise<void> {
  const shot = TOUR_SHOTS.find((s) => s.id === id);
  if (shot === undefined) throw new Error(`tour-steps.ts has no picture called ${id}`);
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
    // The pictures are of the operator's screens, shown on a page that has a screen frame and a paper grain of its own: leave both
    // out of them (a frame inside a frame is no help, and lossless WebP of a faint speckle is many times the size). Through the
    // CSSOM, which the operator's Content-Security-Policy allows, and not by a style element, which it refuses.
    document.documentElement.style.setProperty("--grain-opacity", "0");
    for (const frame of document.querySelectorAll<HTMLElement>(".screen-frame")) frame.style.display = "none";
  });
  // No row under the pointer, so none is tinted.
  await page.mouse.move(2, 2);
  await page.waitForTimeout(400);
  // Nothing half-way: the capsule's width follows the page's name, and a picture taken while it moves shows it cut. Every
  // animation that ends is waited for (one that never ends, a pulse, would never be done).
  await page.evaluate(async () => {
    const ending = document.getAnimations().filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)));
    await Promise.all(ending.map(async (a) => a.finished.catch(() => undefined)));
  });
  await expectNothingSecret(page, id);
  // A picture that fits in the window is taken from it. Taking the whole page resizes the window for a moment, and a picture
  // taken that way once drew the header capsule cut short although the page's own measure of it was right.
  const fits = shot.height <= (page.viewportSize()?.height ?? 0);
  const png =
    options.viewport === true
      ? await page.screenshot()
      : await page.screenshot({ fullPage: !fits, clip: { x: 0, y: 0, width: TOUR_WIDTH, height: shot.height } });
  expect(pngSize(png), `${id}: the picture is not the size tour-steps.ts says`).toEqual({ width: TOUR_WIDTH, height: shot.height });
  const file = join(outputDir(), `${id}-${look}.webp`);
  writeWebp(png, file);
  console.log(`TOUR ${id}-${look}.webp ${String(statSync(file).size)} bytes`);
}

/** The step the sending timeline is on, in its own words ("Confirming 1"), or "". */
const timelineStep = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const current = document.querySelector("ol[aria-label='Sending progress'] li[aria-current='step'] p");
    return (current?.firstChild?.textContent ?? "").trim();
  });

/** A full load: going from /x to /x#token=... is only a fragment change, which would keep the old page. */
async function load(page: Page, url: string): Promise<void> {
  await page.goto("about:blank");
  await page.goto(url);
}

for (const look of TOUR_LOOKS) {
  test.describe(`the tour's pictures, ${look}`, () => {
    test.use({ viewport: { width: TOUR_WIDTH, height: 900 } });

    test("from the empty form to the audit page, and the real receipt", async ({ page }) => {
      test.setTimeout(180_000);
      await useTheme(page, look);

      // 1. Add the payouts: an organisation's run, the demo list imported, named. (The tour walks the whole flow, the audit
      // included, which is the organisation view.)
      await load(page, operatorUrl("/new", { token: true }));
      await page.getByRole("heading", { level: 1, name: "Add the payouts" }).waitFor();
      await page.getByRole("radio", { name: "Organisation" }).click();
      await page.getByLabel("Name this payout run").fill("Autumn grants");
      await page.getByRole("button", { name: "or paste it" }).click();
      await page.getByLabel("Paste your list").fill(loadDemoCsv());
      await page.getByRole("button", { name: "Use this list" }).click();
      await page.getByTestId("payout-table").waitFor();
      await shoot(page, "add-payouts", look);

      // 2. Check: who sees what, and the privacy warnings (there are none for this list).
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("heading", { level: 1, name: "Check the payouts" }).waitFor();
      await page.getByText("No privacy warnings").first().waitFor();
      await shoot(page, "check-payouts", look);

      // 3. Fund: waiting, then funded (the practice chain records a pretend deposit).
      await page.getByRole("link", { name: "Looks right, continue" }).click();
      await page.getByRole("heading", { level: 1, name: "Fund and send" }).waitFor();
      await page.getByRole("button", { name: "Record mock deposit" }).waitFor();
      await shoot(page, "fund-waiting", look);
      await page.getByRole("button", { name: "Record mock deposit" }).click();
      await page.getByText(/in deposit/u).waitFor();
      await expect(page.getByRole("button", { name: "Send 8 payouts" })).toBeEnabled();
      await shoot(page, "fund-funded", look);

      // 4. Send: the confirmation sheet (taken as a window of its own height), then the timeline.
      await page.setViewportSize({ width: TOUR_WIDTH, height: TOUR_SHOTS.find((s) => s.id === "send-sheet")?.height ?? 640 });
      await page.getByRole("button", { name: "Send 8 payouts" }).click();
      const sheet = page.getByRole("dialog");
      await sheet.waitFor();
      await shoot(page, "send-sheet", look, { viewport: true });
      await page.setViewportSize({ width: TOUR_WIDTH, height: 900 });
      await sheet.getByRole("button", { name: "Send 8 payouts" }).click();
      await expect.poll(() => timelineStep(page), { timeout: 60_000, intervals: [25] }).toBe("Confirming 1");
      await shoot(page, "send-timeline", look);
      expect(await timelineStep(page), "the run moved on while the picture was taken: use a slower ZECDROP_E2E_POLL_MS").toBe("Confirming 1");

      // 6. The audit page, with what the audit checks opened.
      await load(page, operatorUrl("/audit", { token: true }));
      await page.getByRole("heading", { level: 1, name: "Audit" }).waitFor();
      await page.getByRole("button", { name: "What the audit checks" }).click();
      await page.getByText(/^For every batch: whether the number of outputs/u).waitFor();
      await shoot(page, "audit", look);

      // 5. The public receipt: the real testnet batch bundled with the page.
      await load(page, operatorUrl("/r/demo?demo=real"));
      await page.getByRole("heading", { level: 2, name: "Status" }).waitFor({ state: "attached" });
      await page.getByText("Settled").first().waitFor();
      await shoot(page, "receipt", look);
    });
  });
}
