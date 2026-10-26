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
//
// Practice mode (src/lib/practice-mode.ts) has no operator and needs no link. While it lasts a fixed stand-in is the token
// every call carries, and the operator's own session, if the person had one, is kept as it was and is theirs again when
// practice mode ends: the real token is never the one the simulation sees.

import { create } from "zustand";

/** The shape the operator prints: exactly 64 lowercase hex characters. */
const TOKEN_FRAGMENT = /^#token=([0-9a-f]{64})$/u;
const FRAGMENT_PREFIX = "#token=";

/** Practice mode has no operator, so no token: this stands in for one. It is not a secret, it is never in an address, and it
 * goes nowhere, because the simulation that is given it is inside the page (src/lib/practice-mode.ts). */
export const PRACTICE_TOKEN = "practice";

/** The operator's token, if there is one. Never the stand-in. */
let token: string | null = null;
/** What the operator's session is. While practice mode lasts the screens are shown "ready", and this is what it was and
 * what it becomes if the operator's link is opened meanwhile. */
let status: SessionStatus = "no-token";
/** Practice mode stands in for the operator. */
let practising = false;

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

/** Say what the operator's session is now. The screens hear of it unless practice mode is standing in for the operator. */
function setStatus(next: SessionStatus): void {
  status = next;
  if (!practising) useSession.setState({ status: next });
}

/** The token for an API call, or null if there is none. */
export function getToken(): string | null {
  return practising ? PRACTICE_TOKEN : token;
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
    setStatus("rejected");
    return;
  }
  token = match[1];
  setStatus("ready");
}

/** Take a token from text the person pasted: the whole link from the terminal
 * (`...#token=<64 hex>`), or just the 64 hex characters. Returns whether one was
 * found. The pasted text itself is never kept; only the token, in memory. */
export function adoptTokenFromText(text: string): boolean {
  const fromLink = /#token=([0-9a-f]{64})(?![0-9a-f])/u.exec(text);
  const found = fromLink?.[1] ?? /^[0-9a-f]{64}$/u.exec(text.trim())?.[0];
  if (found === undefined) return false;
  token = found;
  setStatus("ready");
  return true;
}

/** Practice mode starts: the operator pages open without the link the operator prints, and every call carries the stand-in.
 * The operator's own session is not touched: its token stays where it is, and is what a call carries again once practice
 * mode ends. */
export function enterPracticeSession(): void {
  practising = true;
  useSession.setState({ status: "ready" });
}

/** Practice mode ends: the screens see the operator's session as it is now. That is what it was before, unless the
 * operator's link was opened meanwhile, and then it is that. */
export function leavePracticeSession(): void {
  if (!practising) return;
  practising = false;
  useSession.setState({ status });
}

/** The operator answered 401: forget the token. In practice mode a 401 is the simulation's, never the operator's, so the
 * operator's token is not what it refused. */
export function rejectToken(): void {
  if (practising) return;
  token = null;
  setStatus("rejected");
}

/** Forget everything. For tests, and for a future "disconnect". */
export function clearSession(): void {
  token = null;
  setStatus("no-token");
}
