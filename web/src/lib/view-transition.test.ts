// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canTransition, createTransitionHistory, pageCommitted, withViewTransition } from "./view-transition";

// A new page is a view transition where the browser can do one, and a plain page change everywhere else. jsdom has no
// `startViewTransition` and no `matchMedia`, so these tests give the module the pieces a browser has, and say what each does.

type Update = () => Promise<void>;

/** A browser's `startViewTransition`: it takes the picture of the old page, calls back, waits for the promise the call returns,
 * then takes the picture of the new page. Here it records the call and hands the callback to the test. */
function fakeBrowser(options: { reduce?: boolean; skipped?: boolean } = {}) {
  const calls: { update: Update }[] = [];
  const start = vi.fn((update: Update) => {
    calls.push({ update });
    const rejected = () => (options.skipped === true ? Promise.reject(new DOMException("skipped", "AbortError")) : Promise.resolve());
    return { ready: rejected(), finished: rejected(), updateCallbackDone: rejected() };
  });
  const matchMedia = vi.fn((query: string) => ({ matches: options.reduce === true && query === "(prefers-reduced-motion: reduce)" }));
  const doc = { startViewTransition: start } as unknown as Document;
  const win = { matchMedia, setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window) } as unknown as Window;
  return { doc, win, calls, start, matchMedia };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  pageCommitted();
  vi.useRealTimers();
  Reflect.deleteProperty(document, "startViewTransition");
  Reflect.deleteProperty(window, "matchMedia");
  window.history.replaceState(null, "", "/");
});

describe("whether a page change may be a transition", () => {
  it("is when the browser has the API and the person has not asked for less motion", () => {
    const { doc, win } = fakeBrowser();
    expect(canTransition(doc, win)).toBe(true);
  });

  it("is not where the browser has no such API (jsdom, an older browser)", () => {
    expect(canTransition(document, { matchMedia: () => ({ matches: false }) } as unknown as Window)).toBe(false);
  });

  it("is not under 'reduce motion', whatever the browser can do", () => {
    const { doc, win } = fakeBrowser({ reduce: true });
    expect(canTransition(doc, win)).toBe(false);
  });
});

describe("a page change", () => {
  it("happens at once, and asks the browser for nothing, where a transition cannot be", () => {
    const navigate = vi.fn();
    withViewTransition(navigate, document, { matchMedia: () => ({ matches: false }) } as unknown as Window);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("happens at once under 'reduce motion', and no transition is asked for", () => {
    const { doc, win, start } = fakeBrowser({ reduce: true });
    const navigate = vi.fn();
    withViewTransition(navigate, doc, win);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("is made inside the browser's callback, which the browser is kept waiting on until the new page is on the screen", async () => {
    const { doc, win, calls, start } = fakeBrowser();
    const navigate = vi.fn();
    withViewTransition(navigate, doc, win);
    // Not yet: the browser takes the picture of the old page first, and only then calls back.
    expect(start).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();

    let held = true;
    const update = (calls[0] as { update: Update }).update();
    void update.then(() => {
      held = false;
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(held, "the browser is let go before the page is committed").toBe(true);

    pageCommitted();
    await vi.advanceTimersByTimeAsync(0);
    expect(held, "the browser is kept waiting after the page is committed").toBe(false);
  });

  it("does not keep the browser waiting for ever on a page that never commits", async () => {
    const { doc, win, calls } = fakeBrowser();
    withViewTransition(vi.fn(), doc, win);
    let held = true;
    void (calls[0] as { update: Update }).update().then(() => {
      held = false;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(held).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(held).toBe(false);
  });

  it("leaves no rejection behind when the browser skips the transition (another page came first)", async () => {
    const { doc, win, calls } = fakeBrowser({ skipped: true });
    withViewTransition(vi.fn(), doc, win);
    void (calls[0] as { update: Update }).update();
    // An unhandled rejection fails the whole run, so reaching the end is the check.
    await vi.advanceTimersByTimeAsync(10);
    expect(true).toBe(true);
  });

  it("lets a second page change take over from a first that is still waiting", async () => {
    const { doc, win, calls } = fakeBrowser();
    withViewTransition(vi.fn(), doc, win);
    void (calls[0] as { update: Update }).update();
    const second = vi.fn();
    withViewTransition(second, doc, win);
    let held = true;
    void (calls[1] as { update: Update }).update().then(() => {
      held = false;
    });
    expect(second).toHaveBeenCalledTimes(1);
    pageCommitted();
    await vi.advanceTimersByTimeAsync(0);
    expect(held).toBe(false);
  });
});

describe("the history the router is given", () => {
  it("makes a push a view transition, run inside the browser's callback", async () => {
    const { calls, start, matchMedia } = fakeBrowser();
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });
    const history = createTransitionHistory();
    history.push("/get-paid");
    expect(calls).toHaveLength(1);
    expect(window.location.pathname, "the address changed before the browser took the old picture").toBe("/");
    const update = (calls[0] as { update: Update }).update();
    expect(window.location.pathname).toBe("/get-paid");
    pageCommitted();
    await update;
  });

  it("does not make a replace one (a redirect, or a link to the page one is on)", () => {
    const { start, matchMedia } = fakeBrowser();
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });
    const history = createTransitionHistory();
    history.replace("/privacy");
    expect(start).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/privacy");
  });

  it("is a plain push where there are no view transitions", () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false }) });
    const history = createTransitionHistory();
    history.push("/payslip");
    expect(window.location.pathname).toBe("/payslip");
  });
});
