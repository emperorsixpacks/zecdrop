// Whether this page is the local operator's UI or a public, hosted receipt viewer.
//
// The operator binds only to loopback and answers only to its own loopback names
// (localhost, 127.0.0.1, [::1]), so the operator pages can work only when the
// page was opened from one of those. Anywhere else the page is a hosted copy, and
// its operator pages have nothing to talk to: they say so instead of failing.
// A build can also say so outright with VITE_PUBLIC_ONLY=true.

import { config } from "./config";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Whether `hostname` (as `location.hostname` reports it) is a loopback name. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** Pure form, for tests: public when the build says so or the host is not loopback. */
export function publicModeFor(hostname: string, publicOnly: boolean): boolean {
  return publicOnly || !isLoopbackHost(hostname);
}

/** Whether to behave as the public receipt viewer, for the page as it is now. */
export function isPublicMode(): boolean {
  return publicModeFor(window.location.hostname, config.publicOnly);
}

/** Where "Make a payout" leads (REQ-RUN-002). On the public site: the page that says how to run ZecDrop on your own computer.
 * On the operator's own page, which is ZecDrop running on this computer: its payouts. */
export function makeAPayoutPath(): string {
  return isPublicMode() ? "/start" : "/campaigns";
}

/** The operator prints a link to the site's root, with its token after the `#`. Opened on the operator's own page, that link
 * lands on the payouts, the operator's first screen, instead of the site's home page. Called before the token is taken out of
 * the address (api/operator/session.ts), so that it goes with the token's own history entry; it changes nothing anywhere else. */
export function landOnPayouts(
  location: Pick<Location, "hash" | "pathname">,
  history: Pick<History, "replaceState" | "state">,
  publicMode: boolean = isPublicMode(),
): void {
  if (publicMode || location.pathname !== "/" || !location.hash.startsWith("#token=")) return;
  history.replaceState(history.state, "", `/campaigns${location.hash}`);
}
