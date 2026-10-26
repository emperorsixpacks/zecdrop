import { UNSAFE_createBrowserHistory } from "react-router";

// A new page cross-fades in 180ms, where the browser can (the View Transitions API, `document.startViewTransition`), and changes as it
// always did where it cannot. The header capsule has a name of its own (index.css), so it stays put while the page around it fades.
//
// The app uses the declarative router, whose links cannot ask for a view transition (`viewTransition` is a data router's option), so
// this wraps the one place every link and every redirect goes through: the history's `push`. The browser takes the picture of the old
// page, then calls back; the new location is pushed inside that call, and the call is held until the router has put the new page on
// the screen (`pageCommitted`, from ViewTransitionGate), because the browser takes the picture of the new page when the call ends.
// Back and forward, and `replace` (a redirect, or a link to the page one is on), change the page as they always did.
//
// Nothing here moves by itself: a transition is always the answer to a person's navigation, and none runs under "reduce motion".

/** The longest the browser is kept waiting for the new page, so a page that never commits cannot freeze the screen. */
const HOLD_MS = 1000;

interface Transition {
  ready: Promise<unknown>;
  finished: Promise<unknown>;
  updateCallbackDone: Promise<unknown>;
}

type StartViewTransition = (update: () => Promise<void>) => Transition;

let settle: (() => void) | null = null;

/** Called by the router's gate once a new location is on the screen: lets the browser take the picture of the new page. */
export function pageCommitted(): void {
  settle?.();
}

/** Whether a page change may be a transition here: the browser has the API, and the person has not asked for less motion. */
export function canTransition(doc: Document = document, win: Window = window): boolean {
  if (typeof (doc as Document & { startViewTransition?: unknown }).startViewTransition !== "function") return false;
  return !win.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Runs `navigate` (a push of the new location) inside a view transition where there can be one, and plain where there cannot. */
export function withViewTransition(navigate: () => void, doc: Document = document, win: Window = window): void {
  if (!canTransition(doc, win)) {
    navigate();
    return;
  }
  const start = (doc as Document & { startViewTransition: StartViewTransition }).startViewTransition.bind(doc);
  const transition = start(
    () =>
      new Promise<void>((resolve) => {
        const timer = win.setTimeout(done, HOLD_MS);
        function done() {
          win.clearTimeout(timer);
          if (settle === done) settle = null;
          resolve();
        }
        settle = done;
        navigate();
      }),
  );
  // A transition the browser skips (another page was asked for first, or the tab was hidden) rejects these. Nothing is wrong.
  for (const promise of [transition.ready, transition.finished, transition.updateCallbackDone]) promise.catch(() => undefined);
}

/** The browser's history, with `push` made into a view transition where there can be one. */
export function createTransitionHistory(): ReturnType<typeof UNSAFE_createBrowserHistory> {
  const history = UNSAFE_createBrowserHistory({ v5Compat: true });
  const push = history.push.bind(history);
  history.push = (...args: Parameters<typeof push>) => {
    withViewTransition(() => {
      push(...args);
    });
  };
  return history;
}
