// The operator's per-run bearer token, held in memory and nowhere else.
//
// The operator prints  http://127.0.0.1:8787/#token=<64 hex>  at startup. The
// token is in the URL FRAGMENT, which browsers never send to a server, so it
// stays out of server logs and Referer headers. This module:
//
//   1. reads it from `location.hash` on load,
//   2. removes it from the address bar at once (history.replaceState), so it is
//      not in the page URL, the history entry, a bookmark or a screenshot,
//   3. keeps it in a module variable. NOT localStorage, sessionStorage,
//      IndexedDB or a cookie, and not in any React or zustand state either.
//
// The cost is deliberate: reloading the page forgets the token, and the user
// opens the link from the terminal again. The token is new on every operator
// start anyway.

import { create } from "zustand";

/** The shape the operator prints: exactly 64 lowercase hex characters. */
const TOKEN_FRAGMENT = /^#token=([0-9a-f]{64})$/u;
const FRAGMENT_PREFIX = "#token=";

let token: string | null = null;

export type SessionStatus =
  /** No token has been given to this page. */
  | "no-token"
  | "ready"
  /** A token was given but is malformed, or the operator refused it (401). */
  | "rejected";

interface SessionState {
  status: SessionStatus;
}

/** Only the STATUS is observable state; the token itself never is. */
export const useSession = create<SessionState>(() => ({ status: "no-token" }));

/** The token for an API call, or null if there is none. */
export function getToken(): string | null {
  return token;
}

/** Read a `#token=...` fragment, strip it from the address bar, remember it.
 * Does nothing if the URL has no such fragment. Safe to call repeatedly. */
export function adoptTokenFromLocation(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState" | "state">,
): void {
  const hash = location.hash;
  if (!hash.startsWith(FRAGMENT_PREFIX)) return;

  // Remove it FIRST. Even a malformed token must not stay in the address bar.
  history.replaceState(history.state, "", location.pathname + location.search);

  const match = TOKEN_FRAGMENT.exec(hash);
  if (match?.[1] === undefined) {
    token = null;
    useSession.setState({ status: "rejected" });
    return;
  }
  token = match[1];
  useSession.setState({ status: "ready" });
}

/** Take a token from text the person pasted: the whole link from the terminal
 * (`...#token=<64 hex>`), or just the 64 hex characters. Returns whether one was
 * found. The pasted text itself is never kept; only the token, in memory. */
export function adoptTokenFromText(text: string): boolean {
  const fromLink = /#token=([0-9a-f]{64})(?![0-9a-f])/u.exec(text);
  const found = fromLink?.[1] ?? /^[0-9a-f]{64}$/u.exec(text.trim())?.[0];
  if (found === undefined) return false;
  token = found;
  useSession.setState({ status: "ready" });
  return true;
}

/** The operator answered 401: forget the token. */
export function rejectToken(): void {
  token = null;
  useSession.setState({ status: "rejected" });
}

/** Forget everything. For tests, and for a future "disconnect". */
export function clearSession(): void {
  token = null;
  useSession.setState({ status: "no-token" });
}
