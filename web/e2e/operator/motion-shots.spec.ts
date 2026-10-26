import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { useTheme, VIEWPORTS } from "../helpers.js";
import { operatorToken, operatorUrl } from "./env.js";
import { loadDemoCsv } from "./privacy.js";

// Proof that Lively moves on the LIVE path: the real operator binary on the mock chain, a real
// browser, the real events. Not part of the normal run: it does nothing unless UI_SHOTS_DIR names a
// folder, and it wants a slower operator so a run can be watched:
//
//   ZECDROP_E2E_POLL_MS=1400 ZECDROP_E2E_CONFIRM_POLLS=2 \
//   UI_SHOTS_DIR=/some/folder UI_SHOTS_STAGE=b2 npx playwright test --project=operator motion-shots
//
// Three kinds of frame, named by how they were taken:
//   live-*   the page was looked at as the operator's events arrived, and a frame was taken the first
//            time each step of the sending timeline showed. Nothing is slowed down or replayed.
//   seek-*   an animation that the page started on a real event (the lens wipe, the stamp and its
//            confetti) is stopped and moved to a stated fraction of its own length, so the five
//            frames are exact, not a matter of luck with the clock.
//   count-*  the number's own clock (requestAnimationFrame and the time) is stepped by Playwright's
//            clock, so each frame is the number at a stated millisecond of its 700 ms count.

const DIR = process.env["UI_SHOTS_DIR"];
const STAGE = process.env["UI_SHOTS_STAGE"] ?? "b2";

test.skip(DIR === undefined, "set UI_SHOTS_DIR to take screenshots");

const shotsDir = (): string => {
  const dir = join(DIR ?? "", STAGE);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");

/** The id of the campaign the live run settled, per viewport, for the stepped frames after it. */
const finished = new Map<string, string>();

interface Seen {
  at: number;
  label: string;
}

declare global {
  interface Window {
    __seen?: Seen[];
    __stamp?: boolean;
  }
}

/** Start a recorder in the page: what the sending timeline said, and when, from the page's own clock;
 * and the moment the stamp arrives, stop its animations (and the confetti's) where they are. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const t0 = performance.now();
    const seen: Seen[] = [];
    window.__seen = seen;
    const read = (): string => {
      if (document.querySelector(".stamp") !== null) return "Sealed";
      const current = document.querySelector("ol[aria-label='Sending progress'] li[aria-current='step'] p");
      return (current?.firstChild?.textContent ?? "").trim();
    };
    let last = "";
    const look = () => {
      const label = read();
      if (label !== "" && label !== last) {
        last = label;
        seen.push({ at: Math.round(performance.now() - t0), label });
      }
      if (!window.__stamp && document.querySelector(".stamp") !== null) {
        window.__stamp = true;
        for (const animation of document.getAnimations()) {
          const target = (animation.effect as KeyframeEffect | null)?.target;
          if (target instanceof Element && target.closest(".stamp, .confetti") !== null) animation.pause();
        }
      }
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    look();
  });
}

/** Stop every animation that ends, and put each at `fraction` of the longest one's length. */
async function seek(page: Page, fraction: number, within?: string): Promise<number> {
  return await page.evaluate(
    ([f, selector]) => {
      const finite = document.getAnimations().filter((a) => {
        const end = a.effect?.getComputedTiming().endTime;
        if (typeof end !== "number" || !Number.isFinite(end)) return false;
        const target = (a.effect as KeyframeEffect | null)?.target;
        return selector === undefined || selector === null || (target instanceof Element && target.closest(selector) !== null);
      });
      const longest = Math.max(0, ...finite.map((a) => Number(a.effect?.getComputedTiming().endTime ?? 0)));
      for (const a of finite) {
        a.pause();
        a.currentTime = Math.min(f * longest, Number(a.effect?.getComputedTiming().endTime ?? 0));
      }
      return Math.round(longest);
    },
    [fraction, within ?? null] as const,
  );
}

async function toTheCheck(page: Page, options: { perBatch?: string } = {}): Promise<void> {
  await page.goto("about:blank");
  await page.goto(operatorUrl("/new", { token: true }));
  await page.getByRole("heading", { level: 1, name: "Add the payouts" }).waitFor();
  await page.getByLabel("Name this payout run").fill("Motion proof");
  await page.getByRole("button", { name: "or paste it" }).click();
  await page.getByLabel("Paste your list").fill(loadDemoCsv());
  await page.getByRole("button", { name: "Use this list" }).click();
  await page.getByTestId("payout-table").waitFor();
  if (options.perBatch !== undefined) {
    await page.getByRole("button", { name: "Options" }).click();
    await page.getByLabel("Payouts per batch").fill(options.perBatch);
  }
}

for (const viewport of VIEWPORTS) {
  const w = String(viewport.width);

  test.describe(`${w} dark, live path`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: "no-preference" });

    test("the real flow: each step of the sending timeline, then the stamp", async ({ page }) => {
      test.setTimeout(180_000);
      await useTheme(page, "dark");
      await toTheCheck(page, { perBatch: "4" });
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("heading", { level: 1, name: "Check the payouts" }).waitFor();
      await page.getByRole("link", { name: "Looks right, continue" }).click();
      await page.getByRole("heading", { level: 1, name: "Fund and send" }).waitFor();
      await page.getByRole("button", { name: "Record mock deposit" }).click();
      await page.getByText(/in deposit/u).waitFor();
      await page.getByRole("button", { name: /^Send 8 payouts$/u }).click();
      const sheet = page.getByRole("dialog");
      await sheet.waitFor();
      await record(page);

      await sheet.getByRole("button", { name: /^Send 8 payouts$/u }).click();

      // Look at the page as fast as it can be asked; take a frame the first time each step shows.
      const taken: { n: number; label: string; wallMs: number }[] = [];
      const started = Date.now();
      let last = "";
      let sealedAt = 0;
      while (Date.now() - started < 120_000) {
        const label = await page.evaluate(() => window.__seen?.at(-1)?.label ?? "");
        if (label !== "" && label !== last) {
          last = label;
          const n = taken.length + 1;
          // The stamp's frames are taken separately, exactly; this one is its finished state.
          if (label === "Sealed") {
            sealedAt = Date.now();
            if (viewport.width >= 1000) {
              // The stamp and its confetti began on the real "settled" event; they are held where they are and
              // moved to five stated fractions of their own length.
              await page.locator(".stamp").scrollIntoViewIfNeeded();
              await page.evaluate(() => {
                window.scrollBy(0, -160);
              });
              const length = await seek(page, 0, ".stamp, .confetti");
              console.log(`STAMP: the longest of the stamp's and the confetti's animations is ${String(length)} ms`);
              expect(length, "the settling started a real animation").toBeGreaterThan(300);
              for (const [i, fraction] of [0, 0.25, 0.5, 0.75, 1].entries()) {
                await seek(page, fraction, ".stamp, .confetti");
                await page.waitForTimeout(60);
                await page.screenshot({
                  path: join(shotsDir(), `seek-stamp-confetti-${String(i + 1)}-of-5-${String(Math.round(fraction * 100))}pc-${w}-dark.png`),
                });
              }
            }
            await page.evaluate(() => {
              for (const animation of document.getAnimations()) {
                const target = (animation.effect as KeyframeEffect | null)?.target;
                if (target instanceof Element && target.closest(".stamp, .confetti") !== null) animation.finish();
              }
            });
          }
          // On a phone the timeline is below the first screen: take the whole page.
          await page.screenshot({ path: join(shotsDir(), `live-${String(n)}-${slug(label)}-${w}-dark.png`), fullPage: viewport.width < 1000 });
          taken.push({ n, label, wallMs: Date.now() - started });
          if (label === "Sealed") break;
        }
        await page.waitForTimeout(25);
      }
      expect(last, "the run settled on screen").toBe("Sealed");
      expect(sealedAt).toBeGreaterThan(0);

      // What the page itself saw, and when (its own clock, from the click): proof the steps were not skipped.
      const seen = await page.evaluate(() => window.__seen ?? []);
      writeFileSync(join(shotsDir(), `live-steps-${w}-dark.json`), `${JSON.stringify({ seenByThePage: seen, framesTaken: taken }, null, 2)}\n`);
      console.log(`LIVE ${w}: page saw ${seen.map((s) => `${s.label}@${String(s.at)}ms`).join(" > ")}`);
      expect(seen.map((s) => s.label).at(-1)).toBe("Sealed");
      finished.set(w, /\/campaign\/(c-[0-9a-f]{12})$/u.exec(page.url())?.[1] ?? "");
    });
  });
}

test.describe("1280 dark, one animation at a time", () => {
  test.use({ viewport: { width: 1280, height: 900 }, reducedMotion: "no-preference" });

  test("the lens wipe, five points through it", async ({ page }) => {
    test.setTimeout(120_000);
    await useTheme(page, "dark");
    await toTheCheck(page);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { level: 1, name: "Check the payouts" }).waitFor();
    await page.waitForTimeout(1500); // let the page's own entrance finish first
    const lens = page.getByRole("radiogroup").first();
    await lens.scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      window.scrollBy(0, -140);
    });
    // Public to Auditor: every bar lifts, one row after another.
    await page.getByRole("radio", { name: "Auditor" }).click();
    const length = await seek(page, 0);
    console.log(`LENS: the longest animation after the click is ${String(length)} ms`);
    expect(length, "the click started a real animation").toBeGreaterThan(300);
    for (const [i, fraction] of [0, 0.25, 0.5, 0.75, 1].entries()) {
      await seek(page, fraction);
      await page.waitForTimeout(60);
      await page.screenshot({ path: join(shotsDir(), `seek-lens-wipe-${String(i + 1)}-of-5-${String(Math.round(fraction * 100))}pc-1280-dark.png`) });
    }
  });

  test("a number counting up, five points through it", async ({ page }) => {
    test.setTimeout(120_000);
    await useTheme(page, "dark");
    await page.clock.install();
    await toTheCheck(page);
    // From here the page's clock stands still until Playwright moves it.
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + 1000);
    await page.getByRole("button", { name: "Continue" }).click({ force: true });
    await page.getByRole("heading", { level: 1, name: "Check the payouts" }).waitFor();
    // 700 ms count: 16 ms in, then a quarter, a half, three quarters and the end.
    let elapsed = 0;
    for (const [i, at] of [16, 175, 350, 525, 760].entries()) {
      await page.clock.runFor(at - elapsed);
      elapsed = at;
      const text = await page.getByTestId("payout-summary").innerText();
      console.log(`COUNT ${String(at)} ms: ${text.replace(/\s+/gu, " ").slice(0, 60)}`);
      await page.screenshot({ path: join(shotsDir(), `count-up-${String(i + 1)}-of-5-${String(at)}ms-1280-dark.png`) });
    }
    await expect(page.getByTestId("payout-summary")).toContainText("people");
  });
});

for (const viewport of VIEWPORTS) {
  const w = String(viewport.width);
  test.describe(`${w} dark, stepped`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: "no-preference" });

    // The mock chain climbs from the first confirmation to the last in a few milliseconds (its Confirmed events
    // do not wait for a block), so the live run above cannot show "Confirming 2" or "Confirming 3". On a real
    // chain they are a block apart. These frames take the real campaign the live run just settled, as the
    // operator itself reported it, and change only the state of its batches to each of the states the real
    // engine records on the way (planned, built, broadcast, confirmed with 1 and with 2 confirmations).
    test("the same page at each state the engine records on the way", async ({ page }) => {
      test.setTimeout(120_000);
      test.skip(!finished.has(w), "needs the live run before it, in the same invocation");
      const id = finished.get(w) ?? "";
      await useTheme(page, "dark");
      const real = (await (
        await page.request.get(operatorUrl(`/api/campaigns/${id}`), { headers: { Authorization: `Bearer ${operatorToken()}` } })
      ).json()) as Record<string, unknown> & { batches: Record<string, unknown>[] };
      let current: Record<string, unknown> = real;
      await page.route(new RegExp(`/api/campaigns/${id}$`, "u"), (route) => route.fulfill({ json: current }));
      await page.route(new RegExp(`/api/campaigns/${id}/events$`, "u"), (route) => route.fulfill({ contentType: "text/event-stream", body: "" }));

      const states: { label: string; state: string; confirmations: number }[] = [
        { label: "proving", state: "planned", confirmations: 0 },
        { label: "sending", state: "built", confirmations: 0 },
        { label: "confirming-1", state: "broadcast", confirmations: 0 },
        { label: "confirming-2", state: "confirmed", confirmations: 1 },
        { label: "confirming-3", state: "confirmed", confirmations: 2 },
      ];
      for (const [i, step] of states.entries()) {
        current = {
          ...real,
          run: { state: "running" },
          phase: { phase: "sending", done: 0, total: real.batches.length },
          phase_label: `Sending: 0 of ${String(real.batches.length)} batches confirmed`,
          batches: real.batches.map((b) => ({ ...b, state: step.state, confirmations: step.confirmations, txid: step.state === "planned" ? null : b["txid"] })),
        };
        await page.goto("about:blank");
        await page.goto(operatorUrl(`/campaign/${id}`, { token: true }));
        await page.getByRole("heading", { name: "Sending the payouts" }).waitFor();
        await expect(page.locator("ol[aria-label='Sending progress'] li[aria-current='step']")).toContainText(
          step.label === "proving" ? "Proving" : step.label === "sending" ? "Sending" : `Confirming ${step.label.slice(-1)}`,
        );
        await page.waitForTimeout(1400);
        await page.screenshot({ path: join(shotsDir(), `stepped-${String(i + 1)}-${step.label}-${w}-dark.png`), fullPage: viewport.width < 1000 });
      }
    });
  });
}
